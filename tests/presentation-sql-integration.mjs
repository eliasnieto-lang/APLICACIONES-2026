import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const db=process.env.TEXTOS_TEST_DB_CONTAINER ?? process.env.ACCESS_DB,url=process.env.TEXTOS_TEST_REST_URL ?? process.env.ACCESS_URL;
assert.ok(db && url, 'Ejecute con scripts/test-presentation-db.sh en un entorno descartable.');
assert.match(db,/^textos-presentation-[0-9]+-db$/,'La prueba solo admite su contenedor PostgreSQL descartable.');
assert.match(url,/^http:\/\/127\.0\.0\.1:[0-9]+$/,'La prueba solo admite PostgREST local descartable.');
const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
const docker=(...args)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const sql=s=>docker('exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-Atc',s);
let count=0;const check=async(name,fn)=>{await fn();console.log(`✓ ${++count} ${name}`)};
async function rpc(action,payload={},code=null){const r=await fetch(`${url}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:'demo'})});return {status:r.status,body:await r.json()};}
async function ok(action,payload={},code=director){const r=await rpc(action,payload,code);assert.equal(r.status,200,JSON.stringify(r));return r.body;}
async function reject(action,payload,code,status){const r=await rpc(action,payload,code);assert.equal(r.status,status,JSON.stringify(r));}
const scoreArray=total=>Array.from({length:10},()=>{const value=Math.min(4,total);total-=value;return value;});
const questionVersions=new Map();
const closeTo=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`Expected ${actual} to equal ${expected}`);
const grade=(sum,response=4)=>(sum+response)*100/44;
const fields=(publisherId,scores,expectedVersion=0)=>({publisherId,area:'MAT',block:'P1',scores,scaleMax:4,rubricVersion:2,responseScore:questionVersions.has(publisherId)?4:null,questionVersion:questionVersions.get(publisherId)??null,notes:Array(10).fill(''),physicalText:'',generalObservation:'',expectedVersion});
let director,first,backup,published,initialSettingsVersion;const teachers=[],publishers=[];const totals=[[40,20,32,28,36],[40,28,32,32,36],[40,32,36,36,36]];
for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
director=sql("select public.textos_bootstrap_local('demo')");
await check('cinco docentes en un bloque sin asignaciones ni libros precargados',async()=>{
 for(let i=0;i<5;i++){const body=await ok('teacher_register',{firstNames:['Ana','Beatriz','Carla','Diana','Elena'][i],lastNames:'Presentación',area:'MAT',categories:['P1']},null);teachers.push({code:body.code,id:body.snapshot.actor.id});}
 for(let i=0;i<3;i++)publishers.push(await ok('publisher_save',{publisher:{id:'',version:1,name:`Editorial en vivo ${i+1}`,samplesReceived:false,sampleNote:''}}));
 const s=(await ok('snapshot')).state;assert.equal(s.teachers.length,5);assert.equal(s.books.length,0);assert.equal(s.assignments.length,0);assert.equal(s.offers.length,0);assert.equal(s.presentationEvaluations.length,0);initialSettingsVersion=s.settings.version;
});
await check('la ficha empieza pendiente y el primer guardado fija reglas sin datos de expediente',async()=>{
 first=await ok('presentation_save',fields(publishers[0].id,Array(10).fill(null)),teachers[0].code);assert.equal(first.version,1);assert.equal(first.status,'draft');assert.deepEqual(first.scores,Array(10).fill(null));assert.equal(first.physicalText,'');assert.equal(first.scaleMax,4);assert.equal(first.rubricVersion,2);assert.equal(first.responseScore,null);assert.equal(first.questionVersion,null);
 await reject('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:first.version},teachers[0].code,400);
 const s=(await ok('snapshot')).state;assert.ok(s.settings.rules.lockedAt);assert.equal(s.settings.version,initialSettingsVersion+1);
});
await check('autoría y perfil se verifican en servidor; no se acepta una ficha de colega',async()=>{
 await reject('presentation_save',{...fields(publishers[0].id,scoreArray(40)),area:'COM'},teachers[0].code,403);
 await reject('presentation_save',{...fields(publishers[0].id,scoreArray(40)),block:'S1'},teachers[0].code,403);
 await reject('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:1},teachers[1].code,403);
 await reject('presentation_save',fields('missing',scoreArray(40)),teachers[0].code,403);
 await reject('presentation_summary',{},teachers[0].code,403);
 await reject('presentation_save',fields(publishers[0].id,scoreArray(40)),director,403);
});
await check('la versión antigua de la aplicación debe actualizar la escala antes de guardar o cerrar',async()=>{
 const currentPayload=fields(publishers[0].id,scoreArray(40),first.version);const oldRubric={...currentPayload};delete oldRubric.rubricVersion;await reject('presentation_save',oldRubric,teachers[0].code,409);
 const payload={...currentPayload};delete payload.scaleMax;
 await reject('presentation_save',payload,teachers[0].code,409);
 await reject('presentation_save',{...payload,scaleMax:2},teachers[0].code,409);
 await reject('presentation_close',{evaluationId:first.id,expectedVersion:first.version},teachers[0].code,409);
});
await check('CAS impide sobrescribir y puntajes fraccionarios o fuera de rango se rechazan',async()=>{
 for(const expectedVersion of [undefined,null,0])await reject('presentation_save',{...fields(publishers[0].id,scoreArray(40)),expectedVersion},teachers[0].code,409);
 for(const bad of [-1,5,1.5])await reject('presentation_save',{...fields(publishers[0].id,[bad,...Array(9).fill(4)],1)},teachers[0].code,400);
 await reject('presentation_save',{...fields(publishers[0].id,Array(9).fill(4),1)},teachers[0].code,400);
});
await check('I11 se valora y cierra sin autorización de sala ni registro de pregunta',async()=>{
 const saved=await ok('presentation_save',{...fields(publishers[0].id,scoreArray(40),first.version),responseScore:4},teachers[0].code);first=saved;
 assert.equal(saved.responseScore,4);assert.equal(saved.questionVersion,null);assert.equal(((await ok('snapshot')).state.presentationQuestions??[]).length,0);
 const closed=await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:saved.id,expectedVersion:saved.version},teachers[0].code);
 assert.equal(closed.status,'closed');assert.equal(Number(sql(`select public.textos_presentation_score_of('${JSON.stringify(closed)}'::jsonb,true)`)),100);
 first=await ok('presentation_reopen',{evaluationId:closed.id,reason:'Continuar el ensayo independiente de los cinco evaluadores.'});
});
await check('la casilla confirma la pregunta de cada editorial sin determinar la validez de I11',async()=>{
 for(const publisher of publishers){
  const turn=(await ok('snapshot')).state.turn;
  await ok('turn_control',{command:'start',publisherId:publisher.id,expectedTurn:turn});
  const question=await ok('presentation_question_save',{publisherId:publisher.id,expectedVersion:0,confirmed:true});
  questionVersions.set(publisher.id,question.version);assert.equal(question.status,'answered');assert.equal(question.confirmed,true);assert(!Object.hasOwn(question,'representativeName'));
  await ok('turn_control',{command:'finish',expectedTurn:(await ok('snapshot')).state.turn});
 }
 assert.equal((await ok('snapshot')).state.presentationQuestions.length,3);
});
await check('todas las fichas cierran con once valoraciones; no exige OBNATE, precio, carga ni notas',async()=>{
 for(let p=0;p<3;p++)for(let i=0;i<5;i++){
  const payload=fields(publishers[p].id,scoreArray(totals[p][i]),p===0&&i===0?first.version:0);
  if(p===0&&i===0){payload.notes[0]='OBSERVACIÓN PERSONAL SECRETA';payload.generalObservation='COMENTARIO PERSONAL SECRETO';payload.teacherId=teachers[1].id;}
  const saved=await ok('presentation_save',payload,teachers[i].code);assert.equal(saved.teacherId,teachers[i].id);
  const closed=await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:saved.id,expectedVersion:saved.version},teachers[i].code);assert.equal(closed.status,'closed');assert.equal(closed.rubricVersion,2);assert.equal(closed.responseScore,4);assert.equal(closed.questionVersion,questionVersions.get(publishers[p].id));
  if(p===0&&i===0)first=closed;
  if(p===0&&i===2){const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,5);assert.equal(summary.ranked[0].closed,3);assert.equal(summary.ranked[0].pending,2);closeTo(summary.ranked[0].score,grade((40+20+32)/3));}
 }
 await reject('presentation_save',fields(publishers[0].id,scoreArray(36),first.version),teachers[0].code,423);
 const s=(await ok('snapshot')).state;assert.equal(s.presentationEvaluations.length,15);assert.equal(s.evaluations.length,0);assert.equal(s.books.length,0);
});
await check('el promedio incluye a los cinco docentes y los conteos no tienen cupo de dos',async()=>{
 const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,5);assert.equal(summary.closed,15);assert.equal(summary.pending,0);assert.equal(summary.state,'ready');
 for(let p=0;p<3;p++){const row=summary.ranked.find(q=>q.publisherId===publishers[p].id);assert.equal(row.closed,5);closeTo(row.score,grade(totals[p].reduce((sum,value)=>sum+value,0)/5));}
});
await check('cada docente solo ve sus tres fichas y la proyección pública todavía no muestra notas',async()=>{
 const a=(await ok('snapshot',{},teachers[0].code)).state,b=(await ok('snapshot',{},teachers[1].code)).state;
 assert.equal(a.presentationEvaluations.length,3);assert.ok(a.presentationEvaluations.every(q=>q.teacherId===teachers[0].id));assert.equal(a.presentationShortlists.length,0);assert.equal(b.presentationEvaluations.length,3);assert.ok(!JSON.stringify(b).includes('PERSONAL SECRETO'));assert.ok(!JSON.stringify(b).includes('PERSONAL SECRETA'));
 const pub=(await ok('public_snapshot',{},null)).state;assert.equal(pub.presentationEvaluations.length,0);assert.equal(pub.presentationShortlists.length,0);assert.ok(!JSON.stringify(pub).includes('SECRETO'));
});
await check('publicar requiere retiro de editoriales documentado, sin añadir requisitos de expediente',async()=>{
 const payload={area:'MAT',block:'P1',directorApproved:true,statement:'Apreciación colectiva.',folio:'F-RETIRO'};
 await reject('presentation_shortlist_publish',payload,director,423);
 sql("update public.textos_datasets set state=jsonb_set(state,'{settings,editorsWithdrawn}','true'::jsonb) where id='demo'");
 await reject('presentation_shortlist_publish',payload,director,423);
 sql("update public.textos_datasets set state=jsonb_set(state,'{settings,withdrawalReference}','\"Retiro documentado de prueba R-1\"'::jsonb) where id='demo'");
});
await check('el umbral guardado no bloquea las tres editoriales clasificadas para votación familiar',async()=>{
 sql("update public.textos_datasets set state=jsonb_set(state,'{settings,rules,threshold}','100'::jsonb) where id='demo'");
 const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.state,'ready');assert.equal(summary.finalists.length,3);assert.ok(summary.ranked.every(row=>row.state==='eligible'));assert.deepEqual(summary.reasons,[]);
 for(const count of [1,2]){
  const category=JSON.parse(sql(`select public.textos_presentation_category(jsonb_set(state,'{publishers}',(select jsonb_agg(q) from (select q from jsonb_array_elements(state->'publishers') q limit ${count}) p)),'MAT','P1') from public.textos_datasets where id='demo'`));
  assert.equal(category.state,'less_than_three');assert.equal(category.finalists.length,count);assert.ok(!category.reasons.some(reason=>reason.includes('alcanzan')));
 }
});
await check('la clasificación publica tres editoriales orientativas sin decidir la elección de los padres',async()=>{
 await reject('presentation_shortlist_publish',{area:'COM',block:'P1',directorApproved:true,statement:'Prueba',folio:'F-0'},director,423);
 published=await ok('presentation_shortlist_publish',{area:'MAT',block:'P1',directorApproved:true,statement:'Apreciación pedagógica conjunta.',folio:'F-1'});assert.equal(published.publisherIds.length,3);assert.equal(published.snapshot.scaleMax,4);assert.equal(published.snapshot.rubricVersion,2);assert.equal(published.snapshot.threshold,0);
 const pub=(await ok('public_snapshot',{},null)).state;assert.equal(pub.presentationEvaluations.length,0);assert.equal(pub.presentationShortlists.length,1);assert.equal(pub.presentationShortlists[0].snapshot.scaleMax,4);assert.equal(pub.presentationShortlists[0].snapshot.rubricVersion,2);assert.equal(pub.presentationShortlists[0].snapshot.assessment.ranked[0].closed,5);assert.ok(!JSON.stringify(pub).includes('SECRETO'));assert.ok(!JSON.stringify(pub.presentationShortlists).includes('teacherId'));
 assert.equal((await ok('snapshot',{},teachers[0].code)).state.presentationShortlists.length,0);
});
await check('campos personalizados en un respaldo no atraviesan la proyección pública',async()=>{
 sql(`update public.textos_datasets set state=jsonb_set(state,'{presentationShortlists,0,snapshot,extra}', '{"notes":"PERSONAL SECRETO"}'::jsonb) where id='demo'`);
 sql(`update public.textos_datasets set state=jsonb_set(state,'{presentationShortlists,0,snapshot,assessment,ranked,0,scores}', '[2,2,2,2,2,2,2,2,2,2]'::jsonb) where id='demo'`);
 const pub=(await ok('public_snapshot',{},null)).state;assert.ok(!JSON.stringify(pub).includes('SECRETO'));assert.ok(!Object.hasOwn(pub.presentationShortlists[0].snapshot.assessment.ranked[0],'scores'));assert.ok(!Object.hasOwn(pub.presentationShortlists[0].snapshot,'extra'));
});
await check('reabrir requiere coordinación y motivo, conserva cierre y retira la publicación afectada',async()=>{
 await reject('presentation_reopen',{evaluationId:first.id,reason:'Corregir observación'},teachers[0].code,403);await reject('presentation_reopen',{evaluationId:first.id,reason:''},director,400);
 const reopened=await ok('presentation_reopen',{evaluationId:first.id,reason:'Revisión documentada de la observación.'});assert.equal(reopened.status,'draft');assert.equal(reopened.closedAt,null);assert.equal(reopened.version,first.version+1);
 const s=(await ok('snapshot')).state;assert.equal(s.presentationShortlists[0].status,'superseded');assert.equal((await ok('public_snapshot',{},null)).state.presentationShortlists.length,0);
 assert.ok(Number(sql(`select count(*) from public.textos_history where entity='presentationEvaluations' and reference_id='${first.id}' and previous->>'status'='closed'`))>=1);
 assert.ok(Number(sql(`select count(*) from public.textos_history where entity='presentationShortlists' and reference_id='${published.id}' and previous->>'status'='published'`))>=1);
});
await check('respaldo y restauración conservan fichas nuevas e historial sin recrear asignaciones',async()=>{
 backup=await ok('backup_get');assert.equal(backup.state.presentationEvaluations.length,15);assert.ok(backup.history.some(h=>h.entity==='presentationEvaluations'));
 assert.equal((await ok('restore_preview',{backup})).valid,true);assert.equal((await ok('restore_apply',{backup,confirmation:'RESTAURAR',reason:'Prueba de restauración en entorno aislado.'})).restored,true);
 const s=(await ok('snapshot')).state;assert.deepEqual(s.presentationEvaluations,backup.state.presentationEvaluations);assert.deepEqual(s.presentationShortlists,backup.state.presentationShortlists);assert.equal(s.assignments.length,0);assert.equal(s.evaluations.length,0);
});
await check('el servidor rechaza respaldos con fichas duplicadas o categorías docentes vacías',async()=>{
 const duplicate=structuredClone(backup);duplicate.state.presentationEvaluations.push({...duplicate.state.presentationEvaluations[0],id:'duplicate'});await reject('restore_preview',{backup:duplicate},director,400);
 const noScope=structuredClone(backup);noScope.state.teachers[0].categories=[];await reject('restore_preview',{backup:noScope},director,400);
 const incompleteShortlist=structuredClone(backup);incompleteShortlist.state.presentationShortlists[0].status='published';incompleteShortlist.state.presentationShortlists[0].publisherIds.pop();await reject('restore_preview',{backup:incompleteShortlist},director,400);
});
await check('restaurar una terna publicada exige aprobación y metadatos formales válidos',async()=>{
 const valid=structuredClone(backup);valid.state.presentationShortlists[0]=structuredClone(published);assert.equal((await ok('restore_preview',{backup:valid})).valid,true);
 for(const patch of [{directorApproved:false},{directorApproved:null},{statement:''},{statement:'   '},{statement:{}},{folio:''},{folio:'  '},{folio:3},{rulesVersion:0},{rulesVersion:1.5},{rulesVersion:null},{publishedAt:null},{publishedAt:''},{publishedAt:'not-a-date'},{publishedAt:'2026-99-99T00:00:00Z'},{publishedAt:'infinity'}]){
  const corrupt=structuredClone(valid);Object.assign(corrupt.state.presentationShortlists[0],patch);await reject('restore_preview',{backup:corrupt},director,400);
 }
});
await check('una inscripción posterior exige nuevas fichas y conserva la terna anterior en historial',async()=>{
 const open=(await ok('snapshot')).state.presentationEvaluations.find(e=>e.id===first.id);assert.equal(open.status,'draft');
 await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:open.id,expectedVersion:open.version},teachers[0].code);
 const publicationPayload={area:'MAT',block:'P1',directorApproved:true,statement:'Publicación previa a una inscripción adicional.',folio:'F-INSCRIPCIÓN'};
 const before=await ok('presentation_shortlist_publish',publicationPayload);
 const originalForms=(await ok('snapshot')).state.presentationEvaluations;
 await ok('teacher_register',{firstNames:'Ana',lastNames:'Presentación',area:'MAT',categories:['P1']},teachers[0].code);
 let s=(await ok('snapshot')).state;assert.equal(s.presentationShortlists.find(q=>q.id===before.id).status,'published');
 const sixth=await ok('teacher_register',{firstNames:'Flora',lastNames:'Presentación',area:'MAT',categories:['P1']},null);
 s=(await ok('snapshot')).state;assert.deepEqual(s.presentationEvaluations,originalForms);assert.equal(s.presentationEvaluations.length,15);assert.equal(s.presentationShortlists.find(q=>q.id===before.id).status,'superseded');
 let summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,6);assert.equal(summary.closed,15);assert.equal(summary.pending,3);assert.equal(summary.state,'pending');
 assert.equal((await ok('public_snapshot',{},null)).state.presentationShortlists.length,0);
 assert.ok(Number(sql(`select count(*) from public.textos_history where entity='presentationShortlists' and reference_id='${before.id}' and reason='Inscripción/actualización docente' and previous->>'status'='published'`))>=1);
 await reject('presentation_shortlist_publish',publicationPayload,director,423);
 for(const publisher of publishers){const saved=await ok('presentation_save',fields(publisher.id,scoreArray(36)),sixth.code);await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:saved.id,expectedVersion:saved.version},sixth.code);}
 summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,6);assert.equal(summary.closed,18);assert.equal(summary.pending,0);
 const republished=await ok('presentation_shortlist_publish',{...publicationPayload,folio:'F-SEIS'});
 await ok('teacher_register',{firstNames:'Flora',lastNames:'Presentación',area:'COM',categories:['S1']},sixth.code);
 s=(await ok('snapshot')).state;assert.equal(s.presentationShortlists.find(q=>q.id===republished.id).status,'superseded');assert.equal(s.presentationEvaluations.length,18);assert.ok(s.presentationEvaluations.filter(e=>e.teacherId===sixth.snapshot.actor.id).every(e=>e.status==='closed'));
 assert.ok(Number(sql(`select count(*) from public.textos_history where entity='presentationShortlists' and reference_id='${republished.id}' and reason='Inscripción/actualización docente' and previous->>'status'='published'`))>=1);
});
const sqlJson=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
function replaceForm(form){sql(`update public.textos_datasets set state=public.textos_put(state,'presentationEvaluations',${sqlJson(form)}) where id='demo'`);}
await check('las fichas históricas 0–2 se conservan con su porcentaje y no se mezclan con la escala 0–4',async()=>{
 const state=(await ok('snapshot')).state;const current=state.presentationEvaluations.find(e=>e.teacherId===teachers[0].id&&e.publisherId===publishers[0].id);
 const legacy={...current,scaleMax:2,scores:Array(10).fill(1),version:current.version+1};delete legacy.rubricVersion;delete legacy.responseScore;delete legacy.questionVersion;replaceForm(legacy);first=legacy;
 assert.equal(Number(sql(`select public.textos_presentation_scores('${JSON.stringify(legacy.scores)}'::jsonb,2,true)`)),50);
 assert.equal(sql(`select public.textos_scores('${JSON.stringify(legacy.scores)}'::jsonb,true)`),'50');
 const own=(await ok('snapshot',{},teachers[0].code)).state.presentationEvaluations.find(e=>e.id===legacy.id);assert.deepEqual(own,legacy);
 const category=await ok('presentation_summary',{area:'MAT',block:'P1'}),row=category.ranked.find(e=>e.publisherId===publishers[0].id);
 assert.equal(category.pendingScaleUpdate,1);assert.equal(row.pendingScaleUpdate,1);assert.equal(row.closed,4);assert.equal(row.pending,1);closeTo(row.score,grade((20+32+28+36)/4));
 await reject('presentation_save',fields(publishers[0].id,scoreArray(40),legacy.version),teachers[0].code,409);
 await reject('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:legacy.id,expectedVersion:legacy.version},teachers[0].code,409);
 const exported=await ok('backup_get');assert.deepEqual(exported.state.presentationEvaluations.find(e=>e.id===legacy.id),legacy);assert.equal((await ok('restore_preview',{backup:exported})).valid,true);
});
await check('solo el autor reinicia explícitamente la rúbrica histórica con CAS y sin convertir sus puntajes',async()=>{
 await reject('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:first.version},teachers[1].code,403);
 await reject('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:first.version},director,403);
 await reject('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:first.version-1},teachers[0].code,409);
 await reject('presentation_restart_scale',{evaluationId:first.id,expectedVersion:first.version},teachers[0].code,409);
 const restarted=await ok('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:first.id,expectedVersion:first.version},teachers[0].code);
 assert.equal(restarted.id,first.id);assert.equal(restarted.version,first.version+1);assert.equal(restarted.scaleMax,4);assert.equal(restarted.status,'draft');assert.equal(restarted.closedAt,null);assert.deepEqual(restarted.scores,Array(10).fill(null));assert.deepEqual(restarted.notes,first.notes);assert.equal(restarted.generalObservation,first.generalObservation);assert.equal(restarted.rubricVersion,2);assert.equal(restarted.responseScore,null);assert.equal(restarted.questionVersion,null);
 const historic=JSON.parse(sql(`select previous from public.textos_history where entity='presentationEvaluations' and reference_id='${first.id}' and reason='Actualización explícita de escala 0–2 a 0–4' order by id desc limit 1`));assert.deepEqual(historic,first);
 const row=(await ok('presentation_summary',{area:'MAT',block:'P1'})).ranked.find(e=>e.publisherId===publishers[0].id);assert.equal(row.pendingScaleUpdate,0);assert.equal(row.closed,4);assert.equal(row.pending,1);assert.equal(row.drafts,1);
 await reject('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:restarted.id,expectedVersion:restarted.version},teachers[0].code,409);first=restarted;
});
await check('el cero explícito suma cero y cuenta en el promedio; null sigue pendiente',async()=>{
 assert.equal(Number(sql("select public.textos_presentation_scores('[0,0,0,0,0,0,0,0,0,0]'::jsonb,4,true)")),0);
 assert.equal(Number(sql("select public.textos_presentation_scores('[4,4,4,4,4,4,4,4,4,4]'::jsonb,4,true)")),100);
 assert.equal(Number(sql("select public.textos_presentation_scores('[1,0,0,0,0,0,0,0,0,0]'::jsonb,4,true)")),2.5);
 const saved=await ok('presentation_save',{...fields(publishers[0].id,Array(10).fill(0),first.version),responseScore:0},teachers[0].code);const closed=await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:saved.id,expectedVersion:saved.version},teachers[0].code);assert.deepEqual(closed.scores,Array(10).fill(0));
 const row=(await ok('presentation_summary',{area:'MAT',block:'P1'})).ranked.find(e=>e.publisherId===publishers[0].id);assert.equal(row.closed,5);assert.equal(row.pending,0);closeTo(row.score,(0+totals[0].slice(1).reduce((sum,value)=>sum+value+4,0))*100/(44*5));assert.equal(row.state,'eligible');
});
await check('la reapertura conserva la escala histórica implícita y requiere reinicio propio para valorar de nuevo',async()=>{
 const state=(await ok('snapshot')).state;const legacy={...state.presentationEvaluations.find(e=>e.teacherId===teachers[1].id&&e.publisherId===publishers[1].id),scores:[0,1,2,0,1,2,0,1,2,1]};delete legacy.scaleMax;delete legacy.rubricVersion;delete legacy.responseScore;delete legacy.questionVersion;replaceForm(legacy);
 assert.equal(Number(sql(`select public.textos_presentation_scores('${JSON.stringify(legacy.scores)}'::jsonb,2,true)`)),50);
 const reopened=await ok('presentation_reopen',{evaluationId:legacy.id,reason:'Conservar rúbrica histórica antes de una nueva revisión.'});assert.equal(reopened.scaleMax,undefined);assert.deepEqual(reopened.scores,legacy.scores);assert.equal(reopened.status,'draft');
 const row=(await ok('presentation_summary',{area:'MAT',block:'P1'})).ranked.find(e=>e.publisherId===publishers[1].id);assert.equal(row.pendingScaleUpdate,1);assert.equal(row.drafts,1);assert.equal(row.closed,4);
 await reject('presentation_save',fields(publishers[1].id,scoreArray(40),reopened.version),teachers[1].code,409);
 const restarted=await ok('presentation_restart_scale',{scaleMax:4,rubricVersion:2,evaluationId:reopened.id,expectedVersion:reopened.version},teachers[1].code);assert.equal(restarted.scaleMax,4);assert.deepEqual(restarted.scores,Array(10).fill(null));
});
await check('I11 acepta cero y cuatro sin vincularse a una versión; pendiente todavía impide cerrar',async()=>{
 let draft=(await ok('snapshot')).state.presentationEvaluations.find(e=>e.teacherId===teachers[1].id&&e.publisherId===publishers[1].id);
 for(const invalid of [-1,5,1.5])await reject('presentation_save',{...fields(draft.publisherId,scoreArray(40),draft.version),responseScore:invalid},teachers[1].code,400);
 for(const invalid of [-1,0,1.5,'2',{}])await reject('presentation_save',{...fields(draft.publisherId,scoreArray(40),draft.version),questionVersion:invalid},teachers[1].code,400);
 const absent=fields(draft.publisherId,scoreArray(40),draft.version);delete absent.responseScore;await reject('presentation_save',absent,teachers[1].code,400);
 draft=await ok('presentation_save',{...fields(draft.publisherId,scoreArray(40),draft.version),responseScore:null},teachers[1].code);
 await reject('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:draft.id,expectedVersion:draft.version},teachers[1].code,400);
 draft=await ok('presentation_save',{...fields(draft.publisherId,scoreArray(40),draft.version),questionVersion:99},teachers[1].code);
 assert.equal(draft.questionVersion,99);
 const zero=await ok('presentation_save',{...fields(draft.publisherId,scoreArray(40),draft.version),responseScore:0,questionVersion:null},teachers[1].code);
 closeTo(Number(sql(`select public.textos_presentation_score_of(${sqlJson(zero)},true)`)),40*100/44);
 const four=await ok('presentation_save',{...fields(draft.publisherId,scoreArray(40),zero.version),responseScore:4},teachers[1].code);
 assert.equal(Number(sql(`select public.textos_presentation_score_of(${sqlJson(four)},true)`)),100);
 await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:four.id,expectedVersion:four.version},teachers[1].code);
});
await check('una ficha anterior de diez criterios mantiene su porcentaje hasta ampliarla explícitamente, sin borrar sus diez valoraciones',async()=>{
 const current=(await ok('snapshot')).state.presentationEvaluations.find(e=>e.teacherId===teachers[0].id&&e.publisherId===publishers[2].id);
 const previous={...current,scores:Array(10).fill(2),version:current.version+1};delete previous.rubricVersion;delete previous.responseScore;delete previous.questionVersion;replaceForm(previous);
 assert.equal(Number(sql(`select public.textos_presentation_score_of(${sqlJson(previous)},true)`)),50);
 let summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.ranked.find(e=>e.publisherId===previous.publisherId).closed,4);assert.equal(summary.ranked.find(e=>e.publisherId===previous.publisherId).pendingQuestionUpdate,1);
 const exported=await ok('backup_get');assert.deepEqual(exported.state.presentationEvaluations.find(e=>e.id===previous.id),previous);
 await reject('presentation_save',fields(previous.publisherId,scoreArray(40),previous.version),teachers[0].code,409);
 const payload={evaluationId:previous.id,expectedVersion:previous.version,rubricVersion:2};
 await reject('presentation_enable_question',payload,teachers[1].code,403);await reject('presentation_enable_question',payload,director,403);
 await reject('presentation_enable_question',{...payload,expectedVersion:previous.version-1},teachers[0].code,409);
 const enabled=await ok('presentation_enable_question',payload,teachers[0].code);
 assert.equal(enabled.id,previous.id);assert.equal(enabled.version,previous.version+1);assert.deepEqual(enabled.scores,previous.scores);assert.deepEqual(enabled.notes,previous.notes);assert.equal(enabled.generalObservation,previous.generalObservation);assert.equal(enabled.responseScore,null);assert.equal(enabled.questionVersion,null);assert.equal(enabled.rubricVersion,2);assert.equal(enabled.status,'draft');assert.equal(enabled.closedAt,null);
 const history=JSON.parse(sql(`select jsonb_agg(previous) from public.textos_history where entity='presentationEvaluations' and reference_id='${previous.id}'`));assert.ok(history.some(item=>JSON.stringify(item)===JSON.stringify(previous)));
 await reject('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:enabled.id,expectedVersion:enabled.version},teachers[0].code,400);
 const saved=await ok('presentation_save',fields(enabled.publisherId,enabled.scores,enabled.version),teachers[0].code);
 const closed=await ok('presentation_close',{scaleMax:4,rubricVersion:2,evaluationId:saved.id,expectedVersion:saved.version},teachers[0].code);
 closeTo(Number(sql(`select public.textos_presentation_score_of(${sqlJson(closed)},true)`)),24*100/44);
 await reject('presentation_enable_question',{evaluationId:closed.id,expectedVersion:closed.version,rubricVersion:2},teachers[0].code,409);
});
console.log(`${count} pruebas de presentación SQL/HTTP aprobadas.`);
