// This script refuses remote endpoints and any non-disposable database container.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const db=process.env.TEXTOS_TEST_DB_CONTAINER,url=process.env.TEXTOS_TEST_REST_URL;
assert.match(db??'',/^textos-cleanup-[0-9]+-db$/);assert.match(url??'',/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
const docker=(...args)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const sql=s=>docker('exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-Atc',s);
const literal=v=>`convert_from(decode('${Buffer.from(JSON.stringify(v)).toString('hex')}','hex'),'UTF8')::jsonb`;
let count=0;const check=async(name,fn)=>{await fn();console.log(`✓ ${++count} ${name}`)};
for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
const director=sql("select public.textos_bootstrap_local('demo')"),realDirector=sql("select public.textos_bootstrap_local('real')");
async function rpc(action,payload={},code=director,dataset='demo'){const r=await fetch(`${url}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:dataset})});return{status:r.status,body:await r.json()};}
async function ok(action,payload={},code=director,dataset='demo'){const r=await rpc(action,payload,code,dataset);assert.equal(r.status,200,JSON.stringify(r));return r.body;}
async function reject(action,payload,status=400,code=director,dataset='demo'){const r=await rpc(action,payload,code,dataset);assert.equal(r.status,status,JSON.stringify(r));}
const state=async()=> (await ok('snapshot')).state;
const base=JSON.parse(sql('select public.textos_empty_state()'));
base.settings.title='Jornada de pruebas conservada';base.settings.rules.presentationSeconds=900;base.settings.rules.lockedAt='2026-11-04T12:00:00Z';
base.publishers=[1,2,3].map(n=>({id:`clean-p${n}`,version:1,name:`Editorial ${n}`,samplesReceived:false,sampleNote:''}));
base.teachers=['MAT','COM'].map((area,i)=>({id:`clean-t${i+1}`,version:1,name:`Docente ${area}`,area,categories:['P1'],attended:true,attendanceEvidence:''}));
base.presentationQuestions=base.publishers.map((p,i)=>({id:`clean-q${i+1}`,version:1,publisherId:p.id,representativeName:'Representante de prueba',area:'MAT',question:'¿Cómo responde la propuesta a esta situación de aprendizaje?',answer:'Explica los recursos de la propuesta y una solución concreta.',status:'answered',askedAt:'2026-11-04T12:00:00Z',answeredAt:'2026-11-04T12:02:00Z',updatedAt:'2026-11-04T12:02:00Z'}));
base.presentationEvaluations=base.teachers.flatMap(t=>base.publishers.map((p,i)=>({id:`clean-e-${t.id}-${i+1}`,version:1,publisherId:p.id,teacherId:t.id,area:t.area,block:'P1',scaleMax:4,rubricVersion:2,responseScore:4-i,questionVersion:1,scores:Array(10).fill(4-i),notes:Array(10).fill('Observación de prueba'),generalObservation:'',physicalText:'',status:'closed',closedAt:'2026-11-04T12:12:00Z',updatedAt:'2026-11-04T12:12:00Z',rulesVersion:1})));
base.presentationDraw={id:'clean-draw',version:1,publishers:base.publishers.map(({id,name})=>({id,name})),completedPublisherIds:base.publishers.map(p=>p.id),createdAt:'2026-11-04T12:00:00Z',createdBy:'Subdirección'};
base.turn={publisherId:'clean-p3',status:'finished',startedAt:'2026-11-04T12:00:00Z',pausedAt:'2026-11-04T12:15:00Z',pausedMilliseconds:0};
let teacher,poll,batch;
async function seed(withPoll=false,dataset='demo'){
 sql(`delete from public.textos_history where dataset='${dataset}';delete from public.textos_paper_tokens where dataset='${dataset}';delete from public.textos_ballots where dataset='${dataset}';delete from public.textos_aggregates where dataset='${dataset}';delete from public.textos_access where dataset='${dataset}' and role='teacher';update public.textos_datasets set state=${literal(base)} where id='${dataset}';select public.textos_validate_state(state) from public.textos_datasets where id='${dataset}'`);
 const code=dataset==='demo'?director:realDirector;
 teacher=(await ok('access_create',{role:'teacher',teacherId:'clean-t1'},code,dataset)).code;
 if(withPoll){const rank=await ok('presentation_ranking_generate',{expectedVersion:0},code,dataset);poll=await ok('paper_poll_create',{block:'P1',areas:['MAT','COM'],rankingId:rank.id,expectedRankingVersion:rank.version},code,dataset);batch=await ok('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,count:3},code,dataset);poll=batch.poll;}
}
async function preview(scope,ids=[]){return ok('data_delete_preview',{scope,ids});}
async function apply(scope,ids=[]){const p=await preview(scope,ids);return ok('data_delete_apply',{scope,ids,expectedVersion:p.stateVersion,confirmation:scope==='all'?'ELIMINAR TODO':'ELIMINAR'});}
await check('solo Subdirección puede previsualizar o borrar; docentes no amplían sus permisos',async()=>{
 await seed();await reject('data_delete_preview',{scope:'all'},401,null);await reject('data_delete_apply',{scope:'all'},403,teacher);
 const secretary=(await ok('access_create',{role:'secretary',name:'Mesa de prueba'})).code;await reject('data_delete_preview',{scope:'all'},403,secretary);
});
await check('la vista previa no cambia datos, versiones, historial, accesos ni códigos',async()=>{
 await seed(true);const frozen=sql("select jsonb_build_object('d',(select jsonb_agg(to_jsonb(x)) from public.textos_datasets x),'a',(select jsonb_agg(to_jsonb(x)) from public.textos_access x),'h',(select jsonb_agg(to_jsonb(x)) from public.textos_history x),'p',(select jsonb_agg(to_jsonb(x)) from public.textos_paper_tokens x))");
 const p=await preview('all');assert.equal(p.counts.teachers,2);assert.equal(p.counts.paperTokens,3);assert.equal(p.counts.presentationEvaluations,6);assert.equal(p.requiresFullConfirmation,true);
 assert.equal(sql("select jsonb_build_object('d',(select jsonb_agg(to_jsonb(x)) from public.textos_datasets x),'a',(select jsonb_agg(to_jsonb(x)) from public.textos_access x),'h',(select jsonb_agg(to_jsonb(x)) from public.textos_history x),'p',(select jsonb_agg(to_jsonb(x)) from public.textos_paper_tokens x))"),frozen);
});
await check('CAS y confirmación impiden borrar desde una previsualización antigua o incompleta',async()=>{
 await seed();const p=await preview('teacher',['clean-t1']);await reject('data_delete_apply',{scope:'teacher',ids:['clean-t1'],expectedVersion:p.stateVersion,confirmation:'NO'});
 await ok('publisher_save',{publisher:{...(await state()).publishers[0],contact:'Cambio paralelo'}});
 await reject('data_delete_apply',{scope:'teacher',ids:['clean-t1'],expectedVersion:p.stateVersion,confirmation:'ELIMINAR'},409);assert.equal((await state()).teachers.length,2);
 await reject('data_delete_preview',{scope:'teacher',ids:['clean-t1','clean-t1']});await reject('data_delete_preview',{scope:'teacher',ids:['unknown']},409);
});
await check('borrar un docente quita sus fichas, revoca su acceso y elimina resultados dependientes',async()=>{
 await seed(true);sql(`insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values('demo','restore','demo','Subdirección','Copia anterior',${literal(base)})`);
 const p=await preview('teacher',['clean-t1']);assert.equal(p.counts.presentationEvaluations,3);assert.equal(p.counts.paperPolls,1);assert(p.counts.history>=1);
 await apply('teacher',['clean-t1']);const s=await state();assert.equal(s.teachers.length,1);assert.equal(s.presentationEvaluations.length,3);assert.equal(s.presentationQuestions.length,3);assert.equal(s.paperPolls.length,0);assert(!s.presentationRanking);assert.equal(s.publishers.length,3);await reject('snapshot',{},401,teacher);
 assert.equal(sql("select count(*) from public.textos_history where dataset='demo' and public.textos_cleanup_mentions(previous,'[\"clean-t1\"]')"),'0');
});
await check('borrar una ficha cerrada no borra al docente y una pestaña antigua no la recrea',async()=>{
 await seed();const old=base.presentationEvaluations[0];await apply('presentationEvaluation',[old.id]);const s=await state();assert.equal(s.teachers.length,2);assert.equal(s.presentationEvaluations.length,5);
 await reject('presentation_save',{publisherId:old.publisherId,area:old.area,block:old.block,scaleMax:4,rubricVersion:2,scores:old.scores,responseScore:old.responseScore,questionVersion:1,expectedVersion:old.version},409,teacher);
});
await check('borrar una confirmación conserva I11, fichas cerradas, sorteo, ranking y votos',async()=>{
 await seed(true);const before=await state();const p=await preview('question',['clean-q1']);assert.equal(p.counts.responseScores,0);assert.equal(p.counts.paperPolls,0);assert.equal(p.counts.presentationDraw,0);assert.equal(p.counts.presentationRanking,0);
 await apply('question',['clean-q1']);const s=await state();assert.equal(s.presentationQuestions.length,2);
 for(const key of ['presentationEvaluations','presentationDraw','presentationRanking','turn','paperPolls'])assert.deepEqual(s[key],before[key],key);
 const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.closed,3);assert.equal(summary.pending,0);
});
await check('borrar una editorial elimina preguntas/fichas propias y mantiene a los demás docentes',async()=>{
 await seed(true);await apply('publisher',['clean-p1']);const s=await state();assert.equal(s.publishers.length,2);assert.equal(s.teachers.length,2);assert.equal(s.presentationEvaluations.length,4);assert.equal(s.presentationQuestions.length,2);assert(!s.presentationDraw);assert(!s.presentationRanking);assert.equal(s.paperPolls.length,0);
 assert(!JSON.stringify(s).includes('clean-p1'));assert.equal(sql(`select count(*) from public.textos_paper_tokens where poll_id='${poll.id}'`),'0');
});
await check('borrar solo una votación elimina sus códigos y no altera fichas ni el ranking',async()=>{
 await seed(true);await ok('paper_scan_cast',{pollId:poll.id,code:batch.codes[0],choices:{MAT:'clean-p1',COM:null}});await apply('paperPoll',[poll.id]);const s=await state();assert.equal(s.paperPolls.length,0);assert.equal(s.presentationEvaluations.length,6);assert(s.presentationRanking);assert.equal(sql(`select count(*) from public.textos_paper_tokens where poll_id='${poll.id}'`),'0');
 await reject('paper_scan_cast',{pollId:poll.id,code:batch.codes[0],choices:{MAT:'clean-p1',COM:null}},400);
});
await check('reiniciar el sorteo conserva fichas y ranking puede eliminarse por separado',async()=>{
 await seed(true);await apply('ranking');assert(!(await state()).presentationRanking);assert((await state()).presentationDraw);await apply('draw');const s=await state();assert.equal(s.presentationEvaluations.length,6);assert.equal(s.turn.status,'ready');assert(!s.presentationDraw);
});
async function catalogSeed(){
 await seed();const s=structuredClone(base);
 s.series=[{id:'clean-series1',version:1,publisherId:'clean-p1',name:'Serie uno'},{id:'clean-series2',version:1,publisherId:'clean-p2',name:'Serie dos'}];
 s.offers=[{id:'clean-offer1',version:1,seriesId:'clean-series1',area:'MAT',block:'P1',edition:'2027',status:'offered',withdrawalReason:''},{id:'clean-offer2',version:1,seriesId:'clean-series1',area:'COM',block:'P1',edition:'2027',status:'offered',withdrawalReason:''},{id:'clean-offer3',version:1,seriesId:'clean-series2',area:'MAT',block:'P1',edition:'2027',status:'offered',withdrawalReason:''}];
 const book=JSON.parse(sql('select public.textos_blank_book()'));
 s.books=[{...book,id:'clean-book1',version:1,offerId:'clean-offer1',code:'BOOK1',gradeId:'PRI1',title:'Libro uno',edition:'2027'},{...book,id:'clean-book2',version:1,offerId:'clean-offer3',code:'BOOK2',gradeId:'PRI1',title:'Libro dos',edition:'2027',supersedesId:'clean-book1'}];
 s.reviews=[{id:'clean-review',version:1,categoryId:'MAT-P1',offerIds:['clean-offer1','clean-offer3'],unitReference:'Unidad 1',reason:'Revisión adicional de prueba'}];
 s.assignments=[{id:'clean-asn1',version:1,bookId:'clean-book1',teacherId:'clean-t1',kind:'initial'},{id:'clean-asn2',version:1,bookId:'clean-book2',teacherId:'clean-t1',kind:'initial'},{id:'clean-asn3',version:1,bookId:'clean-book2',teacherId:'clean-t1',kind:'additional',reviewId:'clean-review'}];
 s.evaluations=s.assignments.map((a,i)=>({id:'clean-legacy-e'+i,version:1,assignmentId:a.id,bookId:a.bookId,teacherId:a.teacherId,bookVersion:1,rulesVersion:1,scores:Array(10).fill(null),evidence:Array(10).fill(''),notes:Array(10).fill(''),objection:false,objectionDetail:'',status:'draft',closedAt:null,updatedAt:'2026-11-04T12:00:00Z'}));
 s.shortlists=[{id:'clean-sl',version:1,categoryId:'MAT-P1',gradeIds:['PRI1'],offerIds:['clean-offer1','clean-offer3'],status:'draft',scope:'grade',statement:'',folio:'',reason:'',directorApproved:false,article113:false,publishedAt:null,rulesVersion:1,snapshot:{publishers:s.publishers,teachers:s.teachers,books:s.books}}];
 s.sections=[{id:'clean-section',version:1,label:'A',sourceGrade:'Origen de prueba',gradeId:'PRI1',representative:'',replacement:false,accredited:false,accreditationEvidence:''}];
 const r={version:1,gradeId:'PRI1',number:1,areas:['MAT'],mode:'paper',status:'closed',shortlistIds:{MAT:'clean-sl'},options:{MAT:['clean-offer1','clean-offer3']},physicalReviewConfirmed:true,minimumRequired:1,delivered:2,deposited:2,counts:{MAT:{options:{'clean-offer1':1,'clean-offer3':1},blank:0,invalid:0}},results:{MAT:{state:'tie',winnerId:null,tiedIds:['clean-offer1','clean-offer3']}},parentId:null,openedAt:'2026-11-04T12:00:00Z',closedAt:'2026-11-04T12:10:00Z',reconciliationReason:''};
 s.rounds=[{...r,id:'clean-round1'},{...r,id:'clean-round2',number:2,status:'draft',parentId:'clean-round1',delivered:1,deposited:0,counts:{MAT:{options:{'clean-offer1':0,'clean-offer3':0},blank:0,invalid:0}},results:{},openedAt:null,closedAt:null}];
 s.deliveries=s.rounds.map(r=>({roundId:r.id,sectionId:'clean-section',delivered:true}));
 s.incidents=[{id:'clean-incident',version:1,scope:'book',referenceId:'clean-book1',description:'Incidencia del libro uno',resolution:'',folio:'',actor:'Subdirección',createdAt:'2026-11-04T12:00:00Z'}];
 sql(`update public.textos_datasets set state=${literal(s)} where id='demo';select public.textos_validate_state(state) from public.textos_datasets where id='demo'`);
 for(const r of s.rounds)sql(`insert into public.textos_ballots(code_hash,dataset,round_id,consumed)values(public.textos_hash('${r.id}-anonymous-token'),'demo','${r.id}',true);insert into public.textos_aggregates(dataset,round_id,area,option_id,votes)values('demo','${r.id}','MAT','clean-offer1',1)`);
 return s;
}
await check('serie y oferta eliminan libros, revisiones, asignaciones adicionales y toda la segunda vuelta',async()=>{
 for(const [scope,id] of [['series','clean-series1'],['offer','clean-offer1']]){
  await catalogSeed();const p=await preview(scope,[id]);assert.equal(p.counts.rounds,2);assert.equal(p.counts.ballots,2);assert.equal(p.counts.reviews,1);await apply(scope,[id]);const s=await state();assert.equal(s.books.length,1);assert.equal(s.books[0].id,'clean-book2');assert(!s.books[0].supersedesId);assert.equal(s.assignments.length,1);assert.equal(s.evaluations.length,1);assert.equal(s.reviews.length,0);assert.equal(s.rounds.length,0);assert.equal(s.deliveries.length,0);assert.equal(s.incidents.length,0);assert.equal(s.presentationEvaluations.length,6);assert.equal(s.teachers.length,2);assert.equal(sql("select count(*) from public.textos_ballots where dataset='demo'"),'0');
 }
});
await check('borrar un libro no borra su editorial ni docentes y retira los resultados que contenían su copia',async()=>{
 await catalogSeed();await apply('book',['clean-book1']);const s=await state();assert.equal(s.publishers.length,3);assert.equal(s.teachers.length,2);assert.equal(s.books.length,1);assert.equal(s.shortlists.length,0);assert.equal(s.rounds.length,0);assert.equal(s.incidents.length,0);assert.equal(s.presentationEvaluations.length,6);
});
await check('una sección elimina sus entregas y rondas; una incidencia se elimina por separado',async()=>{
 await catalogSeed();await apply('section',['clean-section']);let s=await state();assert.equal(s.sections.length,0);assert.equal(s.rounds.length,0);assert.equal(s.deliveries.length,0);assert.equal(s.books.length,2);await apply('incident',['clean-incident']);s=await state();assert.equal(s.incidents.length,0);assert.equal(s.presentationEvaluations.length,6);
});
await check('limpiar el archivo histórico conserva catálogo y disponibilidad de la exposición vigente',async()=>{
 const before=await catalogSeed();await apply('historical');const s=await state();for(const k of ['books','assignments','evaluations','reviews','shortlists','sections','rounds','deliveries'])assert.equal(s[k].length,0);assert.deepEqual(s.offers,before.offers);assert.deepEqual(s.series,before.series);assert.equal(s.presentationEvaluations.length,6);assert.equal(s.presentationQuestions.length,3);assert.equal(s.teachers.length,2);
});
await check('borrar la última serie retira votaciones de categorías que pasan a tener una nueva editorial disponible',async()=>{
 const s=await catalogSeed();const outside={id:'clean-outside-poll',version:1,block:'S1',areas:['COM'],options:{COM:[{id:'clean-p2',name:'Editorial 2'},{id:'clean-p3',name:'Editorial 3'}]},status:'open',rankingId:'prior-final-ranking',rankingVersion:1,createdAt:'2026-11-04T12:00:00Z',closedAt:null,generated:0,received:0,counts:{COM:{options:{'clean-p2':0,'clean-p3':0},blank:0,invalid:0}},results:{}};s.paperPolls=[outside];sql(`update public.textos_datasets set state=${literal(s)} where id='demo';select public.textos_validate_state(state) from public.textos_datasets where id='demo'`);
 const p=await preview('series',['clean-series1']);assert.equal(p.counts.paperPolls,1);await apply('series',['clean-series1']);assert.equal((await state()).paperPolls.length,0);
});
await check('vaciar todos los datos conserva configuración y acceso de Subdirección, sin copias ocultas',async()=>{
 await seed(true);const secrets=sql("select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(x)) from public.textos_director_credentials x),'coordinators',(select jsonb_agg(to_jsonb(x)) from public.textos_coordinators x))");
 const other=sql("select state::text from public.textos_datasets where id='real'");const p=await preview('all');await reject('data_delete_apply',{scope:'all',expectedVersion:p.stateVersion,confirmation:'ELIMINAR'});
 await apply('all');const s=await state();for(const key of ['publishers','teachers','books','series','offers','assignments','evaluations','presentationEvaluations','presentationQuestions','presentationShortlists','shortlists','sections','rounds','paperPolls'])assert.deepEqual(s[key]??[],[]);
 assert.equal(s.settings.title,base.settings.title);assert.equal(s.settings.rules.presentationSeconds,900);assert.equal(s.settings.rules.lockedAt,null);assert.equal(s.settings.editorsWithdrawn,false);assert.equal(s.audit.length,1);
 for(const table of ['textos_history','textos_paper_tokens','textos_ballots','textos_aggregates'])assert.equal(sql(`select count(*) from public.${table} where dataset='demo'`),'0');
 assert.equal(sql("select state::text from public.textos_datasets where id='real'"),other);assert.equal(sql("select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(x)) from public.textos_director_credentials x),'coordinators',(select jsonb_agg(to_jsonb(x)) from public.textos_coordinators x))"),secrets);await reject('snapshot',{},401,teacher);
});
await check('la eliminación funciona en Jornada real del servidor aislado y no toca demostración',async()=>{
 await seed(false,'real');const before=sql("select state::text from public.textos_datasets where id='demo'");const p=await ok('data_delete_preview',{scope:'all'},realDirector,'real');await ok('data_delete_apply',{scope:'all',expectedVersion:p.stateVersion,confirmation:'ELIMINAR TODO'},realDirector,'real');assert.equal((await ok('snapshot',{},realDirector,'real')).state.teachers.length,0);assert.equal(sql("select state::text from public.textos_datasets where id='demo'"),before);
});
await check('reaplicar el esquema instala funciones sin ejecutar eliminaciones ni cambiar datos',async()=>{
 await seed(true);const frozen=sql("select jsonb_build_object('d',(select jsonb_agg(to_jsonb(x)) from public.textos_datasets x),'a',(select jsonb_agg(to_jsonb(x)) from public.textos_access x),'p',(select jsonb_agg(to_jsonb(x)) from public.textos_paper_tokens x))");
 execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres'],{env,input:readFileSync(new URL('../supabase/schema.sql',import.meta.url)),stdio:['pipe','pipe','pipe']});
 assert.equal(sql("select jsonb_build_object('d',(select jsonb_agg(to_jsonb(x)) from public.textos_datasets x),'a',(select jsonb_agg(to_jsonb(x)) from public.textos_access x),'p',(select jsonb_agg(to_jsonb(x)) from public.textos_paper_tokens x))"),frozen);
});
console.log(`PASS ${count}/${count} grupos SQL/HTTP de eliminación administrativa`);
