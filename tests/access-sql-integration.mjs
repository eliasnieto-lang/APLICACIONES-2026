import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { demoState } from '../shared/defaults.ts';
const db=process.env.ACCESS_DB, url=process.env.ACCESS_URL;
const directorPassword=process.env.TEXTOS_TEST_DIRECTOR_PASSWORD;
if (!/^textos-access-[0-9]+-db$/.test(db ?? '') || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url ?? '')) throw Error('Use scripts/test-access-db.sh with its isolated local stack.');
if (!directorPassword) throw Error('Provide TEXTOS_TEST_DIRECTOR_PASSWORD privately for the seeded database.');
const env={...process.env}; for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']) delete env[k];
const docker=(...args)=>execFileSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const sql=s=>docker('exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-Atc',s);
let count=0;
const check=async(name,fn)=>{await fn();console.log(`✓ ${++count} ${name}`)};
async function rpc(action,payload={},code=null,dataset='demo'){
 const r=await fetch(`${url}/rpc/textos_api`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:dataset})});
 const body=await r.json();return {status:r.status,body};
}
const profile=(firstNames,lastNames='Pérez')=>({firstNames,lastNames,area:'MAT',categories:['P2','P1']});
let director,ana,bea;
for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
await check('Subdirección valida contraseña en servidor y entrega bearer opaco',async()=>{
 const r=await rpc('director_login',{password:directorPassword}); assert.equal(r.status,200);director=r.body.code;assert.match(director,/^[a-f0-9]{64}$/);assert.equal(r.body.snapshot.actor.role,'coordinator');
 assert.equal(sql(`select count(*) from public.textos_access where code_hash='${director}'`),'0');
});
await check('fallos HTTP401 persisten y cinco fallos bloquean temporalmente',async()=>{
 for(let i=1;i<=5;i++){const r=await rpc('director_login',{password:'incorrecta'});assert.equal(r.status,401);assert.equal(r.body.error.code,'PT401');assert.equal(sql("select failures from public.textos_login_limits where dataset='demo'"),String(i));}
 assert.equal((await rpc('director_login',{password:directorPassword})).status,429);
 sql("update public.textos_login_limits set blocked_until=now()-interval '1 second' where dataset='demo'");
 assert.equal((await rpc('director_login',{password:directorPassword})).status,200); assert.equal(sql("select failures from public.textos_login_limits where dataset='demo'"),'0');
 assert.equal((await rpc('director_login',{password:4})).status,401);assert.equal(sql("select failures from public.textos_login_limits where dataset='demo'"),'1');
});
await check('registro sin correo/contraseña normaliza nombres y categorías',async()=>{
 const r=await rpc('teacher_register',profile('  Ana   María  ',' Pérez  Torres '));assert.equal(r.status,200,JSON.stringify(r.body));ana=r.body;assert.equal(ana.snapshot.actor.role,'teacher');assert.equal(ana.snapshot.state.teachers.length,1);const t=ana.snapshot.state.teachers[0];assert.equal(t.name,'Pérez Torres Ana María');assert.deepEqual(t.categories,['P1','P2']);assert.equal(t.selfRegistered,true);assert.equal(ana.snapshot.state.reviews.length,0);
});
await check('más de dos docentes se registran sin cupo',async()=>{
 for(const name of ['Beatriz','Carla','Diana','Elena']){const r=await rpc('teacher_register',profile(name));assert.equal(r.status,200);if(name==='Beatriz')bea=r.body;}
 assert.equal(sql("select jsonb_array_length(state->'teachers') from public.textos_datasets where id='demo'"),'5');
});
await check('nombre canónico duplicado no revela registros ni fichas',async()=>{
 const r=await rpc('teacher_register',profile('ana  maria','perez torres'));assert.equal(r.status,409);assert.match(r.body.message,/enlace privado/);assert.equal(sql("select jsonb_array_length(state->'teachers') from public.textos_datasets where id='demo'"),'5');
});
await check('perfil valida campos obligatorios área y categorías en servidor',async()=>{
 const base=profile('Julia');for(const patch of [{firstNames:''},{lastNames:null},{firstNames:'123'},{area:'SCI'},{categories:[]},{categories:['P1','P1']},{categories:['P3']},{categories:'P1'}])assert.equal((await rpc('teacher_register',{...base,...patch})).status,400);
});
await check('sesión propia actualiza perfil e impide asumir nombre de colega',async()=>{
 const id=ana.snapshot.actor.id;const r=await rpc('teacher_register',{...profile('Ana María','Pérez Torres'),area:'COM',categories:['S1']},ana.code);assert.equal(r.status,200);assert.equal(r.body.snapshot.actor.id,id);assert.deepEqual(r.body.snapshot.state.teachers[0].categories,['S1']);assert.equal(r.body.code,ana.code);
 const duplicate=await rpc('teacher_register',profile('Beatriz'),ana.code);assert.equal(duplicate.status,409);const snapshot=await rpc('snapshot',{},ana.code);assert.equal(snapshot.body.state.teachers.length,1);assert.equal(snapshot.body.state.teachers[0].area,'COM');assert.equal(snapshot.body.state.audit.length,0);
});
await check('código inválido o de otro dataset nunca crea otro docente',async()=>{
 assert.equal((await rpc('teacher_register',profile('Francisca'),'invalid')).status,401);assert.equal((await rpc('teacher_register',profile('Francisca'),ana.code,'real')).status,401);assert.equal((await rpc('teacher_register',profile('Francisca'),director)).status,401);
});
await check('sesión vencida/revocada se rechaza',async()=>{
 sql(`update public.textos_access set revoked=true where code_hash=public.textos_hash('${bea.code}')`);assert.equal((await rpc('teacher_register',profile('Beatriz'),bea.code)).status,401);
 sql(`update public.textos_access set revoked=false,expires_at=now()-interval '1 second' where code_hash=public.textos_hash('${bea.code}')`);assert.equal((await rpc('teacher_register',profile('Beatriz'),bea.code)).status,401);
});
await check('registro legado requiere enlace privado y conserva identidad/historial',async()=>{
 const saved=await rpc('teacher_save',{teacher:{id:'',version:1,name:'Lucía Sánchez',attended:true,attendanceEvidence:'Legado'}},director);assert.equal(saved.status,200);
 assert.equal((await rpc('teacher_register',profile('Lucia','Sanchez'))).status,409);
 const link=await rpc('access_create',{role:'teacher',teacherId:saved.body.id},director);assert.equal(link.status,200);
 const attached=await rpc('teacher_register',profile('Lucía','Sánchez'),link.body.code);assert.equal(attached.status,200);assert.equal(attached.body.snapshot.actor.id,saved.body.id);assert.equal(attached.body.snapshot.state.teachers[0].attendanceEvidence,'Legado');
 assert.ok(Number(sql(`select count(*) from public.textos_history where reference_id='${saved.body.id}'`))>=1);
});
await check('JWT de coordinación no amplía snapshot del registro docente',async()=>{
 const payload=JSON.stringify({...profile('Graciela'),teacherId:ana.snapshot.actor.id,role:'coordinator'});
 const result=sql(`begin;select set_config('request.jwt.claims','{"sub":"b5f3904c-4557-4779-9879-33068ae28fa8"}',true);select public.textos_api('teacher_register','${payload}'::jsonb,null,'demo');rollback;`).split('\n').find(l=>l.startsWith('{"code"')||l.includes('"snapshot"'));
 const parsed=JSON.parse(result);assert.equal(parsed.snapshot.actor.role,'teacher');assert.equal(parsed.snapshot.state.teachers.length,1);assert.notEqual(parsed.snapshot.actor.id,ana.snapshot.actor.id);
});
await check('tablas de credenciales y helpers no se exponen por HTTP',async()=>{
 for(const path of ['/textos_director_credentials?select=*','/textos_login_limits?select=*'])assert.ok([401,403,404].includes((await fetch(url+path)).status));
 const r=await fetch(url+'/rpc/textos_password_hash',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'x',salt:'00'.repeat(32),iterations:120000})});assert.ok([401,403,404].includes(r.status));
});
await check('reaplicar migración conserva fichas históricas y de exposición, accesos, historial, hash y límite',async()=>{
 const seeded=await rpc('demo_reset',{state:demoState()},director);assert.equal(seeded.status,200);
 assert.ok(Number(sql("select jsonb_array_length(state->'evaluations') from public.textos_datasets where id='demo'"))>0);
 assert.ok(Number(sql("select jsonb_array_length(state->'presentationEvaluations') from public.textos_datasets where id='demo'"))>0);
 const before=sql("select jsonb_build_object('state',(select state from public.textos_datasets where id='demo'),'credential',(select to_jsonb(t) from public.textos_director_credentials t where dataset='demo'),'limits',(select to_jsonb(t) from public.textos_login_limits t where dataset='demo'),'access',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_access t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))");
 const migration=readFileSync(new URL('../supabase/migrations/002-acceso-directo.sql',import.meta.url));
 assert.equal(migration.toString(),readFileSync(new URL('../supabase/schema.sql',import.meta.url)).toString());
 execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','-i',db,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres'],{env,input:migration,stdio:['pipe','pipe','pipe']});
 const after=sql("select jsonb_build_object('state',(select state from public.textos_datasets where id='demo'),'credential',(select to_jsonb(t) from public.textos_director_credentials t where dataset='demo'),'limits',(select to_jsonb(t) from public.textos_login_limits t where dataset='demo'),'access',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_access t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))");assert.equal(after,before);
});
console.log(`${count} pruebas de acceso SQL/HTTP aprobadas.`);
