import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const db = process.env.TEXTOS_TEST_DB_CONTAINER;
const url = process.env.TEXTOS_TEST_REST_URL;
if (!/^textos-scale-upgrade-[0-9]+-db$/.test(db ?? '') || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url ?? '')) throw Error('Use scripts/test-scale-migration-db.sh with its isolated local stack.');
const dockerEnv = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env: dockerEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sql = statement => docker('exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-Atc', statement);
const migration = readFileSync(new URL('../supabase/migrations/003-escala-y-filtros.sql', import.meta.url));
assert.equal(createHash('sha256').update(migration).digest('hex'), '63b3ceba39485e17587fd47f5ce8fc519d159d9226797e613335b7c12891af5e');
const applyMigration = () => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env: dockerEnv, input: migration, stdio: ['pipe', 'pipe', 'pipe'] });
let checks = 0;
const check = async (name, operation) => { await operation(); console.log(`✓ ${++checks} ${name}`); };
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch(url)).ok) break; } catch { /* Wait for the isolated API. */ }
  if (attempt >= 60) throw Error('PostgREST did not become ready.');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const director = sql("select public.textos_bootstrap_local('demo')");
async function rpc(action, payload = {}, code = director) {
  const response = await fetch(`${url}/rpc/textos_api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  return { status: response.status, body: await response.json() };
}
async function ok(action, payload = {}, code = director) {
  const result = await rpc(action, payload, code);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const state = async () => (await ok('snapshot')).state;
const teachers = [];
const publishers = [];
let before, oldPublication, baselinePrivate, oldRawBackup;

await check('002 crea cinco docentes y quince fichas cerradas con la escala anterior 0–2', async () => {
  for (const firstNames of ['Ana', 'Beatriz', 'Carla', 'Diana', 'Elena']) teachers.push(await ok('teacher_register', { firstNames, lastNames: 'Histórica', area: 'MAT', categories: ['P1'] }, null));
  for (let index = 0; index < 3; index++) publishers.push(await ok('publisher_save', { publisher: { id: '', version: 1, name: `Editorial histórica ${index + 1}`, samplesReceived: false, sampleNote: '' } }));
  for (const teacher of teachers) for (const publisher of publishers) {
    const form = await ok('presentation_save', { publisherId: publisher.id, area: 'MAT', block: 'P1', scores: Array(10).fill(2), notes: Array(10).fill('Observación original'), physicalText: 'Ejemplar original', generalObservation: 'No cambiar ni reinterpretar', expectedVersion: 0 }, teacher.code);
    await ok('presentation_close', { evaluationId: form.id, expectedVersion: form.version }, teacher.code);
  }
  const settings = (await state()).settings;
  await ok('settings_save', { settings: { ...settings, editorsWithdrawn: true, withdrawalReference: 'ACTA-MIGRACION-003' }, expectedVersion: settings.version });
  oldPublication = await ok('presentation_shortlist_publish', { area: 'MAT', block: 'P1', directorApproved: true, statement: 'Resultado original con escala 0–2', folio: 'ANTERIOR-003' });
  assert.equal(oldPublication.snapshot.assessment.ranked[0].score, 100);
  assert.equal((await state()).presentationEvaluations.length, 15);
});

await check('la instalación previa conserva también una ficha histórica por libro y sus referencias', async () => {
  const publisher = publishers[0].id;
  const teacher = teachers[0].snapshot.actor.id;
  sql(`do $$ declare s jsonb; b jsonb; begin select state into s from public.textos_datasets where id='demo' for update;
    s:=public.textos_put(s,'series',jsonb_build_object('id','legacy-series','version',1,'publisherId','${publisher}','name','Serie histórica'));
    s:=public.textos_put(s,'offers',jsonb_build_object('id','legacy-offer','version',1,'seriesId','legacy-series','area','MAT','block','P1','edition','2027','status','offered','withdrawalReason',''));
    b:=public.textos_blank_book()||jsonb_build_object('id','legacy-book','version',1,'code','LEGACY-003','offerId','legacy-offer','gradeId','PRI1','title','Texto conservado','edition','2027');
    s:=public.textos_put(s,'books',b);
    s:=public.textos_put(s,'assignments',jsonb_build_object('id','legacy-assignment','version',1,'bookId','legacy-book','teacherId','${teacher}','kind','initial','reviewId',null));
    s:=public.textos_put(s,'evaluations',jsonb_build_object('id','legacy-evaluation','version',1,'assignmentId','legacy-assignment','bookId','legacy-book','teacherId','${teacher}','bookVersion',1,'rulesVersion',1,'status','closed','scores','[2,2,2,2,2,2,2,2,2,2]'::jsonb,'evidence',to_jsonb(array_fill('Página histórica'::text,array[10])),'notes',to_jsonb(array_fill('Nota histórica'::text,array[10]))));
    perform public.textos_validate_state(s); update public.textos_datasets set state=s where id='demo'; end $$;`);
  before = await state();
  oldRawBackup = await ok('backup_get');
  baselinePrivate = sql("select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_director_credentials t),'access',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_access t),'limits',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_login_limits t),'ballots',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_ballots t),'aggregates',(select jsonb_agg(to_jsonb(t) order by dataset,round_id,area,option_id) from public.textos_aggregates t))");
});

await check('003 marca la escala histórica sin convertir puntajes ni modificar libros, docentes o credenciales', async () => {
  applyMigration();
  const after = await state();
  assert.equal(after.settings.presentationScaleMax, 4);
  assert.equal(after.settings.version, before.settings.version + 1);
  assert.deepEqual(after.settings.rules, before.settings.rules);
  for (const key of ['publishers', 'teachers', 'series', 'offers', 'books', 'assignments', 'evaluations']) assert.deepEqual(after[key], before[key]);
  for (const form of before.presentationEvaluations) assert.deepEqual(after.presentationEvaluations.find(item => item.id === form.id), { ...form, scaleMax: 2 });
  const privateAfter = sql("select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_director_credentials t),'access',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_access t),'limits',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_login_limits t),'ballots',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_ballots t),'aggregates',(select jsonb_agg(to_jsonb(t) order by dataset,round_id,area,option_id) from public.textos_aggregates t))");
  assert.equal(privateAfter, baselinePrivate);
  assert.equal(sql("select public.textos_scores('[2,2,2,2,2,2,2,2,2,2]'::jsonb,true)"), '100');
  assert.equal(Number(sql("select public.textos_presentation_scores('[2,2,2,2,2,2,2,2,2,2]'::jsonb,2,true)")), 100);
});

await check('la publicación previa pasa al historial con su porcentaje original y no aparece como vigente', async () => {
  const after = await state();
  const historical = after.presentationShortlists.find(item => item.id === oldPublication.id);
  assert.equal(historical.status, 'superseded');
  assert.equal(historical.snapshot.scaleMax, 2);
  assert.equal(historical.snapshot.assessment.ranked[0].score, 100);
  const history = JSON.parse(sql(`select jsonb_agg(previous) from public.textos_history where entity='presentationShortlists' and reference_id='${oldPublication.id}'`));
  assert.ok(history.some(item => JSON.stringify(item) === JSON.stringify(oldPublication)));
  assert.equal((await ok('public_snapshot', {}, null)).state.presentationShortlists.length, 0);
  const summary = await ok('presentation_summary', { area: 'MAT', block: 'P1' });
  assert.equal(summary.registered, 5); assert.equal(summary.closed, 0); assert.equal(summary.pending, 15); assert.equal(summary.pendingScaleUpdate, 15);
});

await check('reaplicar 003 no agrega historial, no modifica versiones y mantiene códigos privados', async () => {
  const frozen = sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))");
  applyMigration();
  assert.equal(sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))"), frozen);
  assert.equal((await ok('snapshot', {}, teachers[0].code)).actor.id, teachers[0].snapshot.actor.id);
});

await check('un navegador anterior no guarda y solo el autor reinicia explícitamente la ficha histórica', async () => {
  const old = before.presentationEvaluations.find(item => item.teacherId === teachers[0].snapshot.actor.id);
  let result = await rpc('presentation_save', { publisherId: old.publisherId, area: old.area, block: old.block, scores: Array(10).fill(2), expectedVersion: old.version }, teachers[0].code);
  assert.equal(result.status, 409);
  result = await rpc('presentation_restart_scale', { evaluationId: old.id, expectedVersion: old.version, scaleMax: 4 }, teachers[1].code); assert.equal(result.status, 403);
  const restarted = await ok('presentation_restart_scale', { evaluationId: old.id, expectedVersion: old.version, scaleMax: 4 }, teachers[0].code);
  assert.equal(restarted.id, old.id); assert.equal(restarted.version, old.version + 1); assert.equal(restarted.scaleMax, 4); assert.deepEqual(restarted.scores, Array(10).fill(null));
  assert.deepEqual(restarted.notes, old.notes); assert.equal(restarted.generalObservation, old.generalObservation);
  const oldHistory = JSON.parse(sql(`select jsonb_agg(previous) from public.textos_history where entity='presentationEvaluations' and reference_id='${old.id}'`));
  assert.ok(oldHistory.some(item => JSON.stringify(item) === JSON.stringify(old)));
  const current = await ok('presentation_save', { publisherId: old.publisherId, area: old.area, block: old.block, scaleMax: 4, scores: Array(10).fill(2), expectedVersion: restarted.version }, teachers[0].code);
  await ok('presentation_close', { evaluationId: current.id, expectedVersion: current.version, scaleMax: 4 }, teachers[0].code);
  const summary = await ok('presentation_summary', { area: 'MAT', block: 'P1' });
  assert.equal(summary.closed, 1); assert.equal(summary.pending, 14); assert.equal(summary.pendingScaleUpdate, 14);
  assert.equal(summary.ranked.find(item => item.publisherId === old.publisherId).score, 50);
});

await check('restaurar una copia 002 preserva vectores previos y retira su publicación histórica sin reinterpretarla', async () => {
  const preview = await ok('restore_preview', { backup: oldRawBackup }); assert.equal(preview.valid, true);
  await ok('restore_apply', { backup: oldRawBackup, confirmation: 'RESTAURAR', reason: 'Comprobar restauración histórica de escala 0–2.' });
  const restored = await state();
  assert.equal(restored.settings.presentationScaleMax, 4);
  assert.ok(restored.presentationEvaluations.every(item => item.scaleMax === 2));
  assert.deepEqual(restored.presentationEvaluations.map(item => item.scores), before.presentationEvaluations.map(item => item.scores));
  assert.equal(restored.presentationShortlists[0].status, 'superseded');
  assert.equal(restored.presentationShortlists[0].snapshot.scaleMax, 2);
  assert.deepEqual(restored.evaluations, before.evaluations);
});
const update004 = readFileSync(new URL('../supabase/migrations/004-sorteo-seguimiento-voto-a5.sql', import.meta.url));
assert.equal(update004.toString(), readFileSync(new URL('../supabase/schema.sql', import.meta.url)).toString());
const apply004 = () => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env: dockerEnv, input: update004, stdio: ['pipe', 'pipe', 'pipe'] });
await check('004 incorpora sorteo y papel sin alterar ningún registro, credencial ni historial de 003', async () => {
  const unchanged = sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t))");
  apply004();
  assert.equal(sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t))"), unchanged);
  assert.equal(sql("select count(*) from public.textos_paper_tokens"), '0');
});
await check('repetir 004 conserva el orden ya sorteado y no añade versiones ni historial', async () => {
  const draw = await ok('presentation_draw', { expectedVersion: 0, confirmArrivals: true });
  assert.equal(draw.publishers.length, 3);
  const unchanged = sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))");
  apply004();
  assert.equal(sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))"), unchanged);
  assert.deepEqual((await state()).presentationDraw.publishers, draw.publishers);
});
console.log(`${checks} pruebas de migración 002→003→004 SQL/HTTP aprobadas.`);
