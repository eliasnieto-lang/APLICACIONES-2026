// UI-only fixture: all requests are intercepted; this never mutates a running installation.
// Run against local Vite: TEXTOS_BROWSER_URL=http://127.0.0.1:5173 node --import tsx tests/browser-consolidation-filters.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { emptyState } from '../shared/defaults.ts';

const base = process.env.TEXTOS_BROWSER_URL || 'http://127.0.0.1:5173';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw Error('Use a local Vite installation.');
const state = emptyState();
const names = ['Editorial Media', 'Editorial Alfa', 'Editorial Beta', 'Editorial Gamma', 'Editorial Histórica'];
state.publishers = names.map((name, index) => ({ id: `p${index}`, version: 1, name, samplesReceived: true, sampleNote: '' }));
state.teachers = Array.from({ length: 5 }, (_, index) => ({ id: `t${index}`, version: 1, name: `Docente ${index + 1}`, area: 'MAT', categories: ['P1', 'P2'], attended: true, attendanceEvidence: '' }));
state.teachers.push({ id: 'com', version: 1, name: 'Docente Comunicación', area: 'COM', categories: ['S1'], attended: true, attendanceEvidence: '' });
const at = '2026-11-04T15:00:00.000Z';
for (let publisher = 0; publisher < names.length; publisher++) {
  for (let teacher = 0; teacher < 5; teacher++) {
    const scores = publisher === 0 ? Array(10).fill(teacher)
      : publisher === 1 ? Array(10).fill(4)
        : publisher === 2 ? [...Array(8).fill(4), 3, 3]
          : publisher === 3 ? [...Array(6).fill(4), ...Array(4).fill(3)] : Array(10).fill(0);
    state.presentationEvaluations.push({ id: `e-${publisher}-${teacher}`, version: 1, publisherId: `p${publisher}`, teacherId: `t${teacher}`, area: 'MAT', block: 'P1', scaleMax: 4, scores, notes: Array(10).fill(''), generalObservation: teacher === 0 ? 'Observación privada de ficha' : '', physicalText: '', status: 'closed', closedAt: at, updatedAt: at, rulesVersion: 1 });
  }
}
// One old completed record must remain readable, and count as pending in the current mean.
delete state.presentationEvaluations.find(item => item.id === 'e-4-0').scaleMax;
state.presentationEvaluations.find(item => item.id === 'e-4-0').scores = Array(10).fill(2);
state.presentationShortlists.push({ id: 'archived', version: 1, categoryId: 'MAT-P1', area: 'MAT', block: 'P1', publisherIds: ['p1', 'p2', 'p3'], status: 'superseded', statement: 'Acuerdo anterior', folio: 'H-01', directorApproved: true, publishedAt: at, rulesVersion: 1, snapshot: { assessment: { categoryId: 'MAT-P1', area: 'MAT', block: 'P1', state: 'ready', registered: 5, closed: 25, pending: 0, ranked: [], finalists: ['p1', 'p2', 'p3'], tied: [], reasons: [] }, publishers: state.publishers, threshold: 70 } });
const snapshot = () => ({ state, actor: { id: 'director', name: 'Subdirector de prueba', role: 'coordinator' }, dataset: 'demo', serverNow: at });
const calls = [], checks = [], pageErrors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
page.setDefaultTimeout(10000);
await context.route('**/config.json', route => route.fulfill({ json: { mode: 'local', url: '', publishableKey: '' } }));
await context.route('**/api/rpc', async route => {
  const request = route.request().postDataJSON();
  calls.push(request);
  if (request.p_action === 'director_login') return route.fulfill({ json: { code: 'fixture-only', snapshot: snapshot() } });
  if (request.p_action === 'snapshot') return route.fulfill({ json: snapshot() });
  if (request.p_action === 'presentation_reopen') {
    const evaluation = state.presentationEvaluations.find(item => item.id === request.p_payload.evaluationId);
    evaluation.status = 'draft'; evaluation.closedAt = null; evaluation.version++;
    state.audit.push({ id: 'reopen-audit', actor: 'Subdirector', action: 'presentation_reopen', referenceId: evaluation.id, reason: request.p_payload.reason, at, summary: 'Ficha reabierta' });
    return route.fulfill({ json: evaluation });
  }
  return route.fulfill({ status: 400, json: { code: 'PT400', message: `Unexpected fixture action ${request.p_action}` } });
});
const check = async (label, action) => { await action(); checks.push(label); console.log(`✓ ${label}`); };
const table = () => page.getByRole('tabpanel').locator('table');
const row = publisher => table().locator('tbody tr').filter({ has: page.getByText(publisher, { exact: true }) });
const close = () => page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
try {
  await page.goto(`${base}/?datos=demo`);
  await page.getByRole('button', { name: 'INGRESAR COMO SUBDIRECTOR', exact: true }).click();
  await page.getByLabel('Contraseña del subdirector').fill('fixture');
  await page.getByRole('button', { name: 'Ingresar a la jornada', exact: true }).click();
  await page.getByRole('button', { name: 'Consolidación y ternas', exact: true }).click();
  await page.getByRole('heading', { name: 'Consolidación y ternas', exact: true }).waitFor();

  await check('compact initial results and five-teacher 0–4 official mean', async () => {
    assert.equal(await page.locator('select').count(), 5);
    assert.equal(await table().locator('tbody tr').count(), 5);
    assert.match(await row('Editorial Media').innerText(), /50[.,]00/);
    assert.equal(await page.getByRole('heading', { name: 'Promedios por criterio' }).count(), 0);
    assert.equal(await page.getByText('Observación privada de ficha', { exact: true }).count(), 0);
    assert.deepEqual(await table().locator('tbody tr td:first-child strong').allTextContents(), ['Editorial Alfa', 'Editorial Beta', 'Editorial Gamma', 'Editorial Media', 'Editorial Histórica']);
  });
  await check('editorial filter never changes the official terna', async () => {
    await page.getByLabel('Editorial', { exact: true }).selectOption('p0');
    assert.equal(await table().locator('tbody tr').count(), 1);
    const proposal = await page.locator('.consolidation-proposal').innerText();
    for (const name of names.slice(1, 4)) assert(proposal.includes(name));
    assert.match(await row('Editorial Media').innerText(), /50[.,]00/);
  });
  await check('docente filter opens individual fichas and never narrows official averages', async () => {
    await page.getByLabel('Docente · fichas', { exact: true }).selectOption('t0');
    assert.equal(await page.getByRole('tab', { name: 'Fichas docentes', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await table().locator('tbody tr').count(), 1);
    assert.match(await table().locator('tbody tr').innerText(), /0[.,]00/);
    await page.getByRole('tab', { name: 'Resultados', exact: true }).click();
    assert.match(await row('Editorial Media').innerText(), /50[.,]00/);
    await page.getByRole('button', { name: 'Ver criterios de Editorial Media', exact: true }).click();
    const dialog = page.getByRole('dialog');
    assert.match(await dialog.innerText(), /Promedio oficial: 50[.,]00/);
    assert.match(await dialog.locator('tbody tr').first().innerText(), /2[.,]00/);
    await close();
  });
  await check('area and category dropdowns keep category rankings separate', async () => {
    await page.getByLabel('Categoría', { exact: true }).selectOption('P2');
    assert.match(await row('Editorial Media').innerText(), /Pendiente/);
    assert(!/50[.,]00/.test(await row('Editorial Media').innerText()));
    await page.getByLabel('Área', { exact: true }).selectOption('COM');
    await page.getByLabel('Categoría', { exact: true }).selectOption('S1');
    assert.match(await page.locator('.consolidation-category h2').innerText(), /Comunicación.*S1/);
    await page.getByLabel('Docente · fichas', { exact: true }).selectOption('com');
    assert.equal(await table().locator('tbody tr').count(), 5);
    await page.getByLabel('Área', { exact: true }).selectOption('MAT');
    await page.getByLabel('Categoría', { exact: true }).selectOption('P1');
    await page.getByRole('tab', { name: 'Resultados', exact: true }).click();
  });
  await check('closed, pending, historical filters and reset give clear empty results', async () => {
    await page.getByLabel('Estado', { exact: true }).selectOption('closed');
    assert.equal(await table().locator('tbody tr').count(), 5);
    await page.getByLabel('Estado', { exact: true }).selectOption('pending');
    assert.equal(await table().locator('tbody tr').count(), 1);
    assert.match(await table().locator('tbody tr').innerText(), /Editorial Histórica/);
    await page.getByLabel('Estado', { exact: true }).selectOption('historical');
    assert.equal(await table().locator('tbody tr').count(), 1);
    assert.match(await table().locator('tbody tr').innerText(), /Escala anterior 0–2/);
    await page.getByRole('button', { name: 'Ver ficha de Docente 1 · Editorial Histórica', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /Escala anterior 0–2/);
    assert.equal(await page.getByRole('button', { name: 'Reabrir ficha con motivo', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByLabel('Editorial', { exact: true }).selectOption('p0');
    await page.getByText('No hay resultados con estos filtros.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).first().click();
    assert.equal(await table().locator('tbody tr').count(), 25);
  });
  await check('publication requires all fichas, withdrawal, statement, folio and direction validation', async () => {
    await page.getByRole('button', { name: 'Revisar terna', exact: true }).click();
    assert.equal(await page.getByRole('dialog').locator('.consolidation-proposed-list li').count(), 3);
    await page.getByLabel('Apreciación general del portavoz docente', { exact: true }).fill('Acuerdo de prueba');
    await page.getByLabel('Folio del acuerdo', { exact: true }).fill('F-01');
    await page.getByLabel('Dirección validó la terna y su acuerdo.', { exact: true }).check();
    assert.equal(await page.getByRole('button', { name: 'Publicar terna validada', exact: true }).isDisabled(), true);
    await close();
    state.presentationEvaluations.find(item => item.id === 'e-4-0').scaleMax = 4;
    state.presentationEvaluations.find(item => item.id === 'e-4-0').scores = Array(10).fill(0);
    await page.getByRole('button', { name: 'Actualizar información', exact: true }).click();
    await page.getByRole('button', { name: 'Revisar terna', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Publicar terna validada', exact: true }).isDisabled(), true);
    await close();
    state.settings.editorsWithdrawn = true; state.settings.withdrawalReference = 'R-01';
    await page.getByRole('button', { name: 'Actualizar información', exact: true }).click();
    await page.getByRole('button', { name: 'Revisar terna', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Publicar terna validada', exact: true }).isEnabled(), true);
    await page.getByLabel('Folio del acuerdo', { exact: true }).fill(' ');
    assert.equal(await page.getByRole('button', { name: 'Publicar terna validada', exact: true }).isDisabled(), true);
    await close();
  });
  await check('individual modal closes and reopening requires a documented reason', async () => {
    await page.getByLabel('Editorial', { exact: true }).selectOption('p0');
    await page.getByLabel('Docente · fichas', { exact: true }).selectOption('t0');
    await page.getByRole('button', { name: 'Ver ficha de Docente 1 · Editorial Media', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /0 · Sin valoración/);
    await page.getByRole('button', { name: 'Reabrir ficha con motivo', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Confirmar reapertura documentada', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await page.getByLabel('Motivo obligatorio', { exact: true }).fill(' ');
    assert.equal(await confirm.isDisabled(), true);
    await page.getByLabel('Motivo obligatorio', { exact: true }).fill('Corregir una observación registrada');
    await confirm.click();
    await page.getByText('Ficha reabierta; historial conservado.', { exact: true }).waitFor();
    assert.equal(calls.filter(item => item.p_action === 'presentation_reopen').length, 1);
    assert.deepEqual(calls.find(item => item.p_action === 'presentation_reopen').p_payload, { evaluationId: 'e-0-0', reason: 'Corregir una observación registrada' });
    assert.match(await table().locator('tbody tr').innerText(), /Borrador/);
  });
  await check('history opens only on demand and screen fits a phone', async () => {
    await page.getByRole('button', { name: /Historial de ternas/ }).click();
    await page.getByRole('dialog').getByText('Versión 1 · Histórica · H-01', { exact: true }).waitFor();
    await close();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Resultados', exact: true }).click();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    mkdirSync('test-results', { recursive: true });
    assert(await page.locator('.consolidation-workspace .table-wrap').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth)));
    if (await page.getByRole('button', { name: 'Cerrar aviso', exact: true }).count()) await page.getByRole('button', { name: 'Cerrar aviso', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/consolidation-filters-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).first().click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'test-results/consolidation-filters-desktop.png', fullPage: true });
  });
  assert.deepEqual(pageErrors, []);
  writeFileSync('test-results/consolidation-filters.json', JSON.stringify({ fixture: 'intercepted local UI requests', checks, pageErrors }, null, 2));
} finally { await context.close(); await browser.close(); }
