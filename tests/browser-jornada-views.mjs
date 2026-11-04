// Browser-only UI checks against intercepted in-memory fixture data; never production.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation, presentationSummary } from '../shared/presentation.ts';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0, preTransformRequests: false, hmr: { overlay: false } }, logLevel: 'error' });
await vite.listen(); const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [], checks = [];
const state = emptyState();
state.publishers = ['a', 'b', 'c'].map(id => ({ id, name: `Editorial ${id}`, version: 1, samplesReceived: false, sampleNote: '' }));
state.teachers = Array.from({ length: 9 }, (_, index) => ({ id: `teacher-${index}`, name: `Docente ${index}`, version: 1, area: 'MAT', categories: ['P1'], attended: false, attendanceEvidence: '' }));
state.presentationDraw = { id: 'draw-ui', version: 1, publishers: [state.publishers[2], state.publishers[0], state.publishers[1]].map(({ id, name }) => ({ id, name })), completedPublisherIds: ['c'], createdAt: new Date().toISOString(), createdBy: 'Subdirector' };
state.turn = { publisherId: 'a', status: 'running', startedAt: new Date().toISOString(), pausedAt: null, pausedMilliseconds: 0 };
const form = (id, publisherId, scores, status = 'draft', scaleMax = 4) => ({ ...newPresentationEvaluation({ publisherId, teacherId: 'teacher-0', area: 'MAT', block: 'P1' }), id, version: 1, scores, status, scaleMax });
state.presentationEvaluations = [form('c-form', 'c', Array(10).fill(0), 'closed'), form('a-form', 'a', [0, 4, ...Array(8).fill(null)]), form('b-form', 'b', Array(10).fill(2), 'closed', 2)];
const context = await browser.newContext({ viewport: { width: 1360, height: 980 } });
await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/jornada-fixture.tsx';" }));
await context.route('**/api/jornada-fixture', async route => {
  const { action, view } = route.request().postDataJSON();
  if (action === 'snapshot') return route.fulfill({ json: { state, actor: view === 'teacher' ? { id: 'teacher-0', role: 'teacher', name: 'Docente 0' } : { id: 'director', role: 'coordinator', name: 'Subdirector' }, serverNow: new Date().toISOString(), dataset: 'demo' } });
  if (action === 'presentation_ranking_generate') {
    assert.equal(state.presentationDraw.completedPublisherIds.length, 3);
    const categories = presentationSummary(state);
    state.presentationRanking = { id: 'ranking-ui', version: 1, drawId: state.presentationDraw.id, categories, createdAt: new Date().toISOString(), provisional: categories.some(category => category.pending > 0) };
    return route.fulfill({ json: state.presentationRanking });
  }
  throw new Error(`Unexpected fixture action: ${action}`);
});
const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
const check = async (name, action) => { await action(); checks.push(name); console.log(`✓ ${name}`); };
mkdirSync('test-results', { recursive: true });
try {
  await check('teacher sees frozen publisher positions and can open the current editorial without losing the selected form', async () => {
    await page.goto(`${base}/?jornadaView=teacher`); await page.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
    assert.deepEqual(await page.locator('[aria-label="Editoriales"] button strong').allTextContents(), ['1. Editorial c', '2. Editorial a', '3. Editorial b']);
    assert.equal(await page.locator('[aria-label="Editoriales"] button[aria-pressed=true] strong').innerText(), '2. Editorial a');
    await page.locator('[aria-label="Editoriales"] button').filter({ hasText: '1. Editorial c' }).click();
    state.turn.publisherId = 'b'; await page.getByRole('button', { name: 'Actualizar datos de ensayo', exact: true }).click();
    await page.getByText('En exposición: 3. Editorial b', { exact: true }).waitFor();
    assert.equal(await page.locator('[aria-label="Editoriales"] button[aria-pressed=true] strong').innerText(), '1. Editorial c');
    await page.getByRole('button', { name: 'Ir a la editorial en exposición', exact: true }).click();
    await page.getByRole('button', { name: 'Evaluar con nueva escala', exact: true }).waitFor();
  });
  await check('all nine teachers and every zero-valued answer appear in progress; filters keep closure separate from response percentage', async () => {
    await page.goto(`${base}/?jornadaView=progress`); await page.getByRole('heading', { name: 'Docentes y avance', exact: true }).waitFor();
    assert.equal(await page.locator('.progress-table tbody tr').count(), 9);
    const first = page.locator('.progress-table tbody tr').filter({ hasText: 'Docente 0' });
    assert((await first.innerText()).includes('40 %')); assert((await first.innerText()).includes('1 / 3')); assert((await first.innerText()).includes('1 con escala anterior'));
    await page.getByLabel('Estado', { exact: true }).selectOption('not_started'); assert.equal(await page.locator('.progress-table tbody tr').count(), 8);
    await page.getByLabel('Área', { exact: true }).selectOption('COM'); await page.getByText('No hay docentes con estos filtros.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
    await page.getByLabel('Buscar docente', { exact: true }).fill('Docente 0'); assert.equal(await page.locator('.progress-table tbody tr').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'test-results/seguimiento-docentes-movil.png', fullPage: true });
  });
  await check('ranking is generated only after all draw turns finish, identifies provisional results and keeps zero as a score', async () => {
    await page.setViewportSize({ width: 1360, height: 980 }); await page.goto(`${base}/?jornadaView=ranking`);
    await page.getByRole('heading', { name: 'Ranking y Top de editoriales', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Generar ranking / Top', exact: true }).isDisabled());
    state.presentationDraw.completedPublisherIds = ['c', 'a', 'b']; state.turn.status = 'finished';
    await page.getByRole('button', { name: 'Actualizar datos de ensayo', exact: true }).click();
    await page.getByRole('button', { name: 'Generar ranking / Top', exact: true }).click();
    await page.getByText('Ranking provisional: hay fichas pendientes.', { exact: true }).waitFor();
    const row = page.locator('.ranking-table tbody tr').filter({ hasText: 'Editorial c' }); assert((await row.innerText()).includes('0,00') || (await row.innerText()).includes('0.00'));
    await page.getByLabel('Mostrar', { exact: true }).selectOption('3'); assert.equal(await page.locator('.ranking-table tbody tr').count(), 1);
    await page.getByLabel('Área', { exact: true }).selectOption('COM'); await page.getByText('No hay valoraciones de docentes registrados en esta categoría.', { exact: true }).waitFor();
    await page.getByLabel('Área', { exact: true }).selectOption('MAT'); await page.screenshot({ path: 'test-results/ranking-top-editoriales.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/jornada-views.json', JSON.stringify({ fixture: 'isolated in-memory browser UI requests', passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); await vite.close(); }
