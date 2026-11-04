// All API requests are intercepted locally. This test never deletes an installed dataset.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { emptyState } from '../shared/defaults.ts';

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [], contexts = [];
const at = '2026-11-04T18:00:00.000Z';
async function check(name, run) { await run(); checks.push(name); console.log('✓ ' + name); }
function seeded() {
  const state = emptyState(); state.version = 12;
  state.publishers = [{ id: 'pub-a', name: 'Editorial Alfa', version: 1, samplesReceived: true, sampleNote: '' }, { id: 'pub-b', name: 'Editorial Beta', version: 1, samplesReceived: true, sampleNote: '' }];
  state.teachers = [{ id: 'teacher-a', version: 1, name: 'Alvarado Ana', area: 'MAT', categories: ['P1'], attended: true, attendanceEvidence: '' }, { id: 'teacher-b', version: 1, name: 'Benítez Bruno', area: 'COM', categories: ['P2'], attended: true, attendanceEvidence: '' }];
  state.presentationEvaluations = [{ id: 'eval-a', version: 1, publisherId: 'pub-a', teacherId: 'teacher-a', area: 'MAT', block: 'P1', scores: Array(10).fill(4), notes: Array(10).fill(''), scaleMax: 4, generalObservation: '', physicalText: '', status: 'closed', closedAt: at, updatedAt: at, rulesVersion: 1 }, { id: 'eval-b', version: 1, publisherId: 'pub-b', teacherId: 'teacher-b', area: 'COM', block: 'P2', scores: Array(10).fill(null), notes: Array(10).fill(''), scaleMax: 4, generalObservation: '', physicalText: '', status: 'draft', closedAt: null, updatedAt: at, rulesVersion: 1 }];
  state.presentationQuestions = [{ id: 'question-a', version: 1, publisherId: 'pub-a', representativeName: 'Portavoz', area: 'MAT', question: '¿Cómo retroalimenta el material?', answer: 'Respuesta registrada', status: 'answered', askedAt: at, answeredAt: at, updatedAt: at }];
  state.series = [{ id: 'series-a', version: 1, publisherId: 'pub-a', name: 'Serie Primera' }];
  state.offers = [{ id: 'offer-a', version: 1, seriesId: 'series-a', area: 'MAT', block: 'P1', edition: '2027', status: 'offered', withdrawalReason: '' }];
  state.books = [{ id: 'book-a', version: 1, code: 'MAT-01', title: 'Matemática para aprender', edition: '2027' }];
  state.sections = [{ id: 'section-a', version: 1, label: 'A', sourceGrade: 'PRI1' }];
  state.incidents = [{ id: 'incident-a', version: 1, scope: 'Jornada', description: 'Incidencia de ensayo' }];
  state.paperPolls = [{ id: 'poll-a', version: 1, block: 'P1', areas: ['MAT', 'COM'], received: 2, status: 'closed' }];
  return state;
}
async function fixture({ role = 'coordinator', dataset = 'real', viewport = { width: 1200, height: 900 } } = {}) {
  let state = seeded(); const calls = []; let conflictNext = false;
  const actor = { id: 'director-fixture', name: 'Subdirector', role };
  const context = await browser.newContext({ viewport }); contexts.push(context);
  const snapshot = () => ({ state, actor, dataset, serverNow: at });
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/cleanup-fixture.tsx';" }));
  await context.route('**/api/cleanup-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: snapshot() });
    if (role !== 'coordinator') return route.fulfill({ status: 403, json: { message: 'Solo Subdirección' } });
    if (action === 'backup_get') return route.fulfill({ json: { format: 'fixture-backup', state } });
    if (action === 'data_delete_preview') {
      const labels = payload.scope === 'publisher' ? state.publishers.filter(item => payload.ids.includes(item.id)).map(item => item.name) : payload.scope === 'teacher' ? state.teachers.filter(item => payload.ids.includes(item.id)).map(item => item.name) : payload.scope === 'all' ? ['Toda la información ingresada'] : ['Registros seleccionados'];
      const counts = payload.scope === 'publisher' ? { publishers: payload.ids.length, presentationEvaluations: 1, paperPolls: 1, presentationDraw: 1, presentationRanking: 1 } : payload.scope === 'teacher' ? { teachers: payload.ids.length, presentationEvaluations: 1, teacherAccesses: payload.ids.length } : { publishers: 2, teachers: 2, presentationEvaluations: 2, paperPolls: 1, paperTokens: 2 };
      return route.fulfill({ json: { stateVersion: state.version, scope: payload.scope, ids: payload.ids ?? [], labels, counts, consequences: payload.scope === 'publisher' ? ['Se eliminará la votación asociada y será necesario organizar un nuevo sorteo.'] : ['Se conservan el acceso de Subdirección y la configuración.'], requiresFullConfirmation: payload.scope === 'all' } });
    }
    assert.equal(action, 'data_delete_apply');
    if (conflictNext || payload.expectedVersion !== state.version) { conflictNext = false; state.version++; return route.fulfill({ status: 409, json: { code: 'PT409', message: 'La información cambió en otra sesión. Revise nuevamente antes de eliminar.' } }); }
    assert.equal(payload.confirmation, payload.scope === 'all' ? 'ELIMINAR TODO' : 'ELIMINAR');
    if (payload.scope === 'all') { const settings = state.settings; state = { ...emptyState(), version: state.version + 1, settings }; }
    else if (payload.scope === 'teacher') { state.teachers = state.teachers.filter(item => !payload.ids.includes(item.id)); state.presentationEvaluations = state.presentationEvaluations.filter(item => !payload.ids.includes(item.teacherId)); state.version++; }
    else if (payload.scope === 'publisher') { state.publishers = state.publishers.filter(item => !payload.ids.includes(item.id)); state.presentationEvaluations = state.presentationEvaluations.filter(item => !payload.ids.includes(item.publisherId)); state.paperPolls = []; state.version++; }
    return route.fulfill({ json: { deleted: true } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?dataset=' + dataset); await page.getByRole('heading', { name: 'Eliminar información', exact: true }).waitFor();
  return { page, context, calls, state: () => state, actor, changeVersion() { state.version++; }, conflict() { conflictNext = true; } };
}
const scope = (page, value) => page.getByLabel('Información que deseas eliminar', { exact: true }).selectOption(value);
const review = page => page.getByRole('button', { name: 'Revisar qué se eliminará', exact: true }).click();
const confirm = page => page.getByLabel('Confirmo que deseo eliminar la información indicada.', { exact: true }).check();
try {
  await check('real coordinator can open cleanup without any preview or delete mutation', async () => {
    const f = await fixture(); assert((await f.page.locator('body').innerText()).includes('Información de Jornada real'));
    assert.deepEqual(f.calls.map(item => item.action), ['snapshot']); assert(await f.page.getByRole('button', { name: 'Revisar qué se eliminará', exact: true }).isDisabled());
    assert.equal(await f.page.locator('input[type=password]').count(), 0); await f.context.close();
  });
  await check('publisher selection previews exact cascading consequences and can cancel without deleting', async () => {
    const f = await fixture(); const p = f.page;
    await p.getByLabel('Seleccionar Editorial Alfa', { exact: true }).check(); await review(p);
    const preview = p.getByRole('region', { name: 'Resumen de eliminación', exact: true }); await preview.waitFor();
    assert((await preview.innerText()).includes('Se eliminará la votación asociada')); assert((await preview.innerText()).includes('Fichas de exposición'));
    assert(await p.getByRole('button', { name: 'Eliminar información seleccionada', exact: true }).isDisabled());
    await p.getByRole('button', { name: 'Cancelar eliminación', exact: true }).click(); assert.equal(f.calls.filter(item => item.action === 'data_delete_apply').length, 0); assert.equal(f.state().publishers.length, 2); await f.context.close();
  });
  await check('full cleanup requires the exact typed phrase and confirmation while backup remains optional', async () => {
    const f = await fixture(); const p = f.page; await scope(p, 'all'); await review(p);
    const erase = p.getByRole('button', { name: 'Eliminar toda la información', exact: true }); assert(await erase.isDisabled());
    await confirm(p); assert(await erase.isDisabled()); await p.getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR'); assert(await erase.isDisabled());
    await p.getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR TODO'); assert(await erase.isEnabled());
    assert.equal(f.calls.filter(item => item.action === 'backup_get').length, 0);
    const download = p.waitForEvent('download'); await p.getByRole('button', { name: 'Descargar respaldo antes de eliminar', exact: true }).click(); assert((await download).suggestedFilename().includes('real'));
    assert(await erase.isEnabled()); assert.equal(f.calls.filter(item => item.action === 'data_delete_apply').length, 0); await f.context.close();
  });
  await check('a refreshed state version invalidates an old preview and prevents applying it', async () => {
    const f = await fixture(); const p = f.page; await scope(p, 'all'); await review(p); await p.getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR TODO'); await confirm(p);
    f.changeVersion(); await p.getByRole('button', { name: 'Actualizar datos de ensayo', exact: true }).click(); await p.getByText('La información cambió desde esta revisión.', { exact: false }).waitFor();
    assert(await p.getByRole('button', { name: 'Eliminar toda la información', exact: true }).isDisabled()); assert.equal(f.calls.filter(item => item.action === 'data_delete_apply').length, 0); await f.context.close();
  });
  await check('server conflict preserves the teacher and a new reviewed deletion keeps the director signed in', async () => {
    const f = await fixture(); const p = f.page; await scope(p, 'teacher'); await p.getByLabel('Seleccionar Alvarado Ana · Matemática', { exact: true }).check(); await review(p); await confirm(p); f.conflict();
    await p.getByRole('button', { name: 'Eliminar información seleccionada', exact: true }).click(); await p.getByRole('alert').filter({ hasText: 'La información cambió en otra sesión.' }).waitFor(); assert.equal(f.state().teachers.length, 2);
    await p.getByRole('button', { name: 'Actualizar datos de ensayo', exact: true }).click(); await review(p); await confirm(p); await p.getByRole('button', { name: 'Eliminar información seleccionada', exact: true }).click();
    await p.getByRole('status').filter({ hasText: 'Información eliminada.' }).waitFor(); assert.deepEqual(f.state().teachers.map(item => item.id), ['teacher-b']); assert.equal(f.actor.role, 'coordinator'); assert.equal(await p.getByLabel('Información que deseas eliminar', { exact: true }).count(), 1); await f.context.close();
  });
  await check('catalog, historical and editorial-question scopes expose their own records and filtered select-all', async () => {
    const f = await fixture(); const p = f.page;
    for (const value of ['series', 'offer', 'book', 'section', 'incident', 'question']) { await scope(p, value); assert.equal(await p.getByRole('group', { name: 'Registros para eliminar' }).locator('input[type=checkbox]').count(), 1); }
    await scope(p, 'presentationEvaluation'); await p.getByLabel('Buscar registros', { exact: true }).fill('Alvarado'); await p.getByRole('button', { name: 'Seleccionar todos los resultados', exact: true }).click(); await review(p);
    assert.deepEqual(f.calls.filter(item => item.action === 'data_delete_preview').at(-1).payload.ids, ['eval-a']); await f.context.close();
  });
  await check('confirmed full cleanup empties current information and retains school settings and coordinator access', async () => {
    const f = await fixture(); const p = f.page; const school = f.state().settings.school; await scope(p, 'all'); await review(p); await p.getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR TODO'); await confirm(p);
    await p.getByRole('button', { name: 'Eliminar toda la información', exact: true }).click(); await p.getByRole('status').filter({ hasText: 'Información eliminada.' }).waitFor();
    assert.equal(f.state().teachers.length, 0); assert.equal(f.state().publishers.length, 0); assert.equal(f.state().settings.school, school); assert.equal(f.actor.role, 'coordinator'); assert((await p.locator('body').innerText()).includes('Información de Jornada real')); await f.context.close();
  });
  await check('teacher and secretary cannot access deletion controls; coordinator cleanup fits a 390px phone', async () => {
    for (const role of ['teacher', 'secretary']) { const f = await fixture({ role }); assert.equal(await f.page.getByLabel('Información que deseas eliminar', { exact: true }).count(), 0); assert.equal(f.calls.filter(item => item.action !== 'snapshot').length, 0); assert(!(await f.page.locator('body').innerText()).includes('Editorial Alfa')); await f.context.close(); }
    const f = await fixture({ viewport: { width: 390, height: 844 }, dataset: 'real' }); const p = f.page; await scope(p, 'all'); await review(p); assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    mkdirSync('test-results', { recursive: true }); await p.screenshot({ path: 'test-results/cleanup-real-mobile.png', fullPage: true }); await f.context.close();
  });
  assert.deepEqual(errors, []); mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/cleanup-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'isolated UI fixture; all API requests intercepted', passed: checks.length, checks, pageErrors: errors }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; for (const context of contexts) for (const page of context.pages()) { try { console.error((await page.locator('body').innerText()).slice(0, 2200)); } catch {} } }
finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
