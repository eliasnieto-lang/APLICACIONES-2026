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
const scoreArray=total=>Array.from({length:10},()=>{const value=Math.min(2,total);total-=value;return value;});
const fields=(publisherId,scores,expectedVersion=0)=>({publisherId,area:'MAT',block:'P1',scores,notes:Array(10).fill(''),physicalText:'',generalObservation:'',expectedVersion});
let director,first,backup,published;const teachers=[],publishers=[];const totals=[[20,10,16,14,18],[20,14,16,16,18],[20,16,18,18,18]];
for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
director=sql("select public.textos_bootstrap_local('demo')");
await check('cinco docentes en un bloque sin asignaciones ni libros precargados',async()=>{
 for(let i=0;i<5;i++){const body=await ok('teacher_register',{firstNames:['Ana','Beatriz','Carla','Diana','Elena'][i],lastNames:'Presentación',area:'MAT',categories:['P1']},null);teachers.push({code:body.code,id:body.snapshot.actor.id});}
 for(let i=0;i<3;i++)publishers.push(await ok('publisher_save',{publisher:{id:'',version:1,name:`Editorial en vivo ${i+1}`,samplesReceived:false,sampleNote:''}}));
 const s=(await ok('snapshot')).state;assert.equal(s.teachers.length,5);assert.equal(s.books.length,0);assert.equal(s.assignments.length,0);assert.equal(s.offers.length,0);assert.equal(s.presentationEvaluations.length,0);
});
await check('la ficha empieza pendiente y el primer guardado fija reglas sin datos de expediente',async()=>{
 first=await ok('presentation_save',fields(publishers[0].id,Array(10).fill(null)),teachers[0].code);assert.equal(first.version,1);assert.equal(first.status,'draft');assert.deepEqual(first.scores,Array(10).fill(null));assert.equal(first.physicalText,'');
 await reject('presentation_close',{evaluationId:first.id,expectedVersion:first.version},teachers[0].code,400);
 const s=(await ok('snapshot')).state;assert.ok(s.settings.rules.lockedAt);assert.equal(s.settings.version,2);
});
await check('autoría y perfil se verifican en servidor; no se acepta una ficha de colega',async()=>{
 await reject('presentation_save',{...fields(publishers[0].id,scoreArray(20)),area:'COM'},teachers[0].code,403);
 await reject('presentation_save',{...fields(publishers[0].id,scoreArray(20)),block:'S1'},teachers[0].code,403);
 await reject('presentation_close',{evaluationId:first.id,expectedVersion:1},teachers[1].code,403);
 await reject('presentation_save',fields('missing',scoreArray(20)),teachers[0].code,403);
 await reject('presentation_summary',{},teachers[0].code,403);
 await reject('presentation_save',fields(publishers[0].id,scoreArray(20)),director,403);
});
await check('CAS impide sobrescribir y puntajes fraccionarios o fuera de rango se rechazan',async()=>{
 for(const expectedVersion of [undefined,null,0])await reject('presentation_save',{...fields(publishers[0].id,scoreArray(20)),expectedVersion},teachers[0].code,409);
 for(const bad of [-1,3,1.5])await reject('presentation_save',{...fields(publishers[0].id,[bad,...Array(9).fill(2)],1)},teachers[0].code,400);
 await reject('presentation_save',{...fields(publishers[0].id,Array(9).fill(2),1)},teachers[0].code,400);
});
await check('todas las fichas cierran con diez enteros; no exige OBNATE, precio, carga ni notas',async()=>{
 for(let p=0;p<3;p++)for(let i=0;i<5;i++){
  const payload=fields(publishers[p].id,scoreArray(totals[p][i]),p===0&&i===0?1:0);
  if(p===0&&i===0){payload.notes[0]='OBSERVACIÓN PERSONAL SECRETA';payload.generalObservation='COMENTARIO PERSONAL SECRETO';payload.teacherId=teachers[1].id;}
  const saved=await ok('presentation_save',payload,teachers[i].code);assert.equal(saved.teacherId,teachers[i].id);
  const closed=await ok('presentation_close',{evaluationId:saved.id,expectedVersion:saved.version},teachers[i].code);assert.equal(closed.status,'closed');
  if(p===0&&i===0)first=closed;
  if(p===0&&i===2){const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,5);assert.equal(summary.ranked[0].closed,3);assert.equal(summary.ranked[0].pending,2);assert.ok(Math.abs(summary.ranked[0].score-(100+50+80)/3)<1e-10);}
 }
 await reject('presentation_save',fields(publishers[0].id,scoreArray(18),first.version),teachers[0].code,423);
 const s=(await ok('snapshot')).state;assert.equal(s.presentationEvaluations.length,15);assert.equal(s.evaluations.length,0);assert.equal(s.books.length,0);
});
await check('el promedio incluye a los cinco docentes y los conteos no tienen cupo de dos',async()=>{
 const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,5);assert.equal(summary.closed,15);assert.equal(summary.pending,0);assert.equal(summary.state,'ready');
 for(const [p,score]of [[0,78],[1,84],[2,90]]){const row=summary.ranked.find(q=>q.publisherId===publishers[p].id);assert.equal(row.closed,5);assert.equal(row.score,score);}
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
await check('una o dos editoriales aptas no se convierten en una terna formal',async()=>{
 for(const [threshold,eligible]of [[85,1],[80,2]]){
  sql(`update public.textos_datasets set state=jsonb_set(state,'{settings,rules,threshold}','${threshold}'::jsonb) where id='demo'`);
  const summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.state,'less_than_three');assert.equal(summary.finalists.length,eligible);
  await reject('presentation_shortlist_publish',{area:'MAT',block:'P1',directorApproved:true,statement:'No completar con editoriales no aptas.',folio:'F-INCOMPLETA'},director,423);
 }
 sql("update public.textos_datasets set state=jsonb_set(state,'{settings,rules,threshold}','70'::jsonb) where id='demo'");
});
await check('la publicación formal exige tres elegibles y publica agregados sin fichas individuales',async()=>{
 await reject('presentation_shortlist_publish',{area:'COM',block:'P1',directorApproved:true,statement:'Prueba',folio:'F-0'},director,423);
 published=await ok('presentation_shortlist_publish',{area:'MAT',block:'P1',directorApproved:true,statement:'Apreciación pedagógica conjunta.',folio:'F-1'});assert.equal(published.publisherIds.length,3);
 const pub=(await ok('public_snapshot',{},null)).state;assert.equal(pub.presentationEvaluations.length,0);assert.equal(pub.presentationShortlists.length,1);assert.equal(pub.presentationShortlists[0].snapshot.assessment.ranked[0].closed,5);assert.ok(!JSON.stringify(pub).includes('SECRETO'));assert.ok(!JSON.stringify(pub.presentationShortlists).includes('teacherId'));
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
 await ok('presentation_close',{evaluationId:open.id,expectedVersion:open.version},teachers[0].code);
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
 for(const publisher of publishers){const saved=await ok('presentation_save',fields(publisher.id,scoreArray(18)),sixth.code);await ok('presentation_close',{evaluationId:saved.id,expectedVersion:saved.version},sixth.code);}
 summary=await ok('presentation_summary',{area:'MAT',block:'P1'});assert.equal(summary.registered,6);assert.equal(summary.closed,18);assert.equal(summary.pending,0);
 const republished=await ok('presentation_shortlist_publish',{...publicationPayload,folio:'F-SEIS'});
 await ok('teacher_register',{firstNames:'Flora',lastNames:'Presentación',area:'COM',categories:['S1']},sixth.code);
 s=(await ok('snapshot')).state;assert.equal(s.presentationShortlists.find(q=>q.id===republished.id).status,'superseded');assert.equal(s.presentationEvaluations.length,18);assert.ok(s.presentationEvaluations.filter(e=>e.teacherId===sixth.snapshot.actor.id).every(e=>e.status==='closed'));
 assert.ok(Number(sql(`select count(*) from public.textos_history where entity='presentationShortlists' and reference_id='${republished.id}' and reason='Inscripción/actualización docente' and previous->>'status'='published'`))>=1);
});
console.log(`${count} pruebas de presentación SQL/HTTP aprobadas.`);
