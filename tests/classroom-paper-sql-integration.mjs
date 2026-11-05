import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const db=process.env.TEXTOS_TEST_DB_CONTAINER,url=process.env.TEXTOS_TEST_REST_URL;
assert.ok(db&&url,'Ejecute con scripts/test-classroom-paper-db.sh en un entorno descartable.');
assert.match(db,/^textos-classroom-paper-[0-9]+-db$/);assert.match(url,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
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
state.teachers=['MAT','COM'].map(area=>({id:`paper-teacher-${area}`,version:1,name:`Docente ${area}`,firstNames:'Docente',lastNames:area,area,categories:['P1','P2','S1'],attended:true,attendanceEvidence:''}));
state.presentationDraw={id:'paper-draw',version:1,publishers:state.publishers.map(({id,name})=>({id,name})),completedPublisherIds:state.publishers.map(p=>p.id),createdAt:'2026-11-04T15:00:00Z',createdBy:'Subdirección'};
state.turn={publisherId:state.publishers[2].id,status:'finished',startedAt:'2026-11-04T15:00:00Z',pausedAt:'2026-11-04T15:10:00Z',pausedMilliseconds:0};
state.presentationEvaluations=state.teachers.flatMap(t=>t.categories.flatMap(block=>state.publishers.map((p,i)=>({id:`paper-evaluation-${t.area}-${block}-${i}`,version:1,publisherId:p.id,teacherId:t.id,area:t.area,block,scores:Array(10).fill(4-i),scaleMax:4,rubricVersion:2,responseScore:4-i,questionVersion:1,notes:Array(10).fill(''),generalObservation:'',physicalText:'',status:'closed',closedAt:'2026-11-04T15:10:00Z',updatedAt:'2026-11-04T15:10:00Z',rulesVersion:1}))));
sql(`update public.textos_datasets set state=${asSql(state)} where id='demo'`);
director=sql("select public.textos_bootstrap_local('demo')");
const teacherCode=sql("select public.textos_code()");
sql(`insert into public.textos_access(dataset,code_hash,role,teacher_id,name,expires_at) values('demo',public.textos_hash('${teacherCode}'),'teacher','paper-teacher-MAT','Docente MAT',now()+interval '1 day')`);
const getPoll=async()=>((await ok('snapshot')).state.paperPolls.find(p=>p.id===poll.id));
const room=(id,p=poll)=>p.classrooms.find(c=>c.id===id);
const choose=(mat=state.publishers[0].id,com=state.publishers[1].id)=>({MAT:mat,COM:com});
const cast=(id,choices=choose(),version=poll.version)=>ok('paper_manual_cast',{pollId:poll.id,classroomId:id,choices,expectedVersion:version,confirmation:true});
let oldBackup,correctedBefore;
await check('el servidor construye exactamente cinco secciones por grado y folios cortos sin duplicados',async()=>{
 for(const [block,count]of[['P1',10],['P2',20],['S1',15]]){
  const classrooms=JSON.parse(sql(`select public.textos_paper_classrooms('${block}')`));assert.equal(classrooms.length,count);assert.equal(new Set(classrooms.map(c=>c.id)).size,count);assert.equal(new Set(classrooms.map(c=>c.folio)).size,count);assert.equal(classrooms[0].folio,`${block}-01`);assert.equal(classrooms.at(-1).folio,`${block}-${count}`);
  for(const gradeId of new Set(classrooms.map(c=>c.gradeId)))assert.deepEqual(classrooms.filter(c=>c.gradeId===gradeId).map(c=>c.section),['A','B','C','D','E']);
 }
});
await check('solo Subdirección administra asistencia, transcripción y correcciones',async()=>{
 for(const action of['paper_attendance_save','paper_manual_cast','paper_manual_correct']){await reject(action,{},401,null);await reject(action,{},403,teacherCode);}
 const privateHelper=sql("select has_function_privilege('anon','public.textos_paper_public(jsonb)','EXECUTE')");assert.equal(privateHelper,'f');
});
await check('nuevas votaciones crean padrón proporcional de 10,20 y15 aulas y congelan ambas áreas',async()=>{
 ranking=await ok('presentation_ranking_generate',{expectedVersion:0});
 for(const [block,count]of[['P1',10],['P2',20],['S1',15]]){
  const created=await ok('paper_poll_create',{block,areas:['MAT','COM'],rankingId:ranking.id,expectedRankingVersion:ranking.version});assert.equal(created.classrooms.length,count);assert.equal(created.rosterVersion,1);assert.equal(created.generated,0);assert.equal(created.received,0);assert(created.classrooms.every(c=>c.attendance==='pending'&&!c.received&&!c.ballotIssued));if(block==='P1')poll=created;
 }
 assert.equal(room('PRI1-A').label,'1.º de primaria · A');
});
await check('asistencia exige versión actual y un aula de la categoría correcta',async()=>{
 await reject('paper_attendance_save',{pollId:poll.id,classroomId:'PRI1-A',attendance:'present',expectedVersion:0},409);
 await reject('paper_attendance_save',{pollId:poll.id,classroomId:'SEC1-A',attendance:'present',expectedVersion:poll.version});
 await reject('paper_attendance_save',{pollId:poll.id,classroomId:'PRI1-A',attendance:'unknown',expectedVersion:poll.version});
 poll=await ok('paper_attendance_save',{pollId:poll.id,classroomId:'PRI1-E',attendance:'absent',expectedVersion:poll.version});assert.equal(room('PRI1-E').attendance,'absent');
});
await check('el lote genera una ficha por aula elegible y devuelve solo folios cortos y etiquetas',async()=>{
 const batch=await ok('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version});poll=batch.poll;codes=batch.codes;assert.equal(codes.length,9);assert.equal(poll.generated,9);assert.equal(batch.ballots.length,9);assert(codes.every(c=>/^P1-\d{2}$/.test(c)));assert(!codes.includes('P1-05'));assert(batch.ballots.every(b=>b.classroomLabel===room(b.classroomId).label&&b.folio===room(b.classroomId).folio&&!b.code));
 assert.equal(Number(sql(`select count(*) from public.textos_paper_tokens where poll_id='${poll.id}'`)),9);
 await reject('paper_scan_cast',{pollId:poll.id,code:'0'.repeat(64),choices:choose()},423);
});
await check('no hay conteo arbitrario ni nuevas fichas duplicadas; reimprimir conserva folio y cantidad',async()=>{
 await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,count:200});
 await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version},423);
 for(const classroomIds of[['PRI1-A','PRI1-A'],['SEC1-A'],[]])await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,classroomIds});
 const batch=await ok('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,classroomIds:['PRI1-A']});poll=batch.poll;assert.deepEqual(batch.codes,['P1-01']);assert.equal(poll.generated,9);assert.equal(Number(sql(`select count(*) from public.textos_paper_tokens where poll_id='${poll.id}'`)),9);
});
await check('Sin asistencia impide imprimir y votar sin inventar blancos ni nulos',async()=>{
 await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,classroomIds:['PRI1-E']},423);
 await reject('paper_manual_cast',{pollId:poll.id,classroomId:'PRI1-E',choices:choose(),expectedVersion:poll.version,confirmation:true},423);assert.equal((await getPoll()).received,0);
});
await check('transcribir requiere confirmar ambas áreas y acepta solo alternativas de esta votación',async()=>{
 await reject('paper_manual_cast',{pollId:poll.id,classroomId:'PRI1-A',choices:choose(),expectedVersion:poll.version,confirmation:false});
 await reject('paper_manual_cast',{pollId:poll.id,classroomId:'PRI1-A',choices:{MAT:state.publishers[0].id},expectedVersion:poll.version,confirmation:true});
 await reject('paper_manual_cast',{pollId:poll.id,classroomId:'PRI1-A',choices:{MAT:'unknown',COM:null},expectedVersion:poll.version,confirmation:true});
 poll=(await cast('PRI1-A')).poll;assert.equal(poll.received,1);assert.equal(poll.generated,9);assert.equal(room('PRI1-A').attendance,'present');assert.equal(room('PRI1-A').voteVersion,1);assert.deepEqual(room('PRI1-A').choices,choose());assert(room('PRI1-A').recordedAt);
});
await check('un aula ya recibida no se vuelve a emitir ni contabilizar',async()=>{
 await reject('paper_manual_cast',{pollId:poll.id,classroomId:'PRI1-A',choices:choose(),expectedVersion:poll.version,confirmation:true},409);
 await reject('paper_ballots_generate',{pollId:poll.id,expectedVersion:poll.version,classroomIds:['PRI1-A']},409);assert.equal((await getPoll()).received,1);
});
await check('la transcripción directa por folio funciona sin PDF previo y conserva blanco y nulo',async()=>{
 poll=await ok('paper_attendance_save',{pollId:poll.id,classroomId:'PRI1-E',attendance:'present',expectedVersion:poll.version});
 poll=(await ok('paper_manual_cast',{pollId:poll.id,folio:'p1-05',choices:{MAT:null,COM:'__invalid__'},expectedVersion:poll.version,confirmation:true})).poll;
 assert.equal(poll.generated,10);assert.equal(poll.received,2);assert.equal(poll.counts.MAT.blank,1);assert.equal(poll.counts.COM.invalid,1);assert.equal(room('PRI1-E').received,true);
});
await check('dos transcripciones simultáneas de una misma aula suman solo una vez',async()=>{
 const payload={pollId:poll.id,classroomId:'PRI1-B',choices:choose(),expectedVersion:poll.version,confirmation:true};const replies=await Promise.all([rpc('paper_manual_cast',payload),rpc('paper_manual_cast',payload)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);poll=await getPoll();assert.equal(poll.received,3);
});
await check('la tabla pública muestra el voto por aula, conserva blancos explícitos y excluye secretos',async()=>{
 const publicState=(await ok('public_snapshot',{},null)).state;const published=publicState.paperPolls.find(p=>p.id===poll.id);assert(published);assert.deepEqual(room('PRI1-A',published).choices,choose());assert.equal(room('PRI1-E',published).choices.MAT,null);assert(Object.hasOwn(room('PRI1-E',published).choices,'MAT'));assert.equal(room('PRI2-A',published).choices,undefined);
 const text=JSON.stringify(publicState);assert(!text.includes('code_hash'));assert(!text.includes('paperTokens'));assert(!text.includes('teacher-MAT'));assert(!text.includes('evidencePrivate'));assert(!text.includes('representativeNameSecret'));
 const malformed=structuredClone(poll);malformed.evidencePrivate='do-not-expose';malformed.classrooms[0].representativeNameSecret='parent-name-private';const publicOnly=JSON.parse(sql(`select public.textos_paper_public(${asSql([malformed])})`));assert(!JSON.stringify(publicOnly).includes('do-not-expose'));assert(!JSON.stringify(publicOnly).includes('parent-name-private'));
});
await check('corregir exige motivo y versión del voto; sustituye opciones sin agregar fichas',async()=>{
 const initial=room('PRI1-A');const payload={pollId:poll.id,classroomId:initial.id,choices:{MAT:state.publishers[2].id,COM:null},expectedVersion:poll.version,expectedVoteVersion:initial.voteVersion,reason:'Corrección cotejada con la ficha en papel'};
 await reject('paper_manual_correct',{...payload,reason:'corto'});await reject('paper_manual_correct',{...payload,expectedVoteVersion:0},409);
 const before=structuredClone(poll);poll=(await ok('paper_manual_correct',payload)).poll;assert.equal(poll.generated,before.generated);assert.equal(poll.received,before.received);assert.equal(room('PRI1-A').voteVersion,2);assert.equal(room('PRI1-A').recordedAt,initial.recordedAt);assert(room('PRI1-A').correctedAt);assert.equal(poll.counts.MAT.options[state.publishers[0].id],before.counts.MAT.options[state.publishers[0].id]-1);assert.equal(poll.counts.MAT.options[state.publishers[2].id],1);assert.equal(poll.counts.COM.blank,1);
 const history=JSON.parse(sql(`select jsonb_agg(previous) from public.textos_history where entity='paperClassroomVotes' and reference_id='${poll.id}:PRI1-A'`));assert(history.some(c=>c.voteVersion===1&&c.choices.MAT===state.publishers[0].id));
});
await check('correcciones concurrentes no sobrescriben un voto ya actualizado',async()=>{
 const payload={pollId:poll.id,classroomId:'PRI1-A',choices:choose(),expectedVersion:poll.version,expectedVoteVersion:2,reason:'Rectificación cotejada ante representantes'};
 const replies=await Promise.all([rpc('paper_manual_correct',payload),rpc('paper_manual_correct',{...payload,choices:{MAT:null,COM:null}})]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);poll=await getPoll();assert.equal(poll.received,3);assert.equal(room('PRI1-A').voteVersion,3);
});
await check('un aula con voto no puede convertirse en Sin asistencia',async()=>{
 for(const attendance of['absent','pending'])await reject('paper_attendance_save',{pollId:poll.id,classroomId:'PRI1-A',attendance,expectedVersion:poll.version},423);
 poll=await ok('paper_attendance_save',{pollId:poll.id,classroomId:'PRI2-E',attendance:'absent',expectedVersion:poll.version});assert.equal(room('PRI2-E').attendance,'absent');assert.equal(poll.generated,10);assert.equal(poll.received,3);
});
await check('el respaldo actual conserva aulas, correcciones y registros usados al restaurarse',async()=>{
 backup=await ok('backup_get');assert.equal(backup.paperTokens.filter(t=>t.poll_id===poll.id).length,10);assert.equal(backup.paperTokens.filter(t=>t.poll_id===poll.id&&t.consumed).length,3);
 await ok('restore_preview',{backup});await ok('restore_apply',{backup,confirmation:'RESTAURAR',reason:'Prueba de restauración de padrón y votos por aula'});poll=await getPoll();assert.equal(room('PRI1-A').voteVersion,3);assert.equal(poll.received,3);oldBackup=backup;
});
await check('el respaldo no puede alterar aula, conteo ni la atribución de una ficha',async()=>{
 const changed=structuredClone(backup);changed.state.paperPolls.find(p=>p.id===poll.id).classrooms[0].choices.MAT='unknown';await reject('restore_preview',{backup:changed});
 const missing=structuredClone(backup);missing.paperTokens=missing.paperTokens.slice(1);await reject('restore_preview',{backup:missing},409);
 const moved=structuredClone(backup);const token=moved.paperTokens.find(t=>t.poll_id===poll.id&&t.classroom_id==='PRI1-A');token.classroom_id='PRI1-B';await reject('restore_preview',{backup:moved});
});
await check('un respaldo anterior no puede deshacer una corrección aunque conserve el total de votos',async()=>{
 const old=room('PRI1-A');poll=(await ok('paper_manual_correct',{pollId:poll.id,classroomId:old.id,choices:{MAT:state.publishers[1].id,COM:state.publishers[2].id},expectedVersion:poll.version,expectedVoteVersion:old.voteVersion,reason:'Cotejo final del voto original en papel'})).poll;
 await reject('restore_preview',{backup:oldBackup},409);assert.equal((await getPoll()).received,3);
});
await check('validar el padrón detecta aulas, folios o conteos manipulados',async()=>{
 for(const corrupt of[
  p=>{p.classrooms[0].folio='P1-99'},p=>{p.classrooms[0].id='SEC1-A'},p=>{p.classrooms[0].choices.COM='unknown'},p=>{p.counts.MAT.blank+=1},
 ]){const broken=structuredClone(poll);corrupt(broken);assert.throws(()=>sql(`select public.textos_paper_validate(jsonb_build_object('paperPolls',${asSql([broken])}))`));}
});
await check('cerrar publica el resultado y deja bloqueadas transcripciones, asistencia y correcciones',async()=>{
 poll=await ok('paper_poll_close',{pollId:poll.id,expectedVersion:poll.version});assert.equal(poll.status,'closed');assert(poll.results.MAT.state);const choices=choose();
 for(const [action,payload]of[['paper_manual_cast',{classroomId:'PRI2-A',choices,confirmation:true}],['paper_attendance_save',{classroomId:'PRI2-A',attendance:'absent'}],['paper_manual_correct',{classroomId:'PRI1-A',choices,expectedVoteVersion:room('PRI1-A').voteVersion,reason:'No modifica un acta ya cerrada'}]])await reject(action,{pollId:poll.id,expectedVersion:poll.version,...payload},423);
 const published=(await ok('public_snapshot',{},null)).state.paperPolls.find(p=>p.id===poll.id);assert.deepEqual(published.counts,poll.counts);assert.deepEqual(room('PRI1-A',published).choices,room('PRI1-A').choices);
});
await check('repetir el esquema no modifica padrón, folios, votos, correcciones ni tokens',async()=>{
 const before=sql("select jsonb_build_object('state',(select state from public.textos_datasets where id='demo'),'tokens',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_paper_tokens t where dataset='demo'),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t where dataset='demo'))");
 const input=await import('node:fs').then(fs=>fs.readFileSync(new URL('../supabase/schema.sql',import.meta.url)));execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres'],{env,input,stdio:['pipe','pipe','pipe']});
 assert.equal(sql("select jsonb_build_object('state',(select state from public.textos_datasets where id='demo'),'tokens',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_paper_tokens t where dataset='demo'),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t where dataset='demo'))"),before);
});
console.log(`PASS ${checks}/${checks} grupos SQL/HTTP de padrón, voto manual y cotejo público por aula`);
