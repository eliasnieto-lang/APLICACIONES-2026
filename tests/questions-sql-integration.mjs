// Mandatory question acceptance against disposable PostgreSQL + PostgREST only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const db = process.env.TEXTOS_TEST_DB_CONTAINER, url = process.env.TEXTOS_TEST_REST_URL;
assert.match(db ?? '', /^textos-questions-[0-9]+-db$/, 'Use scripts/test-questions-db.sh with its disposable database.');
assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:[0-9]+$/, 'Use the isolated local PostgREST endpoint.');
const env = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sql = statement => docker('exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-Atc', statement);
for (let attempt = 0; ; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} if (attempt >= 60) throw Error('PostgREST did not become ready.'); await new Promise(resolve => setTimeout(resolve, 100)); }
const director = sql("select public.textos_bootstrap_local('demo')");
let checks = 0; const check = async (name, operation) => { await operation(); console.log(`✓ ${++checks} ${name}`); };
async function rpc(action, payload = {}, code = director) {
  if (action === 'turn_control' && !Object.hasOwn(payload, 'expectedTurn')) { const current = await rpc('snapshot', {}, code); if (current.status === 200) payload = { ...payload, expectedTurn: current.body.state.turn }; }
  const response = await fetch(`${url}/rpc/textos_api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  return { status: response.status, body: await response.json() };
}
async function ok(action, payload = {}, code = director) { const result = await rpc(action, payload, code); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
async function reject(action, payload, status, code = director) { const result = await rpc(action, payload, code); assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; }
const state = async () => (await ok('snapshot')).state;
const frozen = () => sql("select jsonb_build_object('datasets',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_datasets t),'history',(select jsonb_agg(to_jsonb(t) order by id) from public.textos_history t))");
const publishers = [];
for (let index = 1; index <= 3; index++) publishers.push(await ok('publisher_save', { publisher: { id: '', version: 1, name: `Editorial preguntas ${index}`, samplesReceived: false, sampleNote: '' } }));
const teacher = await ok('teacher_register', { firstNames: 'Lucía', lastNames: 'Representante reservado', area: 'MAT', categories: ['P1'] }, null);
const secretary = await ok('access_create', { role: 'secretary', name: 'Mesa de preguntas' });
const representative = 'Representante reservado Lucía';
const confirmation = (publisherId, expectedVersion = 0, confirmed = true) => ({ publisherId, expectedVersion, confirmed });
const details = (publisherId, expectedVersion = 0) => ({ publisherId, expectedVersion, representativeName: representative, area: 'COM', question: '¿Cómo acompaña el material la comprensión de textos?', answer: 'La editorial explicó una actividad y cómo retroalimentar la interpretación.', status: 'answered' });
const fields = (publisherId, expectedVersion = 0, responseScore = 0) => ({ publisherId, expectedVersion, area: 'MAT', block: 'P1', scaleMax: 4, rubricVersion: 2, scores: Array(10).fill(0), responseScore, notes: Array(10).fill(''), generalObservation: '', physicalText: '' });
let first, draw, independentlyClosed;

await check('solo Subdirección confirma la casilla y se validan editorial y tipos', async () => {
  await reject('presentation_question_save', confirmation(publishers[0].id), 401, null);
  await reject('presentation_question_save', confirmation(publishers[0].id), 403, teacher.code);
  await reject('presentation_question_save', confirmation(publishers[0].id), 403, secretary.code);
  await reject('presentation_question_save', confirmation('missing'), 404);
  for (const confirmed of ['true', null, 1]) await reject('presentation_question_save', { ...confirmation(publishers[0].id), confirmed }, 400);
  await reject('presentation_question_save', { ...confirmation(publishers[0].id), representativeName: 123 }, 400);
  await reject('presentation_question_save', { ...confirmation(publishers[0].id), area: 'SCI' }, 400);
});

await check('I11 se puntúa y cierra antes de empezar la sala, sin autorización ni versión de pregunta', async () => {
  assert.equal(((await state()).presentationQuestions ?? []).length, 0); assert.equal((await state()).turn.status, 'ready');
  const draft = await ok('presentation_save', fields(publishers[0].id), teacher.code);
  assert.equal(draft.responseScore, 0); assert.equal(draft.questionVersion, null);
  independentlyClosed = await ok('presentation_close', { evaluationId: draft.id, expectedVersion: draft.version, scaleMax: 4, rubricVersion: 2 }, teacher.code);
  assert.equal(independentlyClosed.status, 'closed'); assert.equal(independentlyClosed.responseScore, 0);
  const summary = await ok('presentation_summary', { area: 'MAT', block: 'P1' });
  assert.equal(summary.ranked.find(item => item.publisherId === publishers[0].id).closed, 1);
  assert.equal(summary.ranked.find(item => item.publisherId === publishers[0].id).score, 0);
});

await check('una casilla desmarcada no confirma el hecho ni permite finalizar la exposición', async () => {
  first = await ok('presentation_question_save', confirmation(publishers[0].id, 0, false));
  assert(first.version > 0); assert.equal(first.status, 'draft'); assert.equal(first.confirmed, false); assert.equal(first.askedAt, null); assert.equal(first.answeredAt, null);
  assert.equal(sql(`select public.textos_question_can_finish(state,'${publishers[0].id}') from public.textos_datasets where id='demo'`), 'f');
  await ok('turn_control', { command: 'start', publisherId: publishers[0].id });
  const before = frozen(); await reject('turn_control', { command: 'finish' }, 423); assert.equal(frozen(), before);
});

await check('confirmar exige solo la casilla, sin nombre, área, pregunta ni transcripción de la respuesta', async () => {
  const previousVersion = first.version;
  first = await ok('presentation_question_save', confirmation(publishers[0].id, first.version));
  assert.equal(first.status, 'answered'); assert.equal(first.confirmed, true);
  for (const key of ['representativeName', 'area', 'question', 'answer']) assert(!Object.hasOwn(first, key));
  assert(first.askedAt); assert(first.answeredAt); assert.equal(first.version, previousVersion + 1);
  assert.equal(sql(`select public.textos_question_can_finish(state,'${publishers[0].id}') from public.textos_datasets where id='demo'`), 't');
});

await check('antes de finalizar se corrige la casilla con CAS, sin motivo ni alterar fichas cerradas', async () => {
  const originalForms = (await state()).presentationEvaluations;
  const originalFingerprint = sql("select public.textos_jornada_fingerprint(state) from public.textos_datasets where id='demo'");
  const stale = first.version;
  first = await ok('presentation_question_save', confirmation(publishers[0].id, first.version, false));
  assert.equal(first.status, 'draft');
  await reject('presentation_question_save', confirmation(publishers[0].id, stale), 409);
  first = await ok('presentation_question_save', confirmation(publishers[0].id, first.version));
  assert.deepEqual((await state()).presentationEvaluations, originalForms);
  assert.equal(sql("select public.textos_jornada_fingerprint(state) from public.textos_datasets where id='demo'"), originalFingerprint);
  const summary = await ok('presentation_summary', { area: 'MAT', block: 'P1' }); assert.equal(summary.ranked.find(item => item.publisherId === publishers[0].id).closed, 1);
});

await check('finalizar conserva la confirmación y una repetición idéntica no crea otra versión', async () => {
  await ok('turn_control', { command: 'finish' }); assert.equal((await state()).turn.status, 'finished');
  const before = frozen();
  await reject('presentation_question_save', confirmation(publishers[0].id, first.version, false), 423);
  assert.equal(frozen(), before);
  const repeated = await ok('presentation_question_save', confirmation(publishers[0].id, first.version)); assert.deepEqual(repeated, first);
  assert.deepEqual((await state()).presentationEvaluations.find(item => item.id === independentlyClosed.id), independentlyClosed);
});

await check('dos pantallas crean una sola confirmación y no sobrescriben el valor de la otra', async () => {
  const replies = await Promise.all([rpc('presentation_question_save', confirmation(publishers[1].id, 0, false)), rpc('presentation_question_save', confirmation(publishers[1].id))]);
  assert.deepEqual(replies.map(item => item.status).sort(), [200, 409]);
  const questions = (await state()).presentationQuestions.filter(item => item.publisherId === publishers[1].id); assert.equal(questions.length, 1); assert(questions[0].version > 0);
});

await check('la casilla conserva los datos anteriores de la pregunta sin volver a pedirlos', async () => {
  const prior = (await state()).presentationQuestions.find(item => item.publisherId === publishers[1].id);
  const detailed = await ok('presentation_question_save', details(publishers[1].id, prior.version));
  assert.equal(detailed.area, 'COM'); assert.equal(detailed.representativeName, representative);
  const off = await ok('presentation_question_save', confirmation(publishers[1].id, detailed.version, false));
  const on = await ok('presentation_question_save', confirmation(publishers[1].id, off.version));
  for (const key of ['representativeName', 'area', 'question', 'answer']) assert.equal(on[key], detailed[key]);
});

await check('cada editorial sorteada requiere su propia casilla antes de avanzar', async () => {
  draw = await ok('presentation_draw', { expectedVersion: 0, confirmArrivals: true });
  for (const [index, publisher] of draw.publishers.entries()) {
    await ok('turn_control', { command: index === 0 ? 'start' : 'next', publisherId: publisher.id });
    const question = (await state()).presentationQuestions.find(item => item.publisherId === publisher.id);
    if (question?.status !== 'answered') {
      await reject('turn_control', { command: 'finish' }, 423);
      await ok('presentation_question_save', confirmation(publisher.id, question?.version ?? 0));
    }
    await ok('turn_control', { command: 'finish' });
  }
  assert.deepEqual((await state()).presentationDraw.completedPublisherIds, draw.publishers.map(item => item.id));
});

await check('la proyección comparte confirmaciones y datos antiguos sin filtrar identidad o campos privados', async () => {
  const backup = await ok('backup_get'); backup.state.presentationQuestions[0].privateTeacherNotes = 'NOTA PRIVADA DE PREGUNTAS';
  await ok('restore_apply', { backup, confirmation: 'RESTAURAR', reason: 'Ensayo de proyección enumerada de las preguntas' });
  const publicState = (await ok('public_snapshot', {}, null)).state;
  assert.equal(publicState.presentationQuestions.length, 3); assert(publicState.presentationQuestions.every(item => item.status === 'answered' && item.confirmed));
  assert(!JSON.stringify(publicState.presentationQuestions).includes(representative)); assert(!JSON.stringify(publicState.presentationQuestions).includes('NOTA PRIVADA DE PREGUNTAS'));
  const own = (await ok('snapshot', {}, teacher.code)).state; assert.equal(own.presentationQuestions.length, 3); assert(!JSON.stringify(own.presentationQuestions).includes('NOTA PRIVADA DE PREGUNTAS'));
});

await check('los respaldos rechazan confirmaciones huérfanas, duplicadas o incoherentes', async () => {
  const backup = await ok('backup_get');
  const missing = structuredClone(backup); missing.state.presentationQuestions[0].publisherId = 'missing'; await reject('restore_preview', { backup: missing }, 400);
  const duplicate = structuredClone(backup); duplicate.state.presentationQuestions.push({ ...duplicate.state.presentationQuestions[0], id: 'duplicate-question' }); await reject('restore_preview', { backup: duplicate }, 400);
  const mismatch = structuredClone(backup); mismatch.state.presentationQuestions[0].confirmed = false; await reject('restore_preview', { backup: mismatch }, 400);
  const type = structuredClone(backup); type.state.presentationQuestions[0].confirmed = 'true'; await reject('restore_preview', { backup: type }, 400);
  const previous = structuredClone(backup); previous.state.presentationQuestions[0] = { ...details(publishers[0].id), ...previous.state.presentationQuestions[0], question: '', representativeName: representative, area: 'COM', answer: 'Texto anterior' }; delete previous.state.presentationQuestions[0].confirmed; await reject('restore_preview', { backup: previous }, 400);
});

await check('reaplicar el esquema no borra confirmaciones, notas, cierres ni historial', async () => {
  const before = frozen();
  execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env, input: readFileSync(new URL('../supabase/schema.sql', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(frozen(), before);
  const response = await fetch(`${url}/rpc/textos_question_can_finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s: {}, publisher_id: 'x' }) });
  assert([401, 403].includes(response.status));
});

await check('borrar y recrear la confirmación no reabre ni cambia I11 y puede recuperarse tras finalizar', async () => {
  const previous = (await state()).presentationQuestions.find(item => item.publisherId === publishers[0].id);
  const originalForms = (await state()).presentationEvaluations;
  const preview = await ok('data_delete_preview', { scope: 'question', ids: [previous.id] });
  assert.equal(preview.counts.responseScores, 0); assert.equal(preview.counts.presentationDraw, 0); assert.equal(preview.counts.presentationRanking, 0);
  await ok('data_delete_apply', { scope: 'question', ids: [previous.id], expectedVersion: preview.stateVersion, confirmation: 'ELIMINAR' });
  assert.deepEqual((await state()).presentationEvaluations, originalForms); assert.deepEqual((await state()).presentationDraw.completedPublisherIds, draw.publishers.map(item => item.id));
  const fresh = await ok('presentation_question_save', confirmation(previous.publisherId)); assert(fresh.version > previous.version); assert.notEqual(fresh.id, previous.id);
  assert.deepEqual((await state()).presentationEvaluations, originalForms);
  const independentlySaved = await ok('presentation_save', { ...fields(publishers[1].id, 0, 4), questionVersion: previous.version }, teacher.code);
  const independentlyFinalized = await ok('presentation_close', { evaluationId: independentlySaved.id, expectedVersion: independentlySaved.version, scaleMax: 4, rubricVersion: 2 }, teacher.code);
  assert.equal(independentlyFinalized.status, 'closed'); assert.equal(independentlyFinalized.responseScore, 4);
});
console.log(`${checks} pruebas SQL/HTTP de confirmación simple e I11 independiente aprobadas.`);
