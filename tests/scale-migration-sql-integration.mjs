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
assert.equal(createHash('sha256').update(update004).digest('hex'), '385aa6eafcba27399c88670af1f9605637ea2f8667eab86c1c8ceef5e9547a89');
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
const update005 = readFileSync(new URL('../supabase/migrations/005-borrado-preguntas-y-clasificacion.sql', import.meta.url));
assert.equal(createHash('sha256').update(update005).digest('hex'), 'f738289ae8f97742feae294db8e743f10dbb663e7880077d901a3c3ee64a2bd1');
const apply005 = () => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env: dockerEnv, input: update005, stdio: ['pipe', 'pipe', 'pipe'] });
await check('005 añade borrado y rúbrica adaptada sin eliminar datos ni alterar puntajes, códigos o historial al instalarse', async () => {
  const unchanged = sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t),'credentials',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_director_credentials t))");
  apply005();
  assert.equal(sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t),'credentials',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_director_credentials t))"), unchanged);
});
await check('repetir 005 y previsualizar el borrado no modifica la jornada ni ejecuta una eliminación', async () => {
  const unchanged = sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t))");
  const preview = await ok('data_delete_preview', { scope: 'all', ids: [] }); assert.equal(preview.requiresFullConfirmation, true); assert.equal(preview.counts.publishers, 3);
  apply005();
  assert.equal(sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_access t))"), unchanged);
});
const update006 = readFileSync(new URL('../supabase/migrations/006-confirmacion-simple-e-i11-independiente.sql', import.meta.url));
assert.equal(createHash('sha256').update(update006).digest('hex'), '42d63eafe8b09e18bf7ea77b12f8e48ef2ccf3dc5733c577c30ac791b0a53c5f');
const apply006 = () => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env: dockerEnv, input: update006, stdio: ['pipe', 'pipe', 'pipe'] });
const frozenDatabase = () => sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t),'access',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_access t),'credentials',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_director_credentials t),'limits',(select jsonb_agg(to_jsonb(t) order by dataset) from public.textos_login_limits t),'ballots',(select jsonb_agg(to_jsonb(t) order by code_hash) from public.textos_ballots t),'paperTokens',(select jsonb_agg(jsonb_strip_nulls(to_jsonb(t)) order by code_hash) from public.textos_paper_tokens t),'aggregates',(select jsonb_agg(to_jsonb(t) order by dataset,round_id,area,option_id) from public.textos_aggregates t))");
let legacy005Form, legacy005Question;
await check('005 conserva una pregunta transcrita y una ficha vigente cerrada con su versión de pregunta original', async () => {
  const current = await state(); const publisherId = current.presentationDraw.publishers[0].id;
  await ok('turn_control', { command: 'start', publisherId, expectedTurn: current.turn });
  legacy005Question = await ok('presentation_question_save', { publisherId, expectedVersion: 0, representativeName: 'Representante original de 005', area: 'MAT', question: 'Pregunta original registrada antes de actualizar', answer: 'Respuesta original que debe conservarse íntegramente', status: 'answered' });
  const old = (await state()).presentationEvaluations.find(form => form.teacherId === teachers[0].snapshot.actor.id && form.publisherId === publisherId);
  const restarted = await ok('presentation_restart_scale', { evaluationId: old.id, expectedVersion: old.version, scaleMax: 4, rubricVersion: 2 }, teachers[0].code);
  const saved = await ok('presentation_save', { publisherId, area: 'MAT', block: 'P1', scaleMax: 4, rubricVersion: 2, scores: Array(10).fill(3), responseScore: 1, questionVersion: legacy005Question.version, notes: Array(10).fill('Nota previa de la versión 005'), physicalText: 'Ejemplar que ya fue evaluado', generalObservation: 'Conservar junto con la respuesta observada', expectedVersion: restarted.version }, teachers[0].code);
  legacy005Form = await ok('presentation_close', { evaluationId: saved.id, expectedVersion: saved.version, scaleMax: 4, rubricVersion: 2 }, teachers[0].code);
  assert.equal(legacy005Form.questionVersion, legacy005Question.version); assert.equal(legacy005Form.responseScore, 1); assert.equal(legacy005Form.status, 'closed');
});
await check('006 se instala sin alterar datos, credenciales, accesos, notas, pregunta anterior ni historial', async () => {
  const unchanged = frozenDatabase(); apply006(); assert.equal(frozenDatabase(), unchanged);
  const after = await state();
  assert.deepEqual(after.presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
  assert.deepEqual(after.presentationQuestions.find(question => question.id === legacy005Question.id), legacy005Question);
  assert.equal((await ok('snapshot', {}, teachers[0].code)).actor.id, teachers[0].snapshot.actor.id);
});
await check('repetir 006 conserva exactamente los datos, versiones, registros privados y el historial', async () => {
  const unchanged = frozenDatabase(); apply006(); apply006(); assert.equal(frozenDatabase(), unchanged);
});
await check('la confirmación simple se cambia sin transcripción ni motivo y no invalida la ficha heredada ni su I11', async () => {
  let question = await ok('presentation_question_save', { publisherId: legacy005Question.publisherId, expectedVersion: legacy005Question.version, confirmed: false });
  assert.equal(question.status, 'draft'); assert.equal(question.confirmed, false);
  const afterUncheck = await state();
  assert.deepEqual(afterUncheck.presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
  let category = await ok('presentation_summary', { area: 'MAT', block: 'P1' });
  let result = category.ranked.find(item => item.publisherId === legacy005Form.publisherId);
  assert.equal(result.closed, 1); assert.equal(result.score, 3100 / 44);
  question = await ok('presentation_question_save', { publisherId: legacy005Question.publisherId, expectedVersion: question.version, confirmed: true });
  assert.equal(question.status, 'answered'); assert.equal(question.confirmed, true);
  assert.equal(question.question, legacy005Question.question); assert.equal(question.answer, legacy005Question.answer); assert.equal(question.representativeName, legacy005Question.representativeName);
  assert.notEqual(question.version, legacy005Form.questionVersion);
  assert.deepEqual((await state()).presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
  category = await ok('presentation_summary', { area: 'MAT', block: 'P1' }); result = category.ranked.find(item => item.publisherId === legacy005Form.publisherId);
  assert.equal(result.closed, 1); assert.equal(result.score, 3100 / 44);
});
await check('tras 006 I11 puede guardarse y cerrarse sin turno ni confirmación de Sala; cero cuenta sobre 44', async () => {
  sql("do $$ declare s jsonb; begin select state into s from public.textos_datasets where id='demo' for update; s:=jsonb_set(s,'{turn}',public.textos_empty_state()->'turn'); perform public.textos_validate_state(s); update public.textos_datasets set state=s where id='demo'; end $$;");
  const current = await state(); assert.equal(current.turn.status, 'ready'); assert.equal(current.turn.publisherId, null);
  const publisherId = publishers.find(publisher => publisher.id !== legacy005Form.publisherId).id;
  assert.ok(!(current.presentationQuestions ?? []).some(question => question.publisherId === publisherId));
  const teacher = await ok('teacher_register', { firstNames: 'Docente independiente', lastNames: 'Migración seis', area: 'MAT', categories: ['P1'] }, null);
  const saved = await ok('presentation_save', { publisherId, area: 'MAT', block: 'P1', scaleMax: 4, rubricVersion: 2, scores: Array(10).fill(4), responseScore: 0, questionVersion: null, notes: Array(10).fill(''), physicalText: '', generalObservation: '', expectedVersion: 0 }, teacher.code);
  const closed = await ok('presentation_close', { evaluationId: saved.id, expectedVersion: saved.version, scaleMax: 4, rubricVersion: 2 }, teacher.code);
  assert.equal(closed.status, 'closed'); assert.equal(closed.responseScore, 0); assert.equal(closed.questionVersion, null);
  const category = await ok('presentation_summary', { area: 'MAT', block: 'P1' }); const result = category.ranked.find(item => item.publisherId === publisherId);
  assert.equal(result.closed, 1); assert.equal(result.score, 4000 / 44);
  assert.ok(!((await state()).presentationQuestions ?? []).some(question => question.publisherId === publisherId));
});


// The 006 anonymous paper election remains anonymous after upgrading: a nullable
// classroom_id column is metadata for new rosters, never a retroactive identity.
const asSql = value => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('hex')}','hex'),'UTF8')::jsonb`;
let legacy006Poll, legacy006Codes, modern007Poll;
await check('006 conserva una votación anónima con fichas emitidas y un voto ya contabilizado antes de actualizar', async () => {
  const now = '2026-11-04T19:00:00.000Z';
  const options = publishers.map(publisher => ({ id: publisher.id, name: publisher.name }));
  const zero = () => ({ options: Object.fromEntries(options.map(option => [option.id, 0])), blank: 0, invalid: 0 });
  legacy006Poll = { id: 'anonymous-before-007', version: 1, block: 'S1', areas: ['MAT', 'COM'], options: { MAT: options, COM: options }, status: 'open', rankingId: 'ranking-before-007', rankingVersion: 1, createdAt: now, closedAt: null, generated: 0, received: 0, counts: { MAT: zero(), COM: zero() }, results: {} };
  sql(`do $$ declare s jsonb; begin select state into s from public.textos_datasets where id='demo' for update; s:=public.textos_put(s,'paperPolls',${asSql(legacy006Poll)}); perform public.textos_validate_state(s); update public.textos_datasets set state=s where id='demo'; end $$;`);
  const batch = await ok('paper_ballots_generate', { pollId: legacy006Poll.id, expectedVersion: legacy006Poll.version, count: 3 });
  legacy006Codes = batch.codes;
  legacy006Poll = (await ok('paper_scan_cast', { pollId: legacy006Poll.id, code: legacy006Codes[0], choices: { MAT: options[1].id, COM: null } })).poll;
  assert.equal(legacy006Poll.generated, 3); assert.equal(legacy006Poll.received, 1);
  assert.equal(sql("select count(*) from public.textos_paper_tokens where consumed"), '1');
  assert.equal(legacy006Poll.rosterVersion, undefined); assert.equal(legacy006Poll.classrooms, undefined);
});
const update007 = readFileSync(new URL('../supabase/migrations/007-padron-aulas-y-voto-manual.sql', import.meta.url));
assert.equal(update007.toString(), readFileSync(new URL('../supabase/schema.sql', import.meta.url)).toString());
const apply007 = () => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env: dockerEnv, input: update007, stdio: ['pipe', 'pipe', 'pipe'] });
await check('007 se instala sin cambiar votos anónimos, tokens consumidos, notas previas, credenciales ni historial', async () => {
  const unchanged = frozenDatabase(); apply007(); assert.equal(frozenDatabase(), unchanged);
  const after = await state();
  assert.deepEqual(after.paperPolls.find(poll => poll.id === legacy006Poll.id), legacy006Poll);
  assert.deepEqual(after.presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
  assert.equal(sql("select count(*) from public.textos_paper_tokens where classroom_id is not null"), '0');
  const publicState = (await ok('public_snapshot', {}, null)).state;
  const exposed = JSON.stringify(publicState);
  assert.ok(!legacy006Codes.some(code => exposed.includes(code))); assert.ok(!exposed.includes('code_hash'));
  const legacyPublic = publicState.paperPolls?.find(poll => poll.id === legacy006Poll.id);
  assert.ok(!legacyPublic?.classrooms); assert.ok(!legacyPublic?.rosterVersion);
});
await check('repetir 007 no asigna aulas a fichas anónimas ni reabre votos ya contabilizados', async () => {
  const unchanged = frozenDatabase(); apply007(); apply007(); assert.equal(frozenDatabase(), unchanged);
  const duplicate = await rpc('paper_scan_cast', { pollId: legacy006Poll.id, code: legacy006Codes[0], choices: { MAT: null, COM: null } });
  assert.equal(duplicate.status, 409);
  assert.deepEqual((await state()).paperPolls.find(poll => poll.id === legacy006Poll.id), legacy006Poll);
  legacy006Poll = (await ok('paper_scan_cast', { pollId: legacy006Poll.id, code: legacy006Codes[1], choices: { MAT: null, COM: legacy006Poll.options.COM[0].id } })).poll;
  assert.equal(legacy006Poll.received, 2); assert.equal(legacy006Poll.classrooms, undefined);
  assert.equal(sql("select count(*) from public.textos_paper_tokens where classroom_id is not null"), '0');
});
await check('tras 007 una votación nueva crea diez aulas P1 con cinco secciones por grado y folios únicos', async () => {
  const source = await state(); const now = '2026-11-04T19:20:00.000Z';
  const com = await ok('teacher_register', { firstNames: 'Docente comunicación', lastNames: 'Migración siete', area: 'COM', categories: ['P1'] }, null);
  const fixture = await state();
  fixture.offers.push({ id: 'upgrade-com-offer', version: 1, seriesId: 'legacy-series', area: 'COM', block: 'P1', edition: '2027', status: 'offered', withdrawalReason: '' });
  for (const teacher of fixture.teachers.filter(teacher => ['MAT', 'COM'].includes(teacher.area) && teacher.categories.includes('P1'))) for (const [index, publisher] of fixture.publishers.entries()) {
    const previous = fixture.presentationEvaluations.find(form => form.publisherId === publisher.id && form.teacherId === teacher.id && form.area === teacher.area && form.block === 'P1');
    if (previous?.scaleMax === 4 && previous?.rubricVersion === 2 && previous?.status === 'closed') continue;
    const form = { ...(previous ?? {}), id: previous?.id ?? `upgrade-${teacher.id}-${publisher.id}`, version: (previous?.version ?? 0) + 1, publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1', scores: Array(10).fill(4 - index), scaleMax: 4, rubricVersion: 2, responseScore: 4 - index, questionVersion: null, notes: Array(10).fill('Fixture posterior a la migración; no altera la ficha005 cerrada'), physicalText: '', generalObservation: '', status: 'closed', closedAt: now, updatedAt: now, rulesVersion: fixture.settings.rules.version };
    if (previous) fixture.presentationEvaluations[fixture.presentationEvaluations.indexOf(previous)] = form; else fixture.presentationEvaluations.push(form);
  }
  fixture.presentationQuestions ??= [];
  for (const publisher of fixture.publishers) if (!fixture.presentationQuestions.some(question => question.publisherId === publisher.id && question.status === 'answered')) {
    const prior = fixture.presentationQuestions.find(question => question.publisherId === publisher.id);
    const confirmation = { ...(prior ?? {}), id: prior?.id ?? `upgrade-question-${publisher.id}`, publisherId: publisher.id, version: (prior?.version ?? 0) + 1, confirmed: true, status: 'answered', askedAt: now, answeredAt: now, updatedAt: now };
    if (prior) fixture.presentationQuestions[fixture.presentationQuestions.indexOf(prior)] = confirmation; else fixture.presentationQuestions.push(confirmation);
  }
  fixture.presentationDraw.completedPublisherIds = fixture.presentationDraw.publishers.map(publisher => publisher.id);
  fixture.turn = { publisherId: fixture.presentationDraw.publishers.at(-1).id, status: 'finished', startedAt: now, pausedAt: now, pausedMilliseconds: 0 };
  sql(`do $$ declare s jsonb := ${asSql(fixture)}; begin perform public.textos_validate_state(s); update public.textos_datasets set state=s where id='demo'; end $$;`);
  const ranking = await ok('presentation_ranking_generate', { expectedVersion: fixture.presentationRanking?.version ?? 0 });
  assert.equal(ranking.provisional, false);
  modern007Poll = await ok('paper_poll_create', { block: 'P1', areas: ['MAT', 'COM'], rankingId: ranking.id, expectedRankingVersion: ranking.version });
  assert.equal(modern007Poll.rosterVersion, 1); assert.equal(modern007Poll.classrooms.length, 10);
  for (const grade of ['PRI1', 'PRI2']) assert.deepEqual(modern007Poll.classrooms.filter(classroom => classroom.gradeId === grade).map(classroom => classroom.section), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(new Set(modern007Poll.classrooms.map(classroom => classroom.folio)).size, 10);
  assert.ok(modern007Poll.classrooms.every(classroom => /^P1-\d{2}$/.test(classroom.folio) && classroom.attendance === 'pending' && !classroom.received));
  assert.deepEqual((await state()).presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
  assert.ok(com.code); assert.ok(source.presentationEvaluations.some(form => form.id === legacy005Form.id));
});
await check('el padrón marca sin asistencia y el voto manual por aula conserva I11 y suma solo una vez', async () => {
  const absent = modern007Poll.classrooms.find(classroom => classroom.id === 'PRI1-A');
  modern007Poll = await ok('paper_attendance_save', { pollId: modern007Poll.id, classroomId: absent.id, attendance: 'absent', expectedVersion: modern007Poll.version });
  assert.equal(modern007Poll.classrooms.find(classroom => classroom.id === absent.id).attendance, 'absent');
  const denied = await rpc('paper_manual_cast', { pollId: modern007Poll.id, classroomId: absent.id, choices: { MAT: null, COM: null }, expectedVersion: modern007Poll.version, confirmation: true });
  assert.ok([409, 423].includes(denied.status), JSON.stringify(denied));
  const selected = modern007Poll.classrooms.find(classroom => classroom.id === 'PRI1-B');
  const choices = { MAT: modern007Poll.options.MAT[2].id, COM: null };
  const accepted = await ok('paper_manual_cast', { pollId: modern007Poll.id, classroomId: selected.id, choices, expectedVersion: modern007Poll.version, confirmation: true });
  assert.equal(accepted.accepted, true); modern007Poll = accepted.poll;
  assert.equal(modern007Poll.received, 1); assert.equal(modern007Poll.generated, 1);
  const classroom = modern007Poll.classrooms.find(item => item.id === selected.id);
  assert.equal(classroom.attendance, 'present'); assert.equal(classroom.received, true); assert.deepEqual(classroom.choices, choices); assert.equal(classroom.voteVersion, 1);
  assert.equal(modern007Poll.counts.MAT.options[choices.MAT], 1); assert.equal(modern007Poll.counts.COM.blank, 1);
  const publicPoll = (await ok('public_snapshot', {}, null)).state.paperPolls.find(poll => poll.id === modern007Poll.id);
  assert.equal(publicPoll.status, 'open');
  const publicClassroom = publicPoll.classrooms.find(item => item.id === classroom.id);
  assert.deepEqual(publicClassroom.choices, choices); assert.equal(publicClassroom.voteVersion, 1);
  assert.equal(publicClassroom.folio, classroom.folio);
  assert.equal(publicPoll.classrooms.find(item => item.id === absent.id).attendance, 'absent');
  assert.doesNotMatch(JSON.stringify(publicPoll), /code_hash|\"code\"|\"actor\"|\"reason\"/);
  const duplicate = await rpc('paper_manual_cast', { pollId: modern007Poll.id, classroomId: selected.id, choices, expectedVersion: modern007Poll.version, confirmation: true });
  assert.equal(duplicate.status, 409);
  assert.deepEqual((await state()).presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
});
await check('corregir una transcripción ajusta conteos y su versión sin duplicar la ficha ni modificar la rúbrica docente', async () => {
  const classroom = modern007Poll.classrooms.find(item => item.id === 'PRI1-B');
  const oldChoice = classroom.choices.MAT;
  const choices = { MAT: modern007Poll.options.MAT[0].id, COM: modern007Poll.options.COM[1].id };
  const corrected = await ok('paper_manual_correct', { pollId: modern007Poll.id, classroomId: classroom.id, choices, expectedVersion: modern007Poll.version, expectedVoteVersion: classroom.voteVersion, reason: 'Corrección contra la papeleta original' });
  modern007Poll = corrected.poll ?? corrected;
  const after = modern007Poll.classrooms.find(item => item.id === classroom.id);
  assert.equal(modern007Poll.received, 1); assert.equal(modern007Poll.generated, 1); assert.equal(after.voteVersion, 2); assert.deepEqual(after.choices, choices);
  assert.equal(modern007Poll.counts.MAT.options[oldChoice], 0); assert.equal(modern007Poll.counts.MAT.options[choices.MAT], 1); assert.equal(modern007Poll.counts.COM.blank, 0); assert.equal(modern007Poll.counts.COM.options[choices.COM], 1);
  const stale = await rpc('paper_manual_correct', { pollId: modern007Poll.id, classroomId: classroom.id, choices: classroom.choices, expectedVersion: modern007Poll.version, expectedVoteVersion: classroom.voteVersion, reason: 'Una pantalla antigua no debe sobrescribir' });
  assert.equal(stale.status, 409);
  const publicClassroom = (await ok('public_snapshot', {}, null)).state.paperPolls.find(poll => poll.id === modern007Poll.id).classrooms.find(item => item.id === classroom.id);
  assert.deepEqual(publicClassroom.choices, choices); assert.equal(publicClassroom.voteVersion, 2);
  assert.doesNotMatch(JSON.stringify(publicClassroom), /Corrección contra|Una pantalla antigua/);
  assert.deepEqual((await state()).presentationEvaluations.find(form => form.id === legacy005Form.id), legacy005Form);
});
console.log(`${checks} pruebas de migración 002→003→004→005→006→007 SQL/HTTP aprobadas.`);
