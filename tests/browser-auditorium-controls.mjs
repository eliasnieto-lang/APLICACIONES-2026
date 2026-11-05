// Isolated UI test: every API call is intercepted; no database or production access.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation, presentationSummary } from '../shared/presentation.ts';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }); await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const contexts = [], checks = [], pageErrors = [], calls = [];
let state = emptyState(), failure = null, failRefresh = false;
const check = async (name, action) => { await action(); checks.push(name); console.log(`✓ ${name}`); };
function ready() {
  const s = emptyState();
  s.publishers = Array.from({ length: 4 }, (_, i) => ({ id: `screen-p${i}`, version: 1, name: `Editorial de prueba ${i + 1}`, contact: 'CONTACTO_PRIVADO', samplesReceived: true, sampleNote: '' }));
  s.teachers = ['MAT', 'COM'].map(area => ({ id: `t-${area}`, version: 1, name: 'DOCENTE_PRIVADO', area, categories: ['P1'], attended: true, attendanceEvidence: '' }));
  s.presentationEvaluations = s.teachers.flatMap(teacher => s.publishers.map((publisher, index) => ({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1' }), id: `${teacher.id}-${publisher.id}`, version: 1, scores: Array(10).fill(4 - index), responseScore: 4 - index, notes: Array(10).fill('FICHA_PRIVADA'), status: 'closed', closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
  s.presentationDraw = { id: 'screen-draw', version: 1, publishers: s.publishers.map(({ id, name }) => ({ id, name })), completedPublisherIds: s.publishers.map(p => p.id), createdBy: 'Subdirección', createdAt: new Date().toISOString() };
  s.presentationRanking = { id: 'screen-ranking', version: 1, drawId: s.presentationDraw.id, categories: presentationSummary(s), provisional: false, stale: false, createdAt: new Date().toISOString() };
  return s;
}
async function open(role = 'coordinator', viewport = { width: 1360, height: 960 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/auditorium-controls-fixture.tsx';" }));
  await context.route('**/api/auditorium-control-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') {
      if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, json: { message: 'No se pudo actualizar.' } }); }
      return route.fulfill({ json: { state, actor: { id: 'actor', name: 'Subdirección', role }, dataset: 'demo', serverNow: new Date().toISOString() } });
    }
    assert.equal(action, 'settings_save'); assert.equal(role, 'coordinator');
    if (failure) { const rejected = failure; failure = null; return route.fulfill({ status: rejected.status, json: { message: rejected.message } }); }
    if (payload.expectedVersion !== state.settings.version) return route.fulfill({ status: 409, json: { message: 'La configuración cambió en otra sesión.' } });
    assert.deepEqual(payload.settings.rules, state.settings.rules);
    const before = structuredClone(state); state.settings = { ...payload.settings, version: state.settings.version + 1 };
    for (const key of ['publishers', 'teachers', 'presentationEvaluations', 'presentationDraw', 'presentationRanking', 'turn']) assert.deepEqual(state[key], before[key]);
    return route.fulfill({ json: state.settings });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => window.auditoriumControlFixture?.loaded);
  return page;
}
const refresh = page => page.evaluate(() => window.auditoriumControlFixture.refresh());
const startButton = page => page.getByRole('button', { name: /Iniciar (nueva )?visita a mesas/ });
try {
  const page = await open(); const controls = page.getByRole('region', { name: 'Proyección de indicaciones y visita a mesas' });
  await check('instructions project before the draw and need no ranking, extra password or SQL action', async () => {
    assert(await startButton(page).isDisabled());
    await page.getByRole('button', { name: 'Proyectar indicaciones', exact: true }).click();
    await page.getByText('Indicaciones generales en pantalla.', { exact: true }).waitFor();
    assert.equal(state.settings.auditoriumDisplay.mode, 'instructions'); assert.deepEqual(state.settings.auditoriumDisplay.categories, []);
    assert.equal(calls.filter(c => c.action !== 'snapshot').length, 1); assert.equal(calls.find(c => c.action !== 'snapshot').action, 'settings_save');
  });
  await check('visit duration is editable from 1 to 60 minutes and missing finalists never enable it', async () => {
    const input = page.getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }); assert.equal(await input.inputValue(), '10');
    await input.fill('0'); assert(await startButton(page).isDisabled()); await page.getByText('Seleccione entre 1 y 60 minutos para la visita.').waitFor();
    await input.fill('61'); assert(await startButton(page).isDisabled()); await input.fill('2'); assert(await startButton(page).isDisabled());
  });
  await check('a final ranking projects exactly three proposals per ready category with a shared end timestamp', async () => {
    state = ready(); await refresh(page); await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Iniciar visita a mesas'))?.disabled);
    const before = structuredClone(state.presentationEvaluations); const time = Date.now();
    await startButton(page).click(); await page.getByText('Visita en curso', { exact: true }).waitFor();
    const display = state.settings.auditoriumDisplay; assert.equal(display.visit.durationSeconds, 120); assert.equal(display.categories.length, 2); assert(display.categories.every(c => c.publishers.length === 3));
    assert(Math.abs(Date.parse(display.visit.endsAt) - time - 120000) < 3000);
    assert.doesNotMatch(JSON.stringify(display), /CONTACTO_PRIVADO|DOCENTE_PRIVADO|FICHA_PRIVADA|notes|teacherId/); assert.deepEqual(state.presentationEvaluations, before);
    assert.equal(await page.getByRole('link', { name: 'Abrir pantalla pública', exact: true }).getAttribute('href'), '/?vista=publica&datos=demo');
  });
  await check('pause, reload, resume and finish preserve the visit clock and never touch an exposition', async () => {
    state.settings.auditoriumDisplay.visit.endsAt = new Date(Date.now() + 90000).toISOString(); state.settings.version++; await refresh(page);
    await page.waitForFunction(() => /^01:(29|30|31)$/.test(document.querySelector('[aria-label="Tiempo restante de visita a mesas"]')?.textContent ?? ''));
    await page.getByRole('button', { name: 'Pausar visita', exact: true }).click(); await page.getByText('Visita pausada', { exact: true }).waitFor();
    const paused = structuredClone(state.settings.auditoriumDisplay.visit); assert.equal(paused.endsAt, null); assert(paused.remainingSeconds >= 88 && paused.remainingSeconds <= 91);
    await page.reload(); await page.getByText('Visita pausada', { exact: true }).waitFor(); assert.equal(await page.getByRole('timer', { name: 'Tiempo restante de visita a mesas' }).innerText(), `${Math.floor(paused.remainingSeconds / 60).toString().padStart(2, '0')}:${(paused.remainingSeconds % 60).toString().padStart(2, '0')}`);
    await page.getByRole('button', { name: 'Reanudar visita', exact: true }).click(); await page.getByText('Visita en curso', { exact: true }).waitFor();
    assert.equal(state.settings.auditoriumDisplay.visit.remainingSeconds, paused.remainingSeconds);
    await page.getByRole('button', { name: 'Finalizar visita', exact: true }).click(); await page.getByText('Tiempo de visita concluido', { exact: true }).waitFor(); assert.equal(state.settings.auditoriumDisplay.visit.remainingSeconds, 0);
  });
  await check('a stale settings version cannot overwrite the other screen and preserves the locally edited duration', async () => {
    const input = page.getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }); await input.fill('7');
    const other = { schemaVersion: 1, version: 50, mode: 'instructions', categories: [] }; state.settings = { ...state.settings, version: state.settings.version + 1, auditoriumDisplay: other };
    await startButton(page).click(); await page.getByRole('button', { name: 'Actualizar datos de proyección', exact: true }).waitFor();
    assert.deepEqual(state.settings.auditoriumDisplay, other); assert.equal(await input.inputValue(), '7'); assert(await startButton(page).isDisabled());
    await page.getByRole('button', { name: 'Actualizar datos de proyección', exact: true }).click(); await page.getByText('Indicaciones generales en pantalla.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '7'); await startButton(page).click(); await page.getByText('Visita en curso', { exact: true }).waitFor(); assert.equal(state.settings.auditoriumDisplay.visit.durationSeconds, 420);
  });
  await check('connection failure never pretends to change the screen and retries preserve duration', async () => {
    await page.getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }).fill('8'); const before = structuredClone(state.settings.auditoriumDisplay);
    failure = { status: 503, message: 'Sin conexión para guardar la proyección.' }; await startButton(page).click();
    await page.getByRole('alert').filter({ hasText: 'Sin conexión para guardar la proyección.' }).waitFor(); assert.deepEqual(state.settings.auditoriumDisplay, before);
    assert.equal(await page.getByLabel('Tiempo de visita a las mesas (minutos)', { exact: true }).inputValue(), '8'); assert(await startButton(page).isEnabled());
  });
  await check('a stale ranking blocks publishing another visit and returning to the room removes only the display', async () => {
    state.presentationRanking.stale = true; await refresh(page); await page.getByText(/La clasificación cambió/).waitFor(); assert(await startButton(page).isDisabled());
    const grades = structuredClone(state.presentationEvaluations); await page.getByRole('button', { name: 'Volver a Sala en vivo', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Tiempo restante de visita a mesas"]')); assert.equal(state.settings.auditoriumDisplay, null); assert.deepEqual(state.presentationEvaluations, grades);
  });
  await check('control permissions and a 390px phone keep projection actions private and readable', async () => {
    state.presentationRanking.stale = false;
    const mobile = await open('coordinator', { width: 390, height: 844 });
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    mkdirSync('test-results', { recursive: true }); await mobile.screenshot({ path: 'test-results/auditorium-controls-mobile.png', fullPage: true });
    for (const role of ['teacher', 'secretary', 'public']) { const p = await open(role); assert.equal(await p.getByRole('region', { name: 'Proyección de indicaciones y visita a mesas' }).count(), 0); }
  });
  assert.deepEqual(pageErrors, []); mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/auditorium-controls-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated intercepted settings_save API, no database changes', passed: checks.length, checks, pageErrors }, null, 2));
} finally { for (const c of contexts) await c.close(); await browser.close(); await vite.close(); }
