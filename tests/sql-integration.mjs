import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { demoState } from '../shared/defaults.ts';

const db = process.env.TEXTOS_TEST_DB_CONTAINER;
const rest = process.env.TEXTOS_TEST_REST_CONTAINER;
const url = process.env.TEXTOS_TEST_REST_URL;
if (!/^textos-acceptance-[0-9]+-db$/.test(db ?? '') || !/^textos-acceptance-[0-9]+-rest$/.test(rest ?? '') || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url ?? '')) throw Error('Use scripts/test-db.sh: only its isolated local acceptance stack is allowed.');
const dockerEnv = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
function docker(...args) { return execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { encoding: 'utf8', env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function sql(statement) { return docker('exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-Atc', statement); }
let checks = 0;
async function check(name, operation) { await operation(); checks += 1; console.log(`✓ ${String(checks).padStart(2, '0')} ${name}`); }
for (let retry = 0; ; retry++) {
  try { const response = await fetch(url); if (response.ok) break; } catch { /* startup */ }
  if (retry >= 50) throw Error('PostgREST did not become ready.');
  await new Promise(resolve => setTimeout(resolve, 100));
}
const owner = sql("select public.textos_bootstrap_local('demo')");
async function rpc(action, payload = {}, code = owner, dataset = 'demo') {
  const response = await fetch(`${url}/rpc/textos_api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: dataset }) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(`${action}: ${value.message ?? response.status}`); error.code = value.code; error.status = response.status; throw error; }
  return value;
}
const rejects = (operation, code) => assert.rejects(operation, error => { assert.equal(error.code, code); return true; });
function fixture() {
  const state = demoState();
  const series = new Set(state.series.slice(0, 3).map(item => item.id));
  state.offers = state.offers.filter(item => series.has(item.seriesId));
  const offerIds = new Set(state.offers.map(item => item.id));
  state.books = state.books.filter(item => offerIds.has(item.offerId));
  const bookIds = new Set(state.books.map(item => item.id));
  state.assignments = state.assignments.filter(item => bookIds.has(item.bookId));
  state.evaluations = state.evaluations.filter(item => bookIds.has(item.bookId));
  state.settings.editorsWithdrawn = true;
  state.settings.withdrawalReference = 'ACTA-RETIRO-PRUEBA';
  return state;
}
async function seed(state = fixture()) { await rpc('demo_reset', { state }); return state; }
const publish = categoryId => rpc('shortlist_publish', { categoryId, directorApproved: true, folio: `F-${categoryId}`, statement: 'Apreciación pedagógica de prueba.' });
const getState = async () => (await rpc('snapshot')).state;
const category = id => JSON.parse(sql(`select public.textos_category((select state from public.textos_datasets where id='demo'),'${id}')`));
function scores(total, i2 = 2) {
  const values = Array(10).fill(0); values[1] = i2; let remaining = total - i2;
  for (let index = 0; index < 10; index++) if (index !== 1) { values[index] = Math.min(2, remaining); remaining -= values[index]; }
  assert.equal(remaining, 0); return values;
}
function setTotal(state, offerId, total, i2 = 2, gradeId) {
  const ids = new Set(state.books.filter(item => item.offerId === offerId && (!gradeId || item.gradeId === gradeId)).map(item => item.id));
  for (const evaluation of state.evaluations) if (ids.has(evaluation.bookId)) evaluation.scores = scores(total, i2);
}
function tieFixture() {
  const state = fixture();
  const extra = demoState(); const offer = extra.offers.find(item => item.id === 'demo-series-4-MAT-P1');
  state.offers.push(offer);
  const books = extra.books.filter(item => item.offerId === offer.id); state.books.push(...books);
  const ids = new Set(books.map(item => item.id)); state.assignments.push(...extra.assignments.filter(item => ids.has(item.bookId)));
  state.evaluations.push(...extra.evaluations.filter(item => ids.has(item.bookId)).map(item => ({ ...item, status: 'closed', scores: scores(16), evidence: Array(10).fill('Evidencia de prueba de empate'), closedAt: '2026-11-04T15:00:00.000Z' })));
  setTotal(state, 'demo-series-3-MAT-P1', 16);
  return state;
}
let teacherA, teacherB;

await check('RPC requires individual access and tables/helpers reject anonymous reads', async () => {
  await rejects(() => rpc('snapshot', {}, null), 'PT401');
  for (const table of ['textos_datasets', 'textos_access', 'textos_ballots', 'textos_aggregates', 'textos_history']) {
    const response = await fetch(`${url}/${table}?select=*`); assert.ok([401, 403, 404].includes(response.status), `${table}: ${response.status}`);
  }
  const response = await fetch(`${url}/rpc/textos_bootstrap_local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.ok([401, 403, 404].includes(response.status));
});

await seed();
teacherA = (await rpc('access_create', { role: 'teacher', teacherId: 'demo-teacher-1' })).code;
teacherB = (await rpc('access_create', { role: 'teacher', teacherId: 'demo-teacher-2' })).code;
const first = fixture().books[0];
const assignmentA = `${first.id}-assignment-1`;
const assignmentB = `${first.id}-assignment-2`;
const fields = { scores: [2, 2, 2, 2, 1, 1, 1, 1, 1, 1], evidence: Array(10).fill('Evidencia propia, página 12'), notes: Array(10).fill('Nota privada de Ana'), objection: false, objectionDetail: '' };
await rpc('evaluation_reopen', { assignmentId: assignmentA, reason: 'Prueba de edición concurrente' });
await rpc('evaluation_reopen', { assignmentId: assignmentB, reason: 'Prueba simultánea' });
let versionA = 2;
await check('two teachers see only their assignments, books and private notes', async () => {
  await rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields }, teacherA); versionA += 1;
  const [a, b] = await Promise.all([rpc('snapshot', {}, teacherA), rpc('snapshot', {}, teacherB)]);
  assert.equal(a.actor.id, 'demo-teacher-1');
  assert.ok(a.state.evaluations.every(item => item.teacherId === a.actor.id));
  assert.ok(b.state.evaluations.every(item => item.teacherId === b.actor.id));
  assert.equal(JSON.stringify(b).includes('Nota privada de Ana'), false);
  assert.ok(a.state.assignments.every(item => item.teacherId === a.actor.id));
  assert.equal(a.state.sections.length, 0); assert.equal(a.state.audit.length, 0);
  await rejects(() => rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields }, teacherB), 'PT403');
  await rejects(() => rpc('evaluation_close', { assignmentId: assignmentB, expectedVersion: 2 }, teacherA), 'PT403');
  await rejects(() => rpc('backup_get', {}, teacherA), 'PT403');
});
await check('CAS rejects a stale tab and invalid indicator values', async () => {
  await rejects(() => rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA - 1, ...fields }, teacherA), 'PT409');
  for (const expectedVersion of [undefined, null]) await rejects(() => rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion, ...fields }, teacherA), 'PT409');
  for (const invalid of [-1, 3, 1.5]) await rejects(() => rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields, scores: [invalid, ...fields.scores.slice(1)] }, teacherA), 'PT400');
});
await check('null differs from a real zero; closure requires all evidence and objection detail', async () => {
  let result = await rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields, scores: [...fields.scores.slice(0, 9), null] }, teacherA); versionA = result.version;
  await rejects(() => rpc('evaluation_close', { assignmentId: assignmentA, expectedVersion: versionA }, teacherA), 'PT400');
  result = await rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields, scores: [...fields.scores.slice(0, 9), 0], evidence: Array(10).fill('') }, teacherA); versionA = result.version;
  await rejects(() => rpc('evaluation_close', { assignmentId: assignmentA, expectedVersion: versionA }, teacherA), 'PT400');
  result = await rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields, objection: true, objectionDetail: '' }, teacherA); versionA = result.version;
  await rejects(() => rpc('evaluation_close', { assignmentId: assignmentA, expectedVersion: versionA }, teacherA), 'PT400');
  result = await rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields, objection: true, objectionDetail: 'Objeción documentada en folio X.' }, teacherA); versionA = result.version;
  result = await rpc('evaluation_close', { assignmentId: assignmentA, expectedVersion: versionA }, teacherA); versionA = result.version;
  assert.equal(result.status, 'closed'); assert.equal(result.scores.reduce((a, b) => a + b, 0) * 5, 70);
  await rejects(() => rpc('evaluation_save', { assignmentId: assignmentA, expectedVersion: versionA, ...fields }, teacherA), 'PT423');
});
await check('a closed evaluation requires a documented reopening and preserves history', async () => {
  await rejects(() => rpc('evaluation_reopen', { assignmentId: assignmentA, reason: '' }), 'PT400');
  const result = await rpc('evaluation_reopen', { assignmentId: assignmentA, reason: 'Corrección documentada para prueba' });
  assert.equal(result.version, versionA + 1); assert.deepEqual(result.scores, fields.scores);
  assert.ok(Number(sql("select count(*) from public.textos_history where dataset='demo' and entity='evaluations'")) >= 3);
});

await check('SQL averages distinct teachers, all P2 grades, exact 70 and individual grade cutoff', async () => {
  const state = fixture(); const offerId = 'demo-series-1-MAT-P2';
  for (const [gradeId, total] of [['PRI3', 16], ['PRI4', 15], ['PRI5', 17], ['PRI6', 18]]) setTotal(state, offerId, total, 2, gradeId);
  const book = state.books.find(item => item.offerId === offerId && item.gradeId === 'PRI3');
  const evaluations = state.evaluations.filter(item => item.bookId === book.id); evaluations[0].scores = scores(15); evaluations[1].scores = scores(17);
  await seed(state);
  let result = category('MAT-P2').ranked.find(item => item.offerId === offerId);
  assert.equal(result.grades[0].score, 80); assert.equal(result.score, 82.5); assert.equal(result.state, 'eligible');
  setTotal(state, offerId, 13, 2, 'PRI4'); await seed(state);
  result = category('MAT-P2').ranked.find(item => item.offerId === offerId); assert.equal(result.state, 'ineligible'); assert.ok(result.score > 70);
  setTotal(state, offerId, 14, 2, 'PRI4'); await seed(state);
  result = category('MAT-P2').ranked.find(item => item.offerId === offerId); assert.equal(result.state, 'eligible'); assert.equal(result.grades.find(item => item.bookId.endsWith('PRI4')).score, 70);
});
await check('SQL resolves cutoff tie by I2, otherwise requests same-teacher additional reviews', async () => {
  const state = tieFixture(); setTotal(state, 'demo-series-3-MAT-P1', 16, 1); await seed(state);
  let result = category('MAT-P1'); assert.equal(result.state, 'ready'); assert.ok(result.finalists.includes('demo-series-4-MAT-P1')); assert.equal(result.finalists.includes('demo-series-3-MAT-P1'), false);
  setTotal(state, 'demo-series-3-MAT-P1', 16, 2); await seed(state);
  result = category('MAT-P1'); assert.equal(result.state, 'tie'); assert.equal(result.tied.length, 2);
  await rejects(() => publish('MAT-P1'), 'PT423');
  await rpc('review_request', { categoryId: 'MAT-P1', offerIds: result.tied, unitReference: 'Unidad adicional comparable, páginas 40–45', reason: 'Empate de corte que I2 no resuelve' });
  const additional = (await getState()).assignments.filter(item => item.kind === 'additional'); assert.equal(additional.length, 8);
  let additionalClosed = 0;
  for (const assignment of additional) {
    const offerId = (await getState()).books.find(item => item.id === assignment.bookId).offerId;
    const saved = await rpc('evaluation_save', { assignmentId: assignment.id, expectedVersion: 0, ...fields, scores: scores(offerId === 'demo-series-3-MAT-P1' ? 18 : 16) }, assignment.teacherId === 'demo-teacher-1' ? teacherA : teacherB);
    await rpc('evaluation_close', { assignmentId: assignment.id, expectedVersion: saved.version }, assignment.teacherId === 'demo-teacher-1' ? teacherA : teacherB);
    additionalClosed += 1;
    if (additionalClosed === 4) assert.equal(category('MAT-P1').state, 'tie', 'A complete candidate cannot outrank a peer whose comparable additional review is still pending');
  }
  result = category('MAT-P1'); assert.equal(result.state, 'ready'); assert.ok(result.finalists.includes('demo-series-3-MAT-P1'));
  const originals = (await getState()).evaluations.filter(item => state.evaluations.some(original => original.id === item.id));
  assert.deepEqual(originals.map(item => item.scores), state.evaluations.map(item => item.scores));
});
await check('an unresolved additional review stays pending instead of picking by name', async () => {
  await seed(tieFixture()); const result = category('MAT-P1');
  await rpc('review_request', { categoryId: 'MAT-P1', offerIds: result.tied, unitReference: 'Segunda unidad de prueba', reason: 'Empate irresuelto' });
  for (const assignment of (await getState()).assignments.filter(item => item.kind === 'additional')) {
    const teacherCode = assignment.teacherId === 'demo-teacher-1' ? teacherA : teacherB;
    const saved = await rpc('evaluation_save', { assignmentId: assignment.id, expectedVersion: 0, ...fields, scores: scores(16) }, teacherCode);
    await rpc('evaluation_close', { assignmentId: assignment.id, expectedVersion: saved.version }, teacherCode);
  }
  assert.equal(category('MAT-P1').state, 'tie'); await rejects(() => publish('MAT-P1'), 'PT423');
});
await check('fewer than three options requires a resolved formal article 11.3 incident and grade agreement', async () => {
  const state = fixture(); const removed = 'demo-series-3-MAT-P1';
  state.offers = state.offers.filter(item => item.id !== removed); const keepBooks = new Set(state.books.filter(item => item.offerId !== removed).map(item => item.id));
  state.books = state.books.filter(item => keepBooks.has(item.id)); state.assignments = state.assignments.filter(item => keepBooks.has(item.bookId)); state.evaluations = state.evaluations.filter(item => keepBooks.has(item.bookId));
  await seed(state); assert.equal(category('MAT-P1').state, 'less_than_three');
  const payload = { gradeId: 'PRI1', area: 'MAT', offerIds: ['demo-series-1-MAT-P1', 'demo-series-2-MAT-P1'], directorApproved: true, reason: 'Falta real de pluralidad; procedimiento y acuerdo documentados', folio: 'ART113-PRUEBA', article113: true };
  await rejects(() => rpc('shortlist_exception', payload), 'PT400');
  await rpc('incident_save', { incident: { id: '', version: 1, scope: 'article113', referenceId: 'MAT-P1/PRI1', description: payload.reason, resolution: 'Comité y Dirección aprobaron el procedimiento formal de la prueba.', folio: payload.folio } });
  const result = await rpc('shortlist_exception', payload); assert.equal(result.scope, 'grade'); assert.deepEqual(result.gradeIds, ['PRI1']); assert.equal(result.article113, true); assert.equal(result.offerIds.length, 2);
});
await check('legacy eight-indicator backup remains pending until its own teachers complete all ten', async () => {
  await seed();
  const backup = await rpc('backup_get');
  const legacyEvaluations = backup.state.evaluations.filter(item => item.bookId === first.id);
  for (const evaluation of legacyEvaluations) { evaluation.scores = evaluation.scores.slice(0, 8); evaluation.evidence = evaluation.evidence.slice(0, 8); evaluation.notes = evaluation.notes.slice(0, 8); }
  const originalEight = [...legacyEvaluations[0].scores];
  assert.equal((await rpc('restore_preview', { backup })).valid, true);
  await rpc('restore_apply', { backup, confirmation: 'RESTAURAR', reason: 'Migración de fichas antiguas de ocho indicadores' });
  let restored = (await getState()).evaluations.filter(item => item.bookId === first.id);
  for (const evaluation of restored) { assert.equal(evaluation.status, 'draft'); assert.equal(evaluation.legacyIndicatorCount, 8); assert.deepEqual(evaluation.scores.slice(0, 8), originalEight); assert.deepEqual(evaluation.scores.slice(8), [null, null]); }
  assert.equal(category('MAT-P1').state, 'review');
  await rejects(() => rpc('evaluation_close', { assignmentId: assignmentA, expectedVersion: restored.find(item => item.assignmentId === assignmentA).version }, teacherA), 'PT400');
  for (const evaluation of restored) {
    const code = evaluation.teacherId === 'demo-teacher-1' ? teacherA : teacherB;
    const saved = await rpc('evaluation_save', { assignmentId: evaluation.assignmentId, expectedVersion: evaluation.version, ...fields, scores: scores(18) }, code);
    assert.equal(saved.legacyIndicatorCount, undefined);
    await rpc('evaluation_close', { assignmentId: evaluation.assignmentId, expectedVersion: saved.version }, code);
  }
  assert.equal(category('MAT-P1').state, 'ready');
});

await check('pending offers block only their category and public projection hides provisional notes/rankings', async () => {
  await seed(demoState());
  await rejects(() => publish('MAT-P1'), 'PT400'); // withdrawal is deliberately not yet confirmed
  const state = await getState(); state.settings.editorsWithdrawn = true; state.settings.withdrawalReference = 'RETIRO';
  await rpc('settings_save', { settings: state.settings, expectedVersion: state.settings.version });
  await rejects(() => publish('MAT-P1'), 'PT423');
  const com = await publish('COM-P1'); assert.equal(com.offerIds.length, 3);
  const projection = await rpc('public_snapshot', {}, null);
  for (const key of ['evaluations', 'assignments', 'teachers', 'sections', 'audit']) assert.equal(projection.state[key].length, 0);
  assert.equal(projection.state.shortlists.some(item => item.categoryId === 'MAT-P1'), false);
});

await check('published shortlist preserves three options, rules and book snapshot and requires Director approval', async () => {
  await seed();
  await rejects(() => rpc('shortlist_publish', { categoryId: 'MAT-P1', directorApproved: false, folio: 'X' }), 'PT400');
  const result = await publish('MAT-P1'); assert.equal(result.offerIds.length, 3); assert.equal(result.rulesVersion, 1); assert.equal(result.snapshot.books.length, 6);
  await rejects(() => rpc('evaluation_reopen', { assignmentId: assignmentA, reason: 'Intento sobre terna publicada' }), 'PT423');
});

async function prepareRound(gradeId, mode) {
  for (const area of ['MAT', 'COM']) {
    const categoryId = `${area}-P1`;
    if (!(await getState()).shortlists.some(item => item.categoryId === categoryId && item.status === 'published')) await publish(categoryId);
  }
  let round = await rpc('round_create', { gradeId, mode, physicalReviewConfirmed: true });
  round = await rpc('round_open', { roundId: round.id });
  const sections = (await getState()).sections.filter(item => item.gradeId === gradeId);
  for (const section of sections) round = await rpc('delivery_mark', { roundId: round.id, sectionId: section.id, delivered: true });
  return round;
}
let digital, ballotCodes;
await check('paper cannot generate digital ballots; paper counts reconcile all deposited ballots', async () => {
  const round = await prepareRound('PRI2', 'paper');
  await rejects(() => rpc('ballots_generate', { roundId: round.id }), 'PT423');
  const [a, b, c] = round.options.MAT; const [x, y, z] = round.options.COM;
  const counts = { MAT: { options: { [a]: 2, [b]: 1, [c]: 0 }, blank: 0, invalid: 1 }, COM: { options: { [x]: 1, [y]: 2, [z]: 1 }, blank: 0, invalid: 0 } };
  for (const expectedVersion of [undefined, null]) await rejects(() => rpc('paper_tally_save', { roundId: round.id, expectedVersion, deposited: 4, counts }), 'PT409');
  await rejects(() => rpc('paper_tally_save', { roundId: round.id, expectedVersion: round.version, deposited: 3, counts }), 'PT400');
  await rpc('paper_tally_save', { roundId: round.id, expectedVersion: round.version, deposited: 4, counts });
  const closed = await rpc('round_close', { roundId: round.id });
  assert.equal(closed.results.MAT.winnerId, a); assert.equal(closed.results.COM.winnerId, y); assert.notEqual(a, y);
});
await check('concurrent duplicate code submissions commit exactly one anonymous ballot', async () => {
  digital = await prepareRound('PRI1', 'digital');
  ballotCodes = (await rpc('ballots_generate', { roundId: digital.id })).codes;
  await rejects(() => rpc('paper_tally_save', { roundId: digital.id, expectedVersion: digital.version, deposited: 1, counts: {} }), 'PT423');
  const payload = { confirmed: true, choices: { MAT: digital.options.MAT[0], COM: digital.options.COM[0] } };
  for (const confirmed of [undefined, null, false]) await rejects(() => rpc('vote_cast', { ...payload, confirmed }, ballotCodes[0]), 'PT400');
  assert.equal((await rpc('vote_preview', {}, ballotCodes[0])).roundId, digital.id);
  const responses = await Promise.allSettled([rpc('vote_cast', payload, ballotCodes[0]), rpc('vote_cast', payload, ballotCodes[0])]);
  assert.equal(responses.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(responses.filter(item => item.status === 'rejected' && item.reason.code === 'PT409').length, 1);
  const round = (await getState()).rounds.find(item => item.id === digital.id); assert.equal(round.deposited, 1);
  assert.equal(sql("select count(*) from public.textos_ballots where consumed"), '1');
  const columns = sql("select string_agg(column_name,',') from information_schema.columns where table_name='textos_ballots'");
  assert.equal(/section|representative|choice|option|teacher/.test(columns), false);
});
await check('database restart preserves consumed codes and aggregated ballots', async () => {
  docker('restart', db);
  for (let retry = 0; ; retry++) {
    try { await rpc('snapshot'); break; } catch { if (retry >= 250) throw Error('Database did not reconnect'); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  await rejects(() => rpc('vote_cast', { confirmed: true, choices: { MAT: digital.options.MAT[0], COM: digital.options.COM[0] } }, ballotCodes[0]), 'PT409');
  assert.equal((await getState()).rounds.find(item => item.id === digital.id).deposited, 1);
});
await check('a family tie only in Mathematics opens a Mathematics-only runoff', async () => {
  await rpc('vote_cast', { confirmed: true, choices: { MAT: digital.options.MAT[1], COM: digital.options.COM[0] } }, ballotCodes[1]);
  const result = await rpc('round_close', { roundId: digital.id });
  assert.equal(result.results.MAT.state, 'tie'); assert.equal(result.results.COM.state, 'winner');
  await rejects(() => rpc('runoff_open', { roundId: digital.id, area: 'COM' }), 'PT400');
  const runoff = await rpc('runoff_open', { roundId: digital.id, area: 'MAT' });
  assert.deepEqual(runoff.areas, ['MAT']); assert.equal(runoff.options.COM, undefined); assert.equal(runoff.options.MAT.length, 2);
  await rpc('round_open', { roundId: runoff.id });
  const section = (await getState()).sections.find(item => item.gradeId === 'PRI1');
  await rpc('delivery_mark', { roundId: runoff.id, sectionId: section.id, delivered: true });
  const [code] = (await rpc('ballots_generate', { roundId: runoff.id })).codes;
  await rejects(() => rpc('vote_cast', { confirmed: true, choices: { MAT: runoff.options.MAT[0], COM: null } }, code), 'PT400');
});
await check('restoring before a known vote suspends the round and never reactivates a consumed token', async () => {
  await seed(); digital = await prepareRound('PRI1', 'digital');
  const [code] = (await rpc('ballots_generate', { roundId: digital.id, count: 1 })).codes;
  const before = await rpc('backup_get');
  await rpc('vote_cast', { confirmed: true, choices: { MAT: digital.options.MAT[0], COM: null } }, code);
  const preview = await rpc('restore_preview', { backup: before }); assert.ok(preview.suspendedRoundIds.includes(digital.id));
  const result = await rpc('restore_apply', { backup: before, confirmation: 'RESTAURAR', reason: 'Prueba de conciliación de copia anterior al voto' }); assert.equal(result.restored, true);
  assert.equal((await getState()).rounds.find(item => item.id === digital.id).status, 'suspended');
  await rejects(() => rpc('vote_cast', { confirmed: true, choices: { MAT: digital.options.MAT[0], COM: null } }, code), 'PT409');
  await rejects(() => rpc('round_open', { roundId: digital.id }), 'PT423');
  const reconciled = await rpc('round_reconcile', { roundId: digital.id, action: 'void-and-restart', reason: 'Conciliación documentada de la prueba' }); assert.equal(reconciled.status, 'draft');
  assert.notEqual(reconciled.id, digital.id);
});
await check('restoring an open snapshot of a known closed round requires reconciliation', async () => {
  await seed(); const round = await prepareRound('PRI1', 'digital');
  const [code] = (await rpc('ballots_generate', { roundId: round.id, count: 1 })).codes;
  await rpc('vote_cast', { confirmed: true, choices: { MAT: round.options.MAT[0], COM: round.options.COM[0] } }, code);
  const openSnapshot = await rpc('backup_get');
  await rpc('round_close', { roundId: round.id });
  const preview = await rpc('restore_preview', { backup: openSnapshot }); assert.ok(preview.suspendedRoundIds.includes(round.id));
  await rpc('restore_apply', { backup: openSnapshot, confirmation: 'RESTAURAR', reason: 'Prueba: no volver a abrir una ronda ya cerrada' });
  assert.equal((await getState()).rounds.find(item => item.id === round.id).status, 'suspended');
  await rejects(() => rpc('round_open', { roundId: round.id }), 'PT423');
});
await check('fresh real installation suspends imported open/draft lineages, issues fresh reconciled codes and preserves closed results', async () => {
  // This process is guarded above to run only inside scripts/test-db.sh's disposable DB.
  // Never read local owner files or connect this fixture to the school's installation.
  const realOwner = sql("select public.textos_bootstrap_local('real')");
  const realRpc = (action, payload = {}, code = realOwner) => rpc(action, payload, code, 'real');
  const resetReal = () => sql("delete from public.textos_ballots where dataset='real'; delete from public.textos_aggregates where dataset='real'; delete from public.textos_history where dataset='real'; update public.textos_datasets set state=public.textos_empty_state() where id='real'");
  function realBackup(source) {
    const backup = structuredClone(source); backup.dataset = 'real';
    const codes = [];
    // Hashes are globally unique; give this synthetic real fixture its own private codes.
    backup.ballots = backup.ballots.map(ballot => {
      const code = randomBytes(32).toString('hex'); codes.push({ code, consumed: ballot.consumed });
      return { ...ballot, dataset: 'real', code_hash: createHash('sha256').update(code).digest('hex') };
    });
    backup.aggregates = backup.aggregates.map(aggregate => ({ ...aggregate, dataset: 'real' }));
    backup.history = (backup.history ?? []).map(entry => ({ ...entry, dataset: 'real' }));
    return { backup, codes };
  }
  try {
    sql("delete from public.textos_history where dataset='demo'");
    await seed();
    const sourceRound = await prepareRound('PRI1', 'digital');
    const sourceDraft = await rpc('round_create', { gradeId: 'PRI2', mode: 'digital', physicalReviewConfirmed: true });
    const [sourceCode] = (await rpc('ballots_generate', { roundId: sourceRound.id, count: 1 })).codes;
    const openImport = realBackup(await rpc('backup_get'));
    const preview = await realRpc('restore_preview', { backup: openImport.backup });
    assert.ok(preview.suspendedRoundIds.includes(sourceRound.id));
    assert.ok(preview.suspendedRoundIds.includes(sourceDraft.id));
    await realRpc('restore_apply', { backup: openImport.backup, confirmation: 'RESTAURAR', reason: 'Prueba aislada: recuperación en instalación nueva sin historial local' });
    const importedState = (await realRpc('snapshot')).state;
    assert.equal(importedState.rounds.find(item => item.id === sourceRound.id).status, 'suspended');
    assert.equal(importedState.rounds.find(item => item.id === sourceDraft.id).status, 'suspended');
    const importedCode = openImport.codes.find(item => !item.consumed).code;
    await rejects(() => realRpc('vote_preview', {}, importedCode), 'PT423');
    await rejects(() => realRpc('vote_cast', { confirmed: true, choices: { MAT: sourceRound.options.MAT[0], COM: null } }, importedCode), 'PT423');
    await rejects(() => realRpc('round_open', { roundId: sourceRound.id }), 'PT423');
    const reconciled = await realRpc('round_reconcile', { roundId: sourceRound.id, action: 'void-and-restart', reason: 'Acta de conciliación en la instalación de prueba nueva' });
    assert.notEqual(reconciled.id, sourceRound.id); assert.equal(reconciled.status, 'draft');
    await realRpc('round_open', { roundId: reconciled.id });
    const section = importedState.sections.find(item => item.gradeId === reconciled.gradeId);
    await realRpc('delivery_mark', { roundId: reconciled.id, sectionId: section.id, delivered: true });
    const [freshCode] = (await realRpc('ballots_generate', { roundId: reconciled.id, count: 1 })).codes;
    assert.notEqual(freshCode, importedCode);
    assert.equal((await realRpc('vote_preview', {}, freshCode)).roundId, reconciled.id);
    await rejects(() => realRpc('vote_preview', {}, importedCode), 'PT423');

    await rpc('vote_cast', { confirmed: true, choices: { MAT: sourceRound.options.MAT[0], COM: sourceRound.options.COM[0] } }, sourceCode);
    const sourceClosed = await rpc('round_close', { roundId: sourceRound.id });
    const closedImport = realBackup(await rpc('backup_get'));
    resetReal();
    const closedPreview = await realRpc('restore_preview', { backup: closedImport.backup });
    assert.equal(closedPreview.suspendedRoundIds.includes(sourceRound.id), false);
    await realRpc('restore_apply', { backup: closedImport.backup, confirmation: 'RESTAURAR', reason: 'Prueba aislada: recuperar resultados cerrados en instalación nueva' });
    const importedClosed = (await realRpc('snapshot')).state.rounds.find(item => item.id === sourceClosed.id);
    assert.equal(importedClosed.status, 'closed');
    assert.deepEqual(importedClosed.results, sourceClosed.results);
    assert.deepEqual(importedClosed.counts, sourceClosed.counts);
    assert.equal(importedClosed.closedAt, sourceClosed.closedAt);
  } finally { resetReal(); }
});
await check('same-snapshot backup restores closures, shortlist snapshots and totals, leaving real dataset empty', async () => {
  const before = await rpc('backup_get');
  await rpc('restore_apply', { backup: before, confirmation: 'RESTAURAR', reason: 'Prueba de restauración consistente' });
  const after = await rpc('backup_get');
  for (const key of ['evaluations', 'shortlists', 'rounds']) assert.deepEqual(after.state[key], before.state[key]);
  assert.deepEqual(after.ballots, before.ballots); assert.deepEqual(after.aggregates, before.aggregates);
  const real = JSON.parse(sql("select state from public.textos_datasets where id='real'")); assert.equal(real.books.length, 0); assert.equal(real.evaluations.length, 0); assert.equal(real.rounds.length, 0);
});
console.log(`\n${checks} pruebas SQL/HTTP aprobadas en PostgreSQL/PostgREST aislados. La base real de esta prueba permanece vacía.`);
