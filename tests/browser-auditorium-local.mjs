// Real local acceptance only: every mutation is hard-coded to the demo dataset.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation } from '../shared/presentation.ts';

const base = process.env.TEXTOS_BROWSER_URL || 'http://127.0.0.1:39001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw Error('Use the disposable local demo installation.');
const owner = readFileSync('local/demo-owner-code.txt', 'utf8').trim();
const privateNote = 'OBSERVACION_RESERVADA_AUDITORIO';
const checks = [], pageErrors = [], cspErrors = [], contexts = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
async function rawRpc(action, payload = {}, code = owner) {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  return { status: response.status, body: await response.json() };
}
async function rpc(action, payload = {}) {
  const result = await rawRpc(action, payload);
  assert.equal(result.status, 200, `${action}: ${String(result.body.error?.message ?? result.body.message ?? '').split(owner).join('[redacted]')}`);
  return result.body;
}
const snapshot = () => rpc('snapshot');
const currentState = async () => (await snapshot()).state;
function academicState(state) {
  return { rules: state.settings.rules, publishers: state.publishers, teachers: state.teachers,
    evaluations: state.presentationEvaluations, questions: state.presentationQuestions,
    draw: state.presentationDraw, turn: state.turn, polls: state.paperPolls ?? [], ranking: state.presentationRanking };
}
function parseClock(value) { const parts = value.trim().split(':').map(Number); assert.equal(parts.length, 2); return parts[0] * 60 + parts[1]; }
function publicDisplay(snapshotValue) {
  const display = snapshotValue.state.settings.auditoriumDisplay;
  assert(!JSON.stringify(snapshotValue.state).includes(privateNote));
  assert(!JSON.stringify(snapshotValue.state).includes('DOCENTE PRIVADO'));
  assert(!JSON.stringify(display).includes('CONTACTO_RESERVADO'));
  assert(!JSON.stringify(display).includes(owner));
  return display;
}
const seeded = emptyState();
const before = new Date(Date.now() - 30 * 60 * 1000).toISOString();
seeded.settings.rules.presentationSeconds = 900;
seeded.settings.rules.transitionSeconds = 120;
seeded.settings.rules.lockedAt = before;
seeded.publishers = ['alfa', 'beta', 'gamma'].map(id => ({ id: `auditorio-${id}`, version: 1,
  name: `Editorial ${id.toUpperCase()}`, contact: 'CONTACTO_RESERVADO', samplesReceived: true, sampleNote: 'Mesa de muestra del ensayo' }));
seeded.teachers = ['MAT', 'COM'].map(area => ({ id: `auditorio-${area}`, version: 1,
  name: `DOCENTE PRIVADO ${area}`, firstNames: 'Docente', lastNames: `Privado ${area}`, area, categories: ['P1'], selfRegistered: true,
  attended: true, attendanceEvidence: 'Ensayo local' }));
for (const teacher of seeded.teachers) for (const [index, publisher] of seeded.publishers.entries()) {
  const value = 4 - index;
  seeded.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1' }),
    id: `auditorio-ficha-${teacher.area}-${publisher.id}`, version: 1, responseScore: value, questionVersion: null,
    scores: Array(10).fill(value), notes: Array(10).fill(privateNote), generalObservation: privateNote,
    status: 'closed', closedAt: before, updatedAt: before });
}
seeded.presentationQuestions = seeded.publishers.map(publisher => ({ id: `auditorio-pregunta-${publisher.id}`, version: 1,
  publisherId: publisher.id, confirmed: true, status: 'answered', askedAt: before, answeredAt: before, updatedAt: before }));
seeded.presentationDraw = { id: 'auditorio-sorteo', version: 1, publishers: seeded.publishers.map(({ id, name }) => ({ id, name })),
  completedPublisherIds: seeded.publishers.map(publisher => publisher.id), createdAt: before, createdBy: 'Subdirección' };
seeded.turn = { publisherId: seeded.publishers.at(-1).id, status: 'finished', startedAt: before, pausedAt: before, pausedMilliseconds: 0 };

mkdirSync('test-results', { recursive: true });
rmSync('test-results/auditorium-local-browser-results.json', { force: true });
await rpc('demo_reset', { state: seeded });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function page(viewport = { width: 1360, height: 960 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  const result = await context.newPage(); result.setDefaultTimeout(30000);
  result.on('pageerror', error => pageErrors.push(error.message));
  result.on('console', message => { if (message.type() === 'error' && /content security policy|content-security-policy|refused to (?:frame|load|connect).*blob:/i.test(message.text())) cspErrors.push(message.text()); });
  return result;
}
async function uiRpc(target, action, operation) {
  const pending = target.waitForResponse(response => {
    try { return response.request().method() === 'POST' && response.request().postDataJSON()?.p_action === action; } catch { return false; }
  });
  void pending.catch(() => undefined); await operation();
  const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, `${action}: ${String(body.error?.message ?? body.message ?? '').split(owner).join('[redacted]')}`);
  return body;
}
async function syncDirector() {
  await uiRpc(director, 'snapshot', () => director.getByRole('button', { name: 'Actualizar información', exact: true }).click());
  await director.getByRole('button', { name: 'Proyectar indicaciones', exact: true }).waitFor({ state: 'visible' });
}
async function syncPublic(target = publicPage) {
  await uiRpc(target, 'public_snapshot', () => target.getByRole('button', { name: 'Actualizar', exact: true }).click());
}
const director = await page();
const publicPage = await page();
let frozenAcademic, votePoll, pausedRemaining;
const controls = () => director.getByRole('region', { name: 'Proyección de indicaciones y visita a mesas', exact: true });
const visitTimer = target => target.getByRole('timer', { name: 'Tiempo restante para visitar las mesas', exact: true });
try {
  await check('Sala explains the complete process with fifteen shared minutes, public pack prices, eleven criteria and mandatory withdrawal', async () => {
    await director.goto(`${base}/?datos=demo#access=${encodeURIComponent(owner)}`);
    await director.getByRole('button', { name: 'Actualizar información', exact: true }).waitFor();
    assert(!director.url().includes(owner));
    await director.getByRole('button', { name: 'Sala en vivo', exact: true }).click();
    await director.locator('details[aria-label="Indicaciones generales de la jornada"] > summary').click();
    const instructions = director.getByRole('region', { name: 'Indicaciones generales para representantes editoriales', exact: true });
    await instructions.waitFor(); const text = await instructions.innerText();
    assert.match(text, /15 minutos/); assert.match(text, /dos o más representantes/); assert.match(text, /mismo tiempo total/);
    assert.match(text, /precio de venta al público/); assert.match(text, /año de edición/); assert.match(text, /Matemática y Comunicación/);
    assert.match(text, /I3/); assert.match(text, /44 puntos/); assert.equal(await instructions.locator('[data-criterion]').count(), 11);
    assert.match(text, /TODOS LOS REPRESENTANTES EDITORIALES DEBEN ABANDONAR EL AUDITORIO/);
    assert.match(text, /tres propuestas finalistas por cada área y grupo de grados/); assert.match(text, /mesas de muestra/);
    assert.match(text, /no queda determinada por el primer puesto docente/);
    assert.equal(await controls().getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }).inputValue(), '10');
    assert(await controls().getByRole('button', { name: 'Iniciar visita a mesas', exact: true }).isDisabled());
  });
  await check('instructions can be projected before a ranking through the existing API and appear to an unauthenticated public viewer', async () => {
    const academic = academicState(await currentState());
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Proyectar indicaciones', exact: true }).click());
    assert.equal(saved.auditoriumDisplay.mode, 'instructions'); assert.deepEqual(saved.auditoriumDisplay.categories, []);
    await publicPage.goto(`${base}/?vista=publica&datos=demo`);
    await publicPage.getByRole('region', { name: 'Indicaciones para las editoriales', exact: true }).waitFor();
    assert.equal(await publicPage.getByRole('timer').count(), 0);
    assert.equal(publicDisplay(await rpc('public_snapshot')).mode, 'instructions');
    assert.deepEqual(academicState(await currentState()), academic);
    await director.screenshot({ path: 'test-results/auditorium-indicaciones-sala.png', fullPage: true });
  });
  await check('a real final ranking enables exactly three current proposals per area while previous classroom votes remain available', async () => {
    const ranking = await rpc('presentation_ranking_generate', { expectedVersion: 0 }); assert.equal(ranking.provisional, false);
    votePoll = await rpc('paper_poll_create', { block: 'P1', areas: ['MAT', 'COM'], rankingId: ranking.id, expectedRankingVersion: ranking.version });
    const result = await rpc('paper_manual_cast', { pollId: votePoll.id, classroomId: 'PRI1-A', choices: { MAT: seeded.publishers[1].id, COM: seeded.publishers[0].id }, expectedVersion: votePoll.version, confirmation: true });
    votePoll = result.poll; frozenAcademic = academicState(await currentState());
    await syncDirector();
    await controls().getByText('2 categorías con tres finalistas listas para proyectar:', { exact: true }).waitFor();
    assert(await controls().getByRole('button', { name: 'Iniciar visita a mesas', exact: true }).isEnabled());
    await syncPublic();
    await publicPage.getByRole('table', { name: 'Votos registrados por aula', exact: true }).waitFor();
    assert.equal(await publicPage.getByRole('table', { name: 'Votos registrados por aula', exact: true }).locator('tbody tr').count(), 10);
  });
  await check('starting a ten-minute visit publishes only six aggregate finalist cards and a shared persistent deadline', async () => {
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Iniciar visita a mesas', exact: true }).click());
    const display = saved.auditoriumDisplay; assert.equal(display.mode, 'samples'); assert.equal(display.visit.durationSeconds, 600);
    assert.equal(display.categories.length, 2); assert(display.categories.every(category => category.publishers.length === 3));
    for (const category of display.categories) for (const publisher of category.publishers) assert.deepEqual(Object.keys(publisher).sort(), ['id', 'name', 'score']);
    await syncPublic(); await publicPage.getByRole('heading', { name: 'Visita a las mesas de muestra', exact: true }).waitFor();
    assert.equal(await publicPage.locator('.auditorium-finalist-category').count(), 2);
    assert.equal(await publicPage.locator('.auditorium-finalist-category li').count(), 6);
    assert.equal(await publicPage.getByRole('timer').count(), 1);
    const remaining = parseClock(await visitTimer(publicPage).innerText()); assert(remaining <= 600 && remaining >= 570);
    const projected = publicDisplay(await rpc('public_snapshot')); assert.deepEqual(projected, display);
    assert.deepEqual(academicState(await currentState()), frozenAcademic);
  });
  await check('Subdirection can choose a prudent visit duration and another public session keeps the same countdown after reloading', async () => {
    await controls().getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }).fill('1');
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Iniciar nueva visita a mesas', exact: true }).click());
    assert.equal(saved.auditoriumDisplay.visit.durationSeconds, 60);
    await publicPage.reload(); await visitTimer(publicPage).waitFor();
    const remaining = parseClock(await visitTimer(publicPage).innerText()); assert(remaining <= 60 && remaining >= 40);
    assert.equal(publicDisplay(await rpc('public_snapshot')).visit.endsAt, saved.auditoriumDisplay.visit.endsAt);
  });
  await check('pausing freezes the public timer across a page reload without affecting the exposition or teacher scores', async () => {
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Pausar visita', exact: true }).click());
    assert.equal(saved.auditoriumDisplay.visit.status, 'paused'); assert.equal(saved.auditoriumDisplay.visit.endsAt, null);
    pausedRemaining = saved.auditoriumDisplay.visit.remainingSeconds;
    await syncPublic(); await publicPage.getByText('Visita pausada', { exact: true }).waitFor();
    const pausedText = await visitTimer(publicPage).innerText(); assert.equal(parseClock(pausedText), pausedRemaining);
    await publicPage.waitForTimeout(1200); assert.equal(await visitTimer(publicPage).innerText(), pausedText);
    const other = await page(); await other.goto(`${base}/?vista=publica&datos=demo`); await visitTimer(other).waitFor();
    assert.equal(await visitTimer(other).innerText(), pausedText); await publicPage.reload(); await visitTimer(publicPage).waitFor();
    assert.equal(await visitTimer(publicPage).innerText(), pausedText);
    assert.deepEqual(academicState(await currentState()), frozenAcademic);
  });
  await check('resuming assigns a new shared end timestamp and keeps the same classified proposals', async () => {
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Reanudar visita', exact: true }).click());
    assert.equal(saved.auditoriumDisplay.visit.status, 'running'); assert(saved.auditoriumDisplay.visit.endsAt);
    assert.equal(saved.auditoriumDisplay.visit.remainingSeconds, pausedRemaining);
    await syncPublic(); await publicPage.getByText('Tiempo para visitar las mesas', { exact: true }).waitFor();
    const remaining = parseClock(await visitTimer(publicPage).innerText()); assert(remaining <= pausedRemaining && remaining >= pausedRemaining - 8);
    assert.equal(await publicPage.locator('.auditorium-finalist-category li').count(), 6);
  });
  await check('the public board fits a phone and a projector while the classroom-vote ledger remains accessible', async () => {
    await publicPage.setViewportSize({ width: 390, height: 844 });
    assert(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await publicPage.screenshot({ path: 'test-results/auditorium-visita-publica-movil.png', fullPage: true });
    assert.equal(await publicPage.getByRole('table', { name: 'Votos registrados por aula', exact: true }).locator('tbody tr').count(), 10);
    await publicPage.setViewportSize({ width: 1920, height: 1080 });
    assert(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await publicPage.screenshot({ path: 'test-results/auditorium-visita-proyector.png', fullPage: true });
    assert.deepEqual(academicState(await currentState()), frozenAcademic);
  });
  await check('expiry reaches zero without a new SQL action and explicit finish preserves the finalists for the families', async () => {
    const current = await snapshot(); const display = structuredClone(current.state.settings.auditoriumDisplay);
    display.version++; display.visit.status = 'running'; display.visit.remainingSeconds = 2;
    display.visit.endsAt = new Date(Date.parse(current.serverNow) + 2500).toISOString();
    await rpc('settings_save', { settings: { ...current.state.settings, auditoriumDisplay: display }, expectedVersion: current.state.settings.version });
    await syncPublic();
    await publicPage.waitForFunction(() => document.querySelector('[aria-label="Tiempo restante para visitar las mesas"]')?.textContent === '00:00', undefined, { timeout: 10000 });
    await publicPage.getByText('Tiempo de visita concluido.', { exact: true }).waitFor();
    await publicPage.reload(); await visitTimer(publicPage).waitFor(); assert.equal(await visitTimer(publicPage).innerText(), '00:00');
    await syncDirector(); await director.waitForFunction(() => document.querySelector('[aria-label="Tiempo restante de visita a mesas"]')?.textContent === '00:00');
    const finished = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Finalizar visita', exact: true }).click());
    assert.equal(finished.auditoriumDisplay.visit.status, 'finished'); assert.equal(finished.auditoriumDisplay.visit.remainingSeconds, 0);
    await syncPublic(); assert.equal(await publicPage.locator('.auditorium-finalist-category li').count(), 6);
    assert.deepEqual(academicState(await currentState()), frozenAcademic);
  });
  await check('returning to Sala removes the projection, keeps the classroom ledger and rejects a stale settings write', async () => {
    const previous = await currentState();
    const saved = await uiRpc(director, 'settings_save', () => controls().getByRole('button', { name: 'Volver a Sala en vivo', exact: true }).click());
    assert.equal(saved.auditoriumDisplay, null); await syncPublic();
    await publicPage.locator('.auditorium-screen').waitFor({ state: 'detached' });
    assert.equal(await publicPage.getByRole('table', { name: 'Votos registrados por aula', exact: true }).locator('tbody tr').count(), 10);
    const rejected = await rawRpc('settings_save', { settings: previous.settings, expectedVersion: previous.settings.version }); assert.equal(rejected.status, 409);
    assert.equal((await currentState()).settings.auditoriumDisplay, null);
    assert.deepEqual(academicState(await currentState()), frozenAcademic);
    assert.equal(pageErrors.length, 0, pageErrors.join('\n')); assert.equal(cspErrors.length, 0, cspErrors.join('\n'));
  });
  const result = { at: new Date().toISOString(), backend: 'real local Node/Express + PostgreSQL/PostgREST, SQL007 unchanged; demo mutations only', passed: checks.length, checks, pageErrors, cspErrors };
  assert(!JSON.stringify(result).includes(owner)); writeFileSync('test-results/auditorium-local-browser-results.json', JSON.stringify(result, null, 2));
  console.log(`${checks.length} recorridos reales de indicaciones y visita al auditorio aprobados.`);
} catch (error) {
  try { await director.screenshot({ path: 'test-results/auditorium-local-failure.png', fullPage: true }); } catch {}
  throw error;
} finally {
  for (const context of contexts) await context.close(); await browser.close();
}
