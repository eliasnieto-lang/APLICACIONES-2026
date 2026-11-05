import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const db=process.env.TEXTOS_TEST_DB_CONTAINER,url=process.env.TEXTOS_TEST_REST_URL;
assert.ok(db&&url,'Ejecute con scripts/test-paper-db.sh en un entorno descartable.');
assert.match(db,/^textos-paper-[0-9]+-db$/);assert.match(url,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
const docker=(...args)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const sql=s=>docker('exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-Atc',s);
const asSql=v=>`convert_from(decode('${Buffer.from(JSON.stringify(v)).toString('hex')}','hex'),'UTF8')::jsonb`;
let checks=0;const check=async(name,fn)=>{await fn();console.log(`✓ ${++checks} ${name}`)};
let director,poll,codes,ranking,backup;
async function rpc(action,payload={},code=director){const r=await fetch(`${url}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:'demo'})});return{status:r.status,body:await r.json()};}
async function ok(action,payload={},code=director){const r=await rpc(action,payload,code);assert.equal(r.status,200,JSON.stringify(r));return r.body;}
async function reject(action,payload={},status=400,code=director){const r=await rpc(action,payload,code);assert.equal(r.status,status,JSON.stringify(r));}
for(let n=0;n<60;n++){try{if((await fetch(url)).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
const state=JSON.parse(sql('select public.textos_empty_state()'));
state.publishers=[1,2,3].map(n=>({id:`paper-publisher-${n}`,version:1,name:`Editorial papel ${n}`,samplesReceived:false,sampleNote:''}));
state.presentationQuestions=state.publishers.map(publisher=>({id:`q-${publisher.id}`,version:1,publisherId:publisher.id,representativeName:'Portavoz del ensayo',area:'MAT',question:'Pregunta del ensayo',answer:'Respuesta del ensayo',status:'answered',askedAt:'2026-11-04T10:00:00Z',answeredAt:'2026-11-04T10:00:01Z',updatedAt:'2026-11-04T10:00:01Z'}));
state.teachers=['MAT','COM'].map(area=>({id:`paper-teacher-${area}`,version:1,name:`Docente ${area}`,firstNames:'Docente',lastNames:area,area,categories:['P1'],attended:true,attendanceEvidence:''}));
state.presentationDraw={id:'paper-draw',version:1,publishers:state.publishers.map(({id,name})=>({id,name})),completedPublisherIds:state.publishers.map(p=>p.id),createdAt:'2026-11-04T15:00:00Z',createdBy:'Subdirección'};
state.turn={publisherId:state.publishers[2].id,status:'finished',startedAt:'2026-11-04T15:00:00Z',pausedAt:'2026-11-04T15:10:00Z',pausedMilliseconds:0};
state.presentationEvaluations=state.teachers.flatMap(t=>state.publishers.map((p,i)=>({id:`paper-evaluation-${t.area}-${i}`,version:1,publisherId:p.id,teacherId:t.id,area:t.area,block:'P1',scores:Array(10).fill(4-i),scaleMax:4,rubricVersion:2,responseScore:4-i,questionVersion:1,notes:Array(10).fill(''),generalObservation:'',physicalText:'',status:'closed',closedAt:'2026-11-04T15:10:00Z',updatedAt:'2026-11-04T15:10:00Z',rulesVersion:1})));
sql(`update public.textos_datasets set state=${asSql(state)} where id='demo'`);
director=sql("select public.textos_bootstrap_local('demo')");
const teacherCode=sql("select public.textos_code()");
sql(`insert into public.textos_access(dataset,code_hash,role,teacher_id,name,expires_at) values('demo',public.textos_hash('${teacherCode}'),'teacher','paper-teacher-MAT','Docente MAT',now()+interval '1 day')`);
await check('solo Subdirección puede preparar o contabilizar la votación en papel',async()=>{
 await reject('paper_poll_create',{},401,null);await reject('paper_poll_create',{},403,teacherCode);
 const privileges=JSON.parse(sql("select jsonb_build_object('anonTable',has_table_privilege('anon','public.textos_paper_tokens','SELECT'),'authTable',has_table_privilege('authenticated','public.textos_paper_tokens','SELECT'),'helper',has_function_privilege('anon','public.textos_paper_action(jsonb,text,jsonb,text,text,text,text,timestamp with time zone)','EXECUTE'))"));assert.deepEqual(privileges,{anonTable:false,authTable:false,helper:false});
});
await check('ranking final actual y referencias de versión son obligatorios',async()=>{
 await reject('paper_poll_create',{block:'P1',areas:['MAT','COM'],rankingId:'missing',expectedRankingVersion:1},409);
 ranking=await ok('presentation_ranking_generate',{expectedVersion:0});assert.equal(ranking.provisional,false);
 await reject('paper_poll_create',{block:'P1',areas:['MAT','COM'],rankingId:ranking.id,expectedRankingVersion:0},409);
 await reject('paper_poll_create',{block:'P1',areas:['MAT','MAT'],rankingId:ranking.id,expectedRankingVersion:ranking.version});
 await reject('paper_poll_create',{block:'S1',areas:['MAT','COM'],rankingId:ranking.id,expectedRankingVersion:ranking.version},423);
});
await check('la ficha congela Top 3 y los polls anónimos anteriores continúan compatibles',async()=>{
 poll=await ok('paper_poll_create',{block:'P1',areas:['MAT','COM'],rankingId:ranking.id,expectedRankingVersion:ranking.version});assert.equal(poll.classrooms.length,10);assert.equal(poll.rosterVersion,1);delete poll.rosterVersion;delete poll.classrooms;sql(`update public.textos_datasets set state=public.textos_put(state,'paperPolls',${asSql(poll)}) where id='demo'`);assert.equal(poll.block,'P1');assert.deepEqual(poll.areas,['MAT','COM']);assert.equal(poll.generated,0);assert.equal(poll.received,0);assert.equal(poll.options.MAT.length,3);assert.equal(poll.options.COM.length,3);assert.equal(poll.options.MAT[0].id,state.publishers[0].id);
 await reject('paper_poll_create',{block:'P1',areas:['MAT'],rankingId:ranking.id,expectedRankingVersion:ranking.version},409);
});
await check('generación de fichas anónimas tiene CAS, límites y códigos únicos',async()=>{
 for(const count of [0,201,1.5])await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,count});
 await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:0,count:1},409);
 const batch=await ok('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,count:6});poll=batch.poll;codes=batch.codes;assert.equal(codes.length,6);assert.equal(new Set(codes).size,6);assert(codes.every(c=>/^[a-f0-9]{64}$/.test(c)));assert.equal(poll.generated,6);
 const stored=sql("select row_to_json(q) from public.textos_paper_tokens q limit 1");assert(!codes.some(c=>stored.includes(c)));assert(!stored.includes('choices'));assert(!stored.includes('teacher'));
});
await check('una lectura debe corresponder a su ficha y a todas sus áreas exactas',async()=>{
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:poll.options.MAT[0].id}},400);
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:'unknown',COM:null}},400);
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:2,COM:null}},400);
 await reject('paper_scan_cast',{pollId:poll.id,code:'0'.repeat(64),choices:{MAT:null,COM:null}},403);
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:null,COM:null}},403,teacherCode);
 assert.equal((await ok('snapshot')).state.paperPolls[0].received,0);
});
await check('una foto clara suma ambas áreas una sola vez y rechaza su repetición',async()=>{
 const accepted=await ok('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:poll.options.MAT[0].id,COM:poll.options.COM[0].id}});assert.equal(accepted.accepted,true);poll=accepted.poll;assert.equal(poll.received,1);assert.equal(poll.counts.MAT.options[poll.options.MAT[0].id],1);
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:poll.options.MAT[1].id,COM:null}},409);assert.equal((await ok('snapshot')).state.paperPolls[0].received,1);
});
await check('dos envíos simultáneos de la misma ficha incrementan solo una vez',async()=>{
 const payload={pollId:poll.id,code:codes[1],choices:{MAT:poll.options.MAT[1].id,COM:poll.options.COM[1].id}};
 const responses=await Promise.all([rpc('paper_scan_cast',payload),rpc('paper_scan_cast',payload)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);poll=(await ok('snapshot')).state.paperPolls[0];assert.equal(poll.received,2);
});
await check('blancos y nulos se concilian sin asignarlos a una editorial',async()=>{
 poll=(await ok('paper_scan_cast',{pollId:poll.id,code:codes[2],choices:{MAT:null,COM:'__invalid__'}})).poll;
 assert.equal(poll.received,3);assert.equal(poll.counts.MAT.blank,1);assert.equal(poll.counts.COM.invalid,1);assert.equal(Object.values(poll.counts.MAT.options).reduce((a,b)=>a+b,0)+poll.counts.MAT.blank+poll.counts.MAT.invalid,3);
});
await check('el respaldo contiene solo huellas anónimas y restaura el estado actual sin duplicar',async()=>{
 backup=await ok('backup_get');assert.equal(backup.paperTokens.length,6);assert.equal(backup.paperTokens.filter(t=>t.consumed).length,3);assert(!codes.some(c=>JSON.stringify(backup).includes(c)));
 await ok('restore_preview',{backup});await ok('restore_apply',{backup,confirmation:'RESTAURAR',reason:'Prueba de respaldo actual de papeletas anónimas'});
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[0],choices:{MAT:null,COM:null}},409);
});
await check('restaurar una copia antigua no retrocede conteos ni desconsume fichas',async()=>{
 poll=(await ok('paper_scan_cast',{pollId:poll.id,code:codes[3],choices:{MAT:poll.options.MAT[0].id,COM:poll.options.COM[1].id}})).poll;
 await reject('restore_preview',{backup},409);await reject('restore_apply',{backup,confirmation:'RESTAURAR',reason:'No debe retroceder votos ya procesados'},409);assert.equal((await ok('snapshot')).state.paperPolls[0].received,4);
 const fresh=await ok('backup_get');const corrupt=structuredClone(fresh);corrupt.paperTokens[0].dataset='real';await reject('restore_preview',{backup:corrupt});
 const missing=structuredClone(fresh);missing.paperTokens=missing.paperTokens.slice(1);await reject('restore_preview',{backup:missing},409);
});
await check('cerrar calcula ganadores de cada área y bloquea fotos posteriores',async()=>{
 await reject('paper_poll_close',{pollId:poll.id,expectedVersion:1},409);
 poll=await ok('paper_poll_close',{pollId:poll.id,expectedVersion:poll.version});assert.equal(poll.status,'closed');assert.equal(poll.results.MAT.state,'winner');assert.equal(poll.results.MAT.winnerId,poll.options.MAT[0].id);assert.equal(poll.results.COM.winnerId,poll.options.COM[1].id);
 await reject('paper_scan_cast',{pollId:poll.id,code:codes[4],choices:{MAT:null,COM:null}},423);await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,count:1},423);
});
await check('proyecciones y auditoría no exponen códigos, fotos ni elecciones individuales',async()=>{
 const publicState=(await ok('public_snapshot',{},null)).state;const teacherState=(await ok('snapshot',{},teacherCode)).state;
 for(const projection of [publicState,teacherState]){const text=JSON.stringify(projection);assert(!codes.some(c=>text.includes(c)));assert(!text.includes('code_hash'));assert(!text.includes('paperTokens'));}
 assert(!teacherState.paperPolls||teacherState.paperPolls.length===0);
 const audit=(await ok('snapshot')).state.audit;const text=JSON.stringify(audit);assert(!codes.some(c=>text.includes(c)));assert(!text.includes('choices'));
});
await check('empate y cero votos válidos nunca inventan un ganador',async()=>{
 const tie=JSON.parse(sql(`select public.textos_paper_result(${asSql({...poll,counts:{MAT:{options:{a:2,b:2},blank:1,invalid:0}}})},'MAT')`));assert.equal(tie.state,'tie');assert.equal(tie.winnerId,null);assert.deepEqual(tie.tiedIds,['a','b']);
 const empty=JSON.parse(sql(`select public.textos_paper_result(${asSql({...poll,counts:{MAT:{options:{a:0,b:0},blank:2,invalid:1}}})},'MAT')`));assert.equal(empty.state,'no_valid_votes');assert.equal(empty.winnerId,null);
});
await check('no se crea una votación si el ranking se volvió provisional u obsoleto',async()=>{
 const current=(await ok('snapshot')).state;current.teachers.push({id:'late-teacher',version:1,name:'Docente tardío',area:'MAT',categories:['P1'],attended:false,attendanceEvidence:''});sql(`update public.textos_datasets set state=${asSql(current)} where id='demo'`);
 await reject('paper_poll_create',{block:'P1',areas:['MAT','COM'],rankingId:ranking.id,expectedRankingVersion:ranking.version},423);
});
await check('dos editoriales no habilitan una votación que requiere tres clasificadas',async()=>{
 const two=structuredClone(state);two.publishers=two.publishers.slice(0,2);two.presentationQuestions=two.presentationQuestions.filter(q=>two.publishers.some(p=>p.id===q.publisherId));two.presentationEvaluations=two.presentationEvaluations.filter(e=>two.publishers.some(p=>p.id===e.publisherId));two.presentationDraw.publishers=two.presentationDraw.publishers.slice(0,2);two.presentationDraw.completedPublisherIds=two.publishers.map(p=>p.id);two.turn.publisherId=two.publishers[1].id;
 const ranked=JSON.parse(sql(`select public.textos_jornada_action(${asSql(two)},'presentation_ranking_generate','{"expectedVersion":0}'::jsonb,'coordinator','paper-owner','Prueba','demo',now())`));
 assert.throws(()=>sql(`select public.textos_paper_action(${asSql(ranked.state)},'paper_poll_create',${asSql({block:'P1',areas:['MAT','COM'],rankingId:ranked.result.id,expectedRankingVersion:1})},'coordinator','paper-owner','Prueba','demo',now())`),/tres editoriales/);
});
console.log(`PASS ${checks}/${checks} grupos SQL/HTTP de votación A5 en papel`);
