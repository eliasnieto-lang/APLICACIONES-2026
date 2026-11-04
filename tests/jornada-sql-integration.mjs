// Real RPC checks; this script refuses a production database or remote endpoint.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const db=process.env.TEXTOS_TEST_DB_CONTAINER,url=process.env.TEXTOS_TEST_REST_URL;
assert.match(db??'',/^textos-jornada-[0-9]+-db$/,'Use scripts/test-jornada-db.sh with its disposable database.');
assert.match(url??'',/^http:\/\/127\.0\.0\.1:[0-9]+$/,'Use the isolated local PostgREST endpoint.');
const env={...process.env};for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const docker=(...args)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const sql=statement=>docker('exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-Atc',statement);
let checks=0;const check=async(name,operation)=>{await operation();console.log(`✓ ${++checks} ${name}`);};
for(let attempt=0;;attempt++){try{if((await fetch(url)).ok)break;}catch{}if(attempt>=60)throw Error('PostgREST did not become ready.');await new Promise(resolve=>setTimeout(resolve,100));}
const director=sql("select public.textos_bootstrap_local('demo')");
async function rpc(action,payload={},code=director){
 // Clock commands carry the exact turn the operator saw, except explicit stale-client cases.
 if(action==='turn_control'&&!Object.hasOwn(payload,'expectedTurn')){const current=await rpc('snapshot',{},code);if(current.status===200)payload={...payload,expectedTurn:current.body.state.turn};}
 const response=await fetch(`${url}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:'demo'})});return{status:response.status,body:await response.json()};
}
async function ok(action,payload={},code=director){const result=await rpc(action,payload,code);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
async function reject(action,payload,status,code=director){const result=await rpc(action,payload,code);assert.equal(result.status,status,JSON.stringify(result.body));}
const state=async()=> (await ok('snapshot')).state;
const publishers=[],teachers=[];let draw,firstForm,ranking,staleFirstTurn;
const field=(publisherId,value,expectedVersion=0)=>({publisherId,area:'MAT',block:'P1',scaleMax:4,rubricVersion:2,responseScore:value,questionVersion:1,scores:Array(10).fill(value),notes:Array(10).fill(''),physicalText:'',generalObservation:'',expectedVersion});
const projectedDraw=value=>({id:value.id,version:value.version,publishers:value.publishers.map(({id,name})=>({id,name})),completedPublisherIds:value.completedPublisherIds,createdAt:value.createdAt,createdBy:'Subdirección'});

await check('no se sortea sin editoriales ni se calcula ranking antes de las exposiciones',async()=>{
 await reject('presentation_draw',{expectedVersion:0,confirmArrivals:true},423);
 await reject('presentation_ranking_generate',{expectedVersion:0},423);
 for(let index=0;index<3;index++)publishers.push(await ok('publisher_save',{publisher:{id:'',version:1,name:`Editorial sorteo ${index+1}`,samplesReceived:false,sampleNote:''}}));
 const fixture=await state();fixture.presentationQuestions=publishers.map(publisher=>({id:`q-${publisher.id}`,version:1,publisherId:publisher.id,representativeName:'Portavoz del ensayo',area:'MAT',question:'Pregunta del ensayo',answer:'Respuesta del ensayo',status:'answered',askedAt:'2026-11-04T10:00:00Z',answeredAt:'2026-11-04T10:00:01Z',updatedAt:'2026-11-04T10:00:01Z'}));
 sql(`update public.textos_datasets set state=convert_from(decode('${Buffer.from(JSON.stringify(fixture)).toString('hex')}','hex'),'UTF8')::jsonb where id='demo'`);
 for(const firstNames of ['Ana','Beatriz'])teachers.push(await ok('teacher_register',{firstNames,lastNames:'Sorteo',area:'MAT',categories:['P1']},null));
 firstForm=await ok('presentation_save',field(publishers[0].id,3),teachers[0].code);
 firstForm=await ok('presentation_close',{evaluationId:firstForm.id,expectedVersion:firstForm.version,scaleMax:4,rubricVersion:2},teachers[0].code);
});

await check('solo Subdirección sortea; se exige confirmar las editoriales y se ignora cualquier orden suministrado',async()=>{
 await reject('presentation_draw',{expectedVersion:0,confirmArrivals:true},401,null);
 await reject('presentation_draw',{expectedVersion:0,confirmArrivals:true},403,teachers[0].code);
 await reject('presentation_ranking_generate',{expectedVersion:0},403,teachers[0].code);
 await reject('presentation_draw',{expectedVersion:0},400);
 // A paused legacy room must not trap the first installation of the new feature.
 await ok('turn_control',{command:'start',publisherId:publishers[0].id});
 await reject('presentation_draw',{expectedVersion:0,confirmArrivals:true},423);
 await ok('turn_control',{command:'pause'});
 draw=await ok('presentation_draw',{expectedVersion:0,confirmArrivals:true,publisherIds:['invented'],seed:'client-controlled'});
 assert.equal(draw.version,1);assert.equal(new Set(draw.publishers.map(item=>item.id)).size,3);
 assert.deepEqual(draw.publishers.map(item=>item.id).sort(),publishers.map(item=>item.id).sort());
 assert(draw.publishers.every(item=>publishers.some(publisher=>publisher.id===item.id&&publisher.name===item.name)));
 assert.deepEqual(draw.completedPublisherIds,[]);
 const s=await state();assert.equal(s.turn.status,'ready');assert.equal(s.turn.startedAt,null);assert.equal(s.turn.publisherId,draw.publishers[0].id);
 assert.deepEqual(s.presentationEvaluations.find(item=>item.id===firstForm.id),firstForm);
 assert((await ok('backup_get')).history.some(item=>item.entity==='turn'&&item.previous.status==='paused'));
});

await check('todos los docentes y la sala pública reciben el mismo orden, sin ranking privado',async()=>{
 const privateState=await state();
 for(const teacher of teachers){const s=(await ok('snapshot',{},teacher.code)).state;assert.deepEqual(s.presentationDraw,projectedDraw(privateState.presentationDraw));assert(!s.presentationRanking);}
 const publicState=(await ok('public_snapshot',{},null)).state;assert.deepEqual(publicState.presentationDraw,projectedDraw(draw));assert(!publicState.presentationRanking);
 assert.deepEqual(publicState.teachers,[]);assert.deepEqual(publicState.presentationEvaluations,[]);
});

await check('repetir antes de iniciar exige CAS y motivo; la versión anterior queda en historial',async()=>{
 await reject('presentation_draw',{expectedVersion:0,confirmArrivals:true,reason:'Motivo documentado de ensayo'},409);
 await reject('presentation_draw',{expectedVersion:draw.version,confirmArrivals:true},400);
 const old=draw;
 draw=await ok('presentation_draw',{expectedVersion:draw.version,confirmArrivals:true,reason:'Repetición documentada antes de iniciar'});
 assert.equal(draw.version,old.version+1);assert.notEqual(draw.id,old.id);
 assert.deepEqual(draw.publishers.map(item=>item.id).sort(),publishers.map(item=>item.id).sort());
 assert((await ok('backup_get')).history.some(item=>item.entity==='presentationDraw'&&item.previous.id===old.id));
});

await check('el servidor fuerza el orden sorteado y no permite saltar ni finalizar dos veces',async()=>{
 await reject('turn_control',{command:'finish'},409);
 await reject('turn_control',{command:'start',publisherId:draw.publishers[1].id},409);
 await ok('turn_control',{command:'start',publisherId:draw.publishers[0].id});
 await reject('turn_control',{command:'next',publisherId:draw.publishers[1].id},423);
 await reject('presentation_draw',{expectedVersion:draw.version,confirmArrivals:true,reason:'Cambio de orden no permitido'},423);
 await ok('turn_control',{command:'pause'});await ok('turn_control',{command:'resume'});staleFirstTurn=(await state()).turn;await ok('turn_control',{command:'finish'});
 let s=await state();assert.deepEqual(s.presentationDraw.completedPublisherIds,[draw.publishers[0].id]);assert.equal(s.turn.status,'finished');
 await reject('turn_control',{command:'finish'},409);
 await reject('turn_control',{command:'start',publisherId:draw.publishers[0].id},409);
 await reject('presentation_ranking_generate',{expectedVersion:0},423);
});

await check('un finish retrasado o sin identidad de turno no cierra la siguiente editorial',async()=>{
 await ok('turn_control',{command:'next',publisherId:draw.publishers[1].id});
 await reject('turn_control',{command:'finish',expectedTurn:staleFirstTurn},409);
 await reject('turn_control',{command:'finish',expectedTurn:null},409);
 const s=await state();assert.equal(s.turn.status,'running');assert.equal(s.turn.publisherId,draw.publishers[1].id);assert.deepEqual(s.presentationDraw.completedPublisherIds,[draw.publishers[0].id]);
 await ok('turn_control',{command:'finish'});
});

await check('no se agregan nuevas editoriales después de iniciar el orden de participación',async()=>{
 await reject('publisher_save',{publisher:{id:'',version:1,name:'Editorial tardía sin sorteo',samplesReceived:false,sampleNote:''}},423);
 const rows=[{code:'TARDIO-SORTEO-1',publisher:'Editorial importada fuera del sorteo',series:'Serie tardía',area:'MAT',block:'P1',gradeId:'PRI1',title:'Texto fuera de orden',edition:'2027',declaredBasePrice:null,priceSource:'',priceValidity:''}];
 const preview=await ok('import_preview',{kind:'titles',rows});assert.equal(preview.valid,false);assert.match(preview.errors[0].message,/No puede importar editoriales nuevas/);
 await reject('import_apply',{kind:'titles',rows,confirmed:true},423);
 assert.equal((await state()).publishers.length,3);
});

await check('siguiente inicia cada editorial restante exactamente una vez y el avance es compartido',async()=>{
 for(const publisher of draw.publishers.slice((await state()).presentationDraw.completedPublisherIds.length)){await ok('turn_control',{command:'next',publisherId:publisher.id});await ok('turn_control',{command:'finish'});}
 const s=await state();assert.deepEqual(s.presentationDraw.completedPublisherIds,draw.publishers.map(item=>item.id));
 await reject('turn_control',{command:'next',publisherId:draw.publishers[0].id},423);
 assert.deepEqual((await ok('public_snapshot',{},null)).state.presentationDraw,projectedDraw(s.presentationDraw));
 assert.deepEqual((await ok('snapshot',{},teachers[0].code)).state.presentationDraw,projectedDraw(s.presentationDraw));
});

await check('el ranking tras exposiciones es provisional si faltan fichas y no convierte pendientes en cero',async()=>{
 ranking=await ok('presentation_ranking_generate',{expectedVersion:0});assert.equal(ranking.version,1);assert.equal(ranking.provisional,true);assert.equal(ranking.drawId,draw.id);assert.equal(ranking.stale,false);assert.equal(ranking.categories.length,6);
 const category=ranking.categories.find(item=>item.categoryId==='MAT-P1');assert.equal(category.registered,2);assert.equal(category.pending,5);assert.equal(category.ranked.find(item=>item.publisherId===publishers[0].id).score,75);
 assert.equal(category.ranked.filter(item=>item.score===null).length,2);
 assert(!((await ok('snapshot',{},teachers[0].code)).state.presentationRanking));
 assert(!((await ok('public_snapshot',{},null)).state.presentationRanking));
 await reject('presentation_ranking_generate',{expectedVersion:0},409);
 assert.equal(sql("select public.textos_jornada_ranking_current(state) from public.textos_datasets where id='demo'"),'t');
});

await check('nuevas fichas invalidan la vigencia del ranking anterior y la regeneración promedia a todos',async()=>{
 for(const [teacherIndex,teacher]of teachers.entries())for(const publisher of publishers){
  let existing=(await ok('snapshot',{},teacher.code)).state.presentationEvaluations.find(item=>item.publisherId===publisher.id);
  if(existing?.status==='closed'){await ok('presentation_reopen',{evaluationId:existing.id,expectedVersion:existing.version,reason:'Ensayo de cierre definitivo de todas las fichas'});existing=(await ok('snapshot',{},teacher.code)).state.presentationEvaluations.find(item=>item.id===existing.id);}
  const form=await ok('presentation_save',field(publisher.id,teacherIndex===0?0:4,existing?.version??0),teacher.code);
  await ok('presentation_close',{evaluationId:form.id,expectedVersion:form.version,scaleMax:4,rubricVersion:2},teacher.code);
 }
 assert.equal(sql("select public.textos_jornada_ranking_current(state) from public.textos_datasets where id='demo'"),'f');
 assert.equal((await state()).presentationRanking.stale,true);
 const old=ranking;ranking=await ok('presentation_ranking_generate',{expectedVersion:ranking.version});
 assert.equal(ranking.version,2);assert.equal(ranking.provisional,false);assert.equal(ranking.stale,false);
 const category=ranking.categories.find(item=>item.categoryId==='MAT-P1');assert.equal(category.closed,6);assert.equal(category.pending,0);assert(category.ranked.every(item=>item.score===50));
 assert((await ok('backup_get')).history.some(item=>item.entity==='presentationRanking'&&item.previous.id===old.id));
});

await check('la validación de respaldo rechaza completar exposiciones fuera del orden y rankings corruptos',async()=>{
 const backup=await ok('backup_get');
 const wrong=structuredClone(backup);wrong.state.presentationDraw.completedPublisherIds=[draw.publishers[1].id];
 await reject('restore_preview',{backup:wrong},400);
 const corrupt=structuredClone(backup);corrupt.state.presentationRanking.categories[0].ranked[0].score=1000;
 await reject('restore_preview',{backup:corrupt},400);
 const duplicate=structuredClone(backup);duplicate.state.presentationDraw.publishers[1]=duplicate.state.presentationDraw.publishers[0];
 await reject('restore_preview',{backup:duplicate},400);
});

await check('los campos extra de un sorteo restaurado no se filtran a docentes ni sala pública',async()=>{
 const backup=await ok('backup_get');const hidden='NOTA PRIVADA QUE NO DEBE PROYECTARSE';
 backup.state.presentationDraw.privateTeacherNotes=hidden;
 backup.state.presentationDraw.publishers[0].teacherScores=hidden;
 backup.state.presentationDraw.createdBy=hidden;
 await ok('restore_apply',{backup,confirmation:'RESTAURAR',reason:'Ensayo de proyección segura del orden de participación'});
 for(const code of [null,teachers[0].code]){
  const s=(await ok(code?'snapshot':'public_snapshot',{},code)).state;
  assert(!JSON.stringify(s).includes(hidden));assert.equal(s.presentationDraw.createdBy,'Subdirección');
  assert.deepEqual(Object.keys(s.presentationDraw.publishers[0]).sort(),['id','name']);
 }
});

console.log(`${checks} grupos SQL/HTTP de sorteo, secuencia y ranking aprobados.`);
