// RPC tests against immutable SQL007. No remote or persistent database is accepted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const db = process.env.TEXTOS_TEST_DB_CONTAINER, url = process.env.TEXTOS_TEST_REST_URL;
assert.match(db ?? '', /^textos-auditorium-[0-9]+-db$/, 'Use scripts/test-auditorium-db.sh with its disposable stack.');
assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:[0-9]+$/, 'Use the isolated local PostgREST endpoint.');
const frozen007 = readFileSync(new URL('../supabase/migrations/007-padron-aulas-y-voto-manual.sql', import.meta.url));
assert.equal(createHash('sha256').update(frozen007).digest('hex'), 'c61f1d5bc3421d09c3b50a834cc1c8e01e688db5eb601c150d318b9acc69b7b4');
const env = { ...process.env }; for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sql = value => docker('exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-Atc', value);
const sqlJson = value => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('hex')}','hex'),'UTF8')::jsonb`;
let checks = 0;
const check = async (name, operation) => { await operation(); console.log(`✓ ${++checks} ${name}`); };
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch(url)).ok) break; } catch { /* isolated startup */ }
  if (attempt >= 60) throw Error('PostgREST did not start.');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const director = sql("select public.textos_bootstrap_local('demo')"), realDirector = sql("select public.textos_bootstrap_local('real')");
async function rpc(action, payload = {}, code = director, dataset = 'demo') {
  const response = await fetch(`${url}/rpc/textos_api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: dataset }) });
  return { status: response.status, body: await response.json() };
}
async function ok(action, payload = {}, code = director, dataset = 'demo') { const r = await rpc(action, payload, code, dataset); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function reject(action, payload, status, code = director, dataset = 'demo') { const r = await rpc(action, payload, code, dataset); assert.equal(r.status, status, JSON.stringify(r.body)); }
const state = async (code = director, dataset = 'demo') => (await ok('snapshot', {}, code, dataset)).state;
const frozenRows = () => sql("select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(x) order by dataset) from public.textos_director_credentials x),'access',(select jsonb_agg(to_jsonb(x) order by id) from public.textos_access x),'limits',(select jsonb_agg(to_jsonb(x) order by dataset) from public.textos_login_limits x),'tokens',(select jsonb_agg(to_jsonb(x) order by code_hash) from public.textos_paper_tokens x),'photos',(select jsonb_agg(to_jsonb(x) order by id) from public.textos_paper_evidence x),'ballots',(select jsonb_agg(to_jsonb(x) order by code_hash) from public.textos_ballots x),'aggregates',(select jsonb_agg(to_jsonb(x) order by dataset,round_id,area,option_id) from public.textos_aggregates x),'academicHistory',(select jsonb_agg(to_jsonb(x) order by id) from public.textos_history x where entity<>'settings'))");
const withoutSettings = value => { const copy = structuredClone(value); delete copy.settings; delete copy.audit; delete copy.version; return copy; };

const fixture = JSON.parse(sql('select public.textos_empty_state()'));
fixture.settings.rules.lockedAt = '2026-11-05T16:00:00Z';
fixture.settings.rules.presentationSeconds = 900;
fixture.settings.rules.transitionSeconds = 180;
fixture.publishers = [1, 2, 3].map(index => ({ id: `auditorium-publisher-${index}`, version: 1, name: `Editorial ${index}`, samplesReceived: true, sampleNote: '' }));
fixture.teachers = ['MAT', 'COM'].map(area => ({ id: `auditorium-teacher-${area}`, version: 1, name: `DOCENTE PRIVADO ${area}`, area, categories: ['P1'], attended: true, attendanceEvidence: '' }));
fixture.presentationQuestions = fixture.publishers.map(publisher => ({ id: `question-${publisher.id}`, version: 1, publisherId: publisher.id, status: 'answered', confirmed: true, askedAt: '2026-11-05T16:00:00Z', answeredAt: '2026-11-05T16:00:01Z', updatedAt: '2026-11-05T16:00:01Z' }));
fixture.presentationEvaluations = fixture.teachers.flatMap(teacher => fixture.publishers.map((publisher, index) => ({ id: `form-${teacher.id}-${index}`, version: 1, publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1', scores: Array(10).fill(4 - index), notes: Array(10).fill('OBSERVACIÓN PRIVADA CONSERVADA'), scaleMax: 4, rubricVersion: 2, responseScore: 4 - index, questionVersion: null, generalObservation: 'COMENTARIO PRIVADO CONSERVADO', physicalText: '', status: 'closed', closedAt: '2026-11-05T16:15:00Z', updatedAt: '2026-11-05T16:15:00Z', rulesVersion: 1 })));
fixture.presentationDraw = { id: 'auditorium-draw', version: 1, publishers: fixture.publishers.map(({ id, name }) => ({ id, name })), completedPublisherIds: fixture.publishers.map(publisher => publisher.id), createdAt: '2026-11-05T15:30:00Z', createdBy: 'Subdirección' };
fixture.turn = { publisherId: fixture.publishers[2].id, status: 'finished', startedAt: '2026-11-05T16:00:00Z', pausedAt: '2026-11-05T16:15:00Z', pausedMilliseconds: 0 };
const classrooms = JSON.parse(sql("select public.textos_paper_classrooms('P1')"));
Object.assign(classrooms[0], { attendance: 'present', ballotIssued: true, received: true, choices: { MAT: fixture.publishers[0].id, COM: fixture.publishers[1].id }, voteVersion: 1, recordedAt: '2026-11-05T16:30:00Z', correctedAt: null });
classrooms[1].ballotIssued = true;
const options = fixture.publishers.map(({ id, name }) => ({ id, name }));
fixture.paperPolls = [{ id: 'auditorium-paper-poll', version: 1, block: 'P1', areas: ['MAT', 'COM'], options: { MAT: options, COM: options }, status: 'open', rankingId: 'existing-paper-ranking', rankingVersion: 1, createdAt: '2026-11-05T16:20:00Z', closedAt: null, generated: 2, received: 1, counts: { MAT: { options: Object.fromEntries(options.map((option, index) => [option.id, index === 0 ? 1 : 0])), blank: 0, invalid: 0 }, COM: { options: Object.fromEntries(options.map((option, index) => [option.id, index === 1 ? 1 : 0])), blank: 0, invalid: 0 } }, results: {}, rosterVersion: 1, classrooms }];
sql(`update public.textos_datasets set state=${sqlJson(fixture)} where id in ('demo','real'); select public.textos_validate_state(state) from public.textos_datasets`);
for (const dataset of ['demo', 'real']) {
  sql(`insert into public.textos_paper_tokens(code_hash,dataset,poll_id,consumed,classroom_id) values(public.textos_hash(public.textos_code()),'${dataset}','auditorium-paper-poll',true,'PRI1-A'),(public.textos_hash(public.textos_code()),'${dataset}','auditorium-paper-poll',false,'PRI1-B')`);
  sql(`insert into public.textos_paper_evidence(dataset,poll_id,classroom_id,filename,mime_type,content,sha256) values('${dataset}','auditorium-paper-poll','PRI1-A','ficha-conservada.png','image/png',decode('89504e470d0a1a0a0000000d494844520000000100000001','hex'),encode(sha256(decode('89504e470d0a1a0a0000000d494844520000000100000001','hex')),'hex'))`);
}
const teacher = (await ok('access_create', { role: 'teacher', teacherId: fixture.teachers[0].id })).code;
const secretary = (await ok('access_create', { role: 'secretary', name: 'Mesa del ensayo' })).code;
const secondDirector = sql('select public.textos_code()');
sql(`insert into public.textos_access(dataset,code_hash,role,name,expires_at) values('demo',public.textos_hash('${secondDirector}'),'coordinator','Otra pantalla de Subdirección',now()+interval '1 day')`);
let displayVersion = 0;
async function saveDisplay(display, code = director, dataset = 'demo') {
  const before = await state(code, dataset), rowsBefore = frozenRows();
  const saved = await ok('settings_save', { settings: { ...before.settings, auditoriumDisplay: display }, expectedVersion: before.settings.version }, code, dataset);
  const after = await state(code, dataset);
  assert.equal(saved.version, before.settings.version + 1);
  assert.deepEqual(after.settings.rules, before.settings.rules);
  assert.deepEqual(withoutSettings(after), withoutSettings(before));
  assert.equal(frozenRows(), rowsBefore);
  assert.deepEqual(after.presentationEvaluations, fixture.presentationEvaluations);
  assert(after.presentationEvaluations.every(form => form.status === 'closed'));
  return saved;
}
let categories, startedAt;

await check('SQL007 ya permite las indicaciones antes de generar un ranking y no modifica notas ni reglas bloqueadas', async () => {
  assert.equal((await state()).presentationRanking, undefined);
  const display = { schemaVersion: 1, version: ++displayVersion, mode: 'instructions', categories: [] };
  await saveDisplay(display);
  assert.deepEqual((await ok('public_snapshot', {}, null)).state.settings.auditoriumDisplay, display);
  assert.equal(Number(sql("select public.textos_presentation_score_of(state#>'{presentationEvaluations,0}',true) from public.textos_datasets where id='demo'")), 100);
});
await check('solo Subdirección puede cambiar la pantalla; docentes, mesa y accesos ajenos se rechazan', async () => {
  const current = await state(); const payload = { settings: { ...current.settings, auditoriumDisplay: null }, expectedVersion: current.settings.version };
  const frozen = JSON.stringify(await state()), rows = frozenRows();
  await reject('settings_save', payload, 401, null);
  await reject('settings_save', payload, 403, teacher);
  await reject('settings_save', payload, 403, secretary);
  await reject('settings_save', payload, 401, realDirector);
  assert.equal(JSON.stringify(await state()), frozen); assert.equal(frozenRows(), rows);
});
await check('la pantalla de finalistas publica solo tres agregados por área y conserva fichas privadas, votos y fotografías', async () => {
  const ranking = await ok('presentation_ranking_generate', { expectedVersion: 0 }); assert.equal(ranking.provisional, false);
  categories = ranking.categories.filter(category => category.registered && category.pending === 0 && category.finalists.length === 3).map(category => ({ area: category.area, block: category.block, publishers: category.finalists.map(id => ({ id, name: fixture.publishers.find(publisher => publisher.id === id).name, score: category.ranked.find(row => row.publisherId === id).score })) }));
  assert.equal(categories.length, 2); assert(categories.every(category => category.publishers.length === 3));
  startedAt = (await ok('snapshot')).serverNow;
  const display = { schemaVersion: 1, version: ++displayVersion, mode: 'samples', visit: { status: 'running', durationSeconds: 600, remainingSeconds: 600, startedAt, endsAt: new Date(Date.parse(startedAt) + 600000).toISOString() }, categories, rankingId: ranking.id, rankingVersion: ranking.version };
  await saveDisplay(display);
  const published = (await ok('public_snapshot', {}, null)).state;
  assert.deepEqual(published.settings.auditoriumDisplay, display);
  assert.equal(published.presentationRanking, undefined); assert.deepEqual(published.presentationEvaluations, []);
  assert(!JSON.stringify(published).includes('OBSERVACIÓN PRIVADA')); assert(!JSON.stringify(published).includes('COMENTARIO PRIVADO')); assert(!JSON.stringify(published).includes('DOCENTE PRIVADO')); assert(!JSON.stringify(published).includes('ficha-conservada.png'));
});
await check('otra sesión y una recarga recuperan el mismo vencimiento sin reiniciar los diez minutos', async () => {
  const first = (await state()).settings.auditoriumDisplay;
  const fromOtherSession = (await state(secondDirector)).settings.auditoriumDisplay;
  const fromReload = (await ok('public_snapshot', {}, null)).state.settings.auditoriumDisplay;
  assert.deepEqual(fromOtherSession, first); assert.deepEqual(fromReload, first);
  assert.equal(Date.parse(first.visit.endsAt) - Date.parse(first.visit.startedAt), 600000);
});
await check('pausar y reanudar conserva el tiempo restante y no altera la exposición ni los datos académicos', async () => {
  const previous = (await state()).settings.auditoriumDisplay;
  await saveDisplay({ ...previous, version: ++displayVersion, visit: { ...previous.visit, status: 'paused', remainingSeconds: 412, endsAt: null } });
  const paused = (await ok('public_snapshot', {}, null)).state.settings.auditoriumDisplay;
  assert.equal(paused.visit.status, 'paused'); assert.equal(paused.visit.remainingSeconds, 412); assert.equal(paused.visit.endsAt, null);
  const now = (await ok('snapshot')).serverNow;
  await saveDisplay({ ...paused, version: ++displayVersion, visit: { ...paused.visit, status: 'running', endsAt: new Date(Date.parse(now) + 412000).toISOString() } });
  const resumed = (await state(secondDirector)).settings.auditoriumDisplay;
  assert.equal(Date.parse(resumed.visit.endsAt) - Date.parse(now), 412000); assert.deepEqual(resumed.categories, categories);
});
await check('una pestaña atrasada recibe409 y no sobrescribe el reloj ni las finalistas de otra pantalla', async () => {
  const old = (await state()).settings;
  await saveDisplay({ ...old.auditoriumDisplay, version: ++displayVersion, visit: { ...old.auditoriumDisplay.visit, status: 'paused', endsAt: null, remainingSeconds: 300 } });
  const frozen = JSON.stringify(await state()), rows = frozenRows();
  await reject('settings_save', { settings: { ...old, auditoriumDisplay: null }, expectedVersion: old.version }, 409, secondDirector);
  assert.equal(JSON.stringify(await state()), frozen); assert.equal(frozenRows(), rows);
});
await check('finalizar la visita publica cero y conserva la lista para que las familias vuelvan a votar', async () => {
  const previous = (await state()).settings.auditoriumDisplay;
  await saveDisplay({ ...previous, version: ++displayVersion, visit: { ...previous.visit, status: 'finished', remainingSeconds: 0, endsAt: null } });
  const finished = (await ok('public_snapshot', {}, null)).state.settings.auditoriumDisplay;
  assert.equal(finished.visit.status, 'finished'); assert.equal(finished.visit.remainingSeconds, 0); assert.deepEqual(finished.categories, categories);
});
await check('el respaldo y su previsualización conservan la proyección sin tocar fotos ni reabrir votos', async () => {
  const frozen = JSON.stringify(await state()), rows = frozenRows(), backup = await ok('backup_get');
  assert.deepEqual(backup.state.settings.auditoriumDisplay, (await state()).settings.auditoriumDisplay);
  assert.equal(backup.photoEvidenceManifest.length, 1);
  const preview = await ok('restore_preview', { backup }); assert.equal(preview.valid, true);
  assert.equal(JSON.stringify(await state()), frozen); assert.equal(frozenRows(), rows);
});
await check('Jornada real y Demostración conservan pantallas independientes con los mismos permisos y CAS', async () => {
  const demoBefore = JSON.stringify(await state());
  const realBefore = await state(realDirector, 'real'); assert.equal(realBefore.settings.auditoriumDisplay, undefined);
  const instructions = { schemaVersion: 1, version: 1, mode: 'instructions', categories: [] };
  await saveDisplay(instructions, realDirector, 'real');
  assert.equal(JSON.stringify(await state()), demoBefore);
  assert.deepEqual((await ok('public_snapshot', {}, null, 'real')).state.settings.auditoriumDisplay, instructions);
  assert.equal((await ok('public_snapshot', {}, null, 'demo')).state.settings.auditoriumDisplay.mode, 'samples');
});
await check('volver a la sala retira la pantalla especial sin cambiar reglas, puntajes ni registros de padres', async () => {
  await saveDisplay(null);
  assert.equal((await ok('public_snapshot', {}, null)).state.settings.auditoriumDisplay, null);
  assert.deepEqual((await state()).paperPolls, fixture.paperPolls);
  assert.equal(sql("select count(*) from public.textos_paper_evidence"), '2');
});
console.log(`${checks} grupos SQL/HTTP de proyección de Sala compatibles con el esquema007 existente aprobados.`);
