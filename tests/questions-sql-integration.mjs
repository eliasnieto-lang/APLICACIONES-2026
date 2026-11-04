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
const base = (publisherId, expectedVersion = 0) => ({ publisherId, expectedVersion, representativeName: representative, area: 'COM', question: '¿Cómo acompaña el material la comprensión de textos?', answer: 'La editorial explicó una actividad y cómo retroalimentar la interpretación.', status: 'answered' });
let first, draw;

await check('solo Subdirección registra la pregunta y se validan editorial y tipos', async () => {
  await reject('presentation_question_save', base(publishers[0].id), 401, null);
  await reject('presentation_question_save', base(publishers[0].id), 403, teacher.code);
  await reject('presentation_question_save', base(publishers[0].id), 403, secretary.code);
  await reject('presentation_question_save', base('missing'), 404);
  await reject('presentation_question_save', { ...base(publishers[0].id), representativeName: 123 }, 400);
  await reject('presentation_question_save', { ...base(publishers[0].id), area: 'SCI' }, 400);
});

await check('una pregunta puede prepararse como borrador pero no habilita finalizar', async () => {
  await reject('presentation_question_save', base(publishers[0].id), 423);
  first = await ok('presentation_question_save', { ...base(publishers[0].id), question: '¿Qué evidencia propone?', answer: '', status: 'draft' });
  assert(first.version > 0); assert.equal(first.status, 'draft'); assert.equal(first.askedAt, null); assert.equal(first.answeredAt, null);
  assert.equal(sql(`select public.textos_question_can_finish(state,'${publishers[0].id}') from public.textos_datasets where id='demo'`), 'f');
  await ok('turn_control', { command: 'start', publisherId: publishers[0].id });
  const before = frozen(); await reject('turn_control', { command: 'finish' }, 423); assert.equal(frozen(), before);
});

await check('la respuesta exige nombre, pregunta y resumen pero puede ser de cualquier área', async () => {
  for (const key of ['representativeName', 'question', 'answer']) await reject('presentation_question_save', { ...base(publishers[0].id, first.version), [key]: '  ' }, 400);
  const previousVersion = first.version;
  first = await ok('presentation_question_save', base(publishers[0].id, first.version));
  assert.equal(first.status, 'answered'); assert.equal(first.area, 'COM'); assert.equal(first.representativeName, representative);
  assert(first.askedAt); assert(first.answeredAt); assert.equal(first.version, previousVersion + 1);
  assert.equal(sql(`select public.textos_question_can_finish(state,'${publishers[0].id}') from public.textos_datasets where id='demo'`), 't');
});

await check('las correcciones previas al cierre exigen CAS y motivo y conservan su historial', async () => {
  await reject('presentation_question_save', { ...base(publishers[0].id, 1), answer: 'Otro resumen' }, 409);
  await reject('presentation_question_save', { ...base(publishers[0].id, first.version), answer: 'Resumen corregido' }, 400);
  const old = first;
  first = await ok('presentation_question_save', { ...base(publishers[0].id, first.version), answer: 'Resumen corregido con la actividad observada.', reason: 'Aclaración de la respuesta escuchada antes de cerrar' });
  assert.equal(first.version, old.version + 1);
  assert((await ok('backup_get')).history.some(item => item.entity === 'presentationQuestions' && item.previous.id === old.id && item.previous.answer === old.answer));
});

await check('finalizar no espera las notas pero conserva la respuesta que los docentes valorarán', async () => {
  await ok('turn_control', { command: 'finish' }); assert.equal((await state()).turn.status, 'finished');
  const before = frozen();
  await reject('presentation_question_save', { ...base(publishers[0].id, first.version), answer: 'Cambio posterior', reason: 'No debe cambiar una respuesta después de finalizar' }, 423);
  assert.equal(frozen(), before); assert.equal((await state()).presentationEvaluations.length, 0);
});

await check('dos pantallas guardan una sola versión nueva y no sobrescriben la pregunta', async () => {
  const payload = { ...base(publishers[1].id), status: 'draft', answer: '' };
  const replies = await Promise.all([rpc('presentation_question_save', { ...payload, question: 'Pregunta desde pantalla A' }), rpc('presentation_question_save', { ...payload, question: 'Pregunta desde pantalla B' })]);
  assert.deepEqual(replies.map(item => item.status).sort(), [200, 409]);
  const questions = (await state()).presentationQuestions.filter(item => item.publisherId === publishers[1].id); assert.equal(questions.length, 1); assert(questions[0].version > 0);
});

await check('cada editorial sorteada requiere su propia pregunta y respuesta antes de avanzar', async () => {
  draw = await ok('presentation_draw', { expectedVersion: 0, confirmArrivals: true });
  for (const [index, publisher] of draw.publishers.entries()) {
    await ok('turn_control', { command: index === 0 ? 'start' : 'next', publisherId: publisher.id });
    const question = (await state()).presentationQuestions.find(item => item.publisherId === publisher.id);
    if (question?.status !== 'answered') {
      await reject('turn_control', { command: 'finish' }, 423);
      await ok('presentation_question_save', base(publisher.id, question?.version ?? 0));
    }
    await ok('turn_control', { command: 'finish' });
  }
  assert.deepEqual((await state()).presentationDraw.completedPublisherIds, draw.publishers.map(item => item.id));
});

await check('las preguntas respondidas se comparten sin publicar el nombre del representante ni campos privados', async () => {
  const backup = await ok('backup_get'); backup.state.presentationQuestions[0].privateTeacherNotes = 'NOTA PRIVADA DE PREGUNTAS';
  await ok('restore_apply', { backup, confirmation: 'RESTAURAR', reason: 'Ensayo de proyección enumerada de las preguntas' });
  const publicState = (await ok('public_snapshot', {}, null)).state;
  assert.equal(publicState.presentationQuestions.length, 3); assert(publicState.presentationQuestions.every(item => item.status === 'answered'));
  assert(!JSON.stringify(publicState.presentationQuestions).includes(representative)); assert(!JSON.stringify(publicState.presentationQuestions).includes('NOTA PRIVADA DE PREGUNTAS'));
  const own = (await ok('snapshot', {}, teacher.code)).state; assert(own.presentationQuestions.every(item => item.question && item.answer)); assert(!JSON.stringify(own.presentationQuestions).includes('NOTA PRIVADA DE PREGUNTAS'));
});

await check('los respaldos rechazan preguntas huérfanas, duplicadas o confirmadas sin respuesta', async () => {
  const backup = await ok('backup_get');
  const missing = structuredClone(backup); missing.state.presentationQuestions[0].publisherId = 'missing'; await reject('restore_preview', { backup: missing }, 400);
  const duplicate = structuredClone(backup); duplicate.state.presentationQuestions.push({ ...duplicate.state.presentationQuestions[0], id: 'duplicate-question' }); await reject('restore_preview', { backup: duplicate }, 400);
  const empty = structuredClone(backup); empty.state.presentationQuestions[0].answer = ''; await reject('restore_preview', { backup: empty }, 400);
});

await check('reaplicar el esquema no borra preguntas, respuestas, cierres ni historial', async () => {
  const before = frozen();
  execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env, input: readFileSync(new URL('../supabase/schema.sql', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(frozen(), before);
  const response = await fetch(`${url}/rpc/textos_question_can_finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s: {}, publisher_id: 'x' }) });
  assert([401, 403].includes(response.status));
});
await check('recrear una pregunta borrada nunca reutiliza su versión ni acepta la nota de una respuesta anterior', async () => {
  const previous = (await state()).presentationQuestions.find(item => item.publisherId === publishers[1].id);
  const preview = await ok('data_delete_preview', { scope: 'question', ids: [previous.id] });
  await ok('data_delete_apply', { scope: 'question', ids: [previous.id], expectedVersion: preview.stateVersion, confirmation: 'ELIMINAR' });
  await ok('turn_control', { command: 'start', publisherId: previous.publisherId });
  const fresh = await ok('presentation_question_save', base(previous.publisherId)); assert(fresh.version > previous.version); assert.notEqual(fresh.id, previous.id);
  const current = (await state()).presentationEvaluations.find(item => item.teacherId === teacher.snapshot.actor.id && item.publisherId === previous.publisherId && item.block === 'P1');
  const fields = { publisherId: previous.publisherId, area: 'MAT', block: 'P1', scaleMax: 4, rubricVersion: 2, scores: Array(10).fill(0), responseScore: null, questionVersion: null, notes: Array(10).fill(''), generalObservation: '', physicalText: '', expectedVersion: current?.version ?? 0 };
  const draft = await ok('presentation_save', fields, teacher.code);
  await reject('presentation_save', { ...fields, expectedVersion: draft.version, responseScore: 4, questionVersion: previous.version }, 409, teacher.code);
});
console.log(`${checks} pruebas SQL/HTTP de pregunta obligatoria aprobadas.`);
