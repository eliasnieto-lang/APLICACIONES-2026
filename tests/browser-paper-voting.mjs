// UI-only regression: in-memory API and scanner fixture; no installed dataset is touched.
// Run: node --import tsx tests/browser-paper-voting.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
import { emptyState } from '../shared/defaults.ts';

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], pageErrors = [], contexts = [];
const pdf = await PDFDocument.create(); pdf.addPage([419.527, 595.276]); const pdfBytes = [...await pdf.save()];
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2F3iUAAAAASUVORK5CYII=', 'base64');
const at = '2026-11-04T17:00:00.000Z';
const codes = { clear: 'a'.repeat(64), another: 'b'.repeat(64), review: 'c'.repeat(64), manual: 'd'.repeat(64) };
async function check(name, run) { await run(); checks.push(name); console.log(`✓ ${name}`); }
function makeState(provisional = false) {
  const state = emptyState();
  state.publishers = ['Alfa', 'Beta', 'Gamma'].map((name, index) => ({ id: `p${index + 1}`, name: `Editorial ${name}`, version: 1, samplesReceived: true, sampleNote: '' }));
  state.presentationRanking = { id: 'rank-paper', version: 1, drawId: 'draw-paper', createdAt: at, provisional, categories: ['MAT', 'COM'].map(area => ({ area, block: 'P1', categoryId: `${area}-P1`, state: 'ready', registered: 5, closed: 15, pending: 0, ranked: state.publishers.map((publisher, index) => ({ publisherId: publisher.id, area, block: 'P1', registered: 5, closed: 5, pending: 0, drafts: 0, score: 90 - index * 5, i2: 4, state: 'eligible' })), finalists: ['p1', 'p2', 'p3'], tied: [], reasons: [] })) };
  state.paperPolls = [];
  return state;
}
async function fixture(provisional = false) {
  const state = makeState(provisional), calls = [], consumed = new Set();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  const snapshot = () => ({ state, actor: { id: 'paper-director', name: 'Subdirector', role: 'coordinator' }, dataset: 'demo', serverNow: at });
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/paper-voting-fixture.tsx';" }));
  await context.route('**/src/paper-scan.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `
    export async function scanPaperBallot(file,poll,dataset) {
      await new Promise(resolve=>setTimeout(resolve,70));
      const code=file.name.startsWith('another')?'${codes.another}':file.name.startsWith('unclear')?'${codes.review}':file.name.startsWith('manual')?'${codes.manual}':'${codes.clear}';
      const unclear=file.name.startsWith('unclear');
      return {code,pollId:poll.id,choices:unclear?{}:{MAT:'p1',COM:'p2'},needsReview:unclear,reasons:unclear?['Marca poco clara en Comunicación']:[]};
    }` }));
  await context.route('**/src/paper-reports.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `export async function buildPaperVotingPdf(){return new Uint8Array(${JSON.stringify(pdfBytes)});}` }));
  await context.route('**/api/paper-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: snapshot() });
    if (action === 'paper_poll_create') {
      assert.deepEqual(payload.areas, ['MAT', 'COM']); assert.equal(payload.rankingId, state.presentationRanking.id); assert.equal(payload.expectedRankingVersion, 1);
      const options = Object.fromEntries(payload.areas.map(area => [area, state.publishers.map(({ id, name }) => ({ id, name }))]));
      const counts = Object.fromEntries(payload.areas.map(area => [area, { options: { p1: 0, p2: 0, p3: 0 }, blank: 0, invalid: 0 }]));
      const poll = { id: 'poll-paper', version: 1, block: payload.block, areas: payload.areas, options, status: 'open', rankingId: payload.rankingId, rankingVersion: 1, createdAt: at, closedAt: null, generated: 0, received: 0, counts, results: {} };
      state.paperPolls.push(poll); return route.fulfill({ json: poll });
    }
    const poll = state.paperPolls.find(item => item.id === payload.pollId); assert(poll);
    if (action === 'paper_ballots_generate') {
      assert.equal(payload.expectedVersion, poll.version); poll.version++; poll.generated += payload.count;
      return route.fulfill({ json: { poll, codes: Object.values(codes).slice(0, payload.count) } });
    }
    if (action === 'paper_scan_cast') {
      if (consumed.has(payload.code)) return route.fulfill({ status: 409, json: { code: 'PT409', message: 'Esta ficha ya fue contabilizada; no se suma de nuevo.' } });
      assert(Object.values(codes).includes(payload.code)); assert.deepEqual(Object.keys(payload.choices).sort(), ['COM', 'MAT']); consumed.add(payload.code);
      for (const area of poll.areas) { const option = payload.choices[area]; if (option === null) poll.counts[area].blank++; else if (option === '__invalid__') poll.counts[area].invalid++; else poll.counts[area].options[option]++; }
      poll.version++; poll.received++; return route.fulfill({ json: { poll, accepted: true } });
    }
    if (action === 'paper_poll_close') {
      assert.equal(payload.expectedVersion, poll.version); poll.status = 'closed'; poll.version++; poll.closedAt = at;
      poll.results = { MAT: { state: 'winner', winnerId: 'p1', tiedIds: [] }, COM: { state: 'tie', winnerId: null, tiedIds: ['p1', 'p2'] } };
      return route.fulfill({ json: poll });
    }
    throw Error(`Unexpected action ${action}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Votación en papel', exact: true }).waitFor();
  return { page, context, state, calls };
}
async function upload(page, name, buffer = photo, mimeType = 'image/png') { await page.getByRole('button', { name: 'Cargar fotos de las fichas', exact: true }).click({ trial: true }); await page.getByLabel('Archivos de fotos para leer', { exact: true }).setInputFiles({ name, mimeType, buffer }); }

try {
  await check('provisional rankings cannot create paper voting; both areas share one A5', async () => {
    const f = await fixture(true);
    assert(await f.page.getByRole('button', { name: 'Crear votación en papel', exact: true }).isDisabled());
    assert((await f.page.locator('body').innerText()).includes('Ambas áreas en una misma ficha A5'));
    await f.context.close();
  });
  const f = await fixture(); const p = f.page;
  await check('create from final category ranking requires physical-review confirmation and sends both areas', async () => {
    assert(await p.getByRole('button', { name: 'Crear votación en papel', exact: true }).isDisabled());
    await p.getByLabel(/Confirmo que las familias pudieron revisar/).check();
    await p.getByRole('button', { name: 'Crear votación en papel', exact: true }).click();
    await p.getByText('Recepción abierta', { exact: true }).waitFor(); assert.equal(f.state.paperPolls.length, 1);
    assert.deepEqual(f.state.paperPolls[0].areas, ['MAT', 'COM']);
  });
  await check('generate unique-code batch and offer A5 print preview plus PDF download', async () => {
    await p.getByLabel('Cantidad de fichas A5', { exact: true }).fill('4'); await p.getByLabel('Cantidad de fichas A5', { exact: true }).press('Tab'); assert.equal(await p.getByLabel('Cantidad de fichas A5', { exact: true }).inputValue(), '4'); await p.getByRole('button', { name: 'Generar fichas A5', exact: true }).click();
    await p.getByRole('button', { name: 'Imprimir fichas A5', exact: true }).waitFor();
    assert.equal(f.state.paperPolls[0].generated, 4); assert.equal(await p.locator('iframe[title="Vista previa de las fichas A5"]').count(), 1);
    const downloaded = p.waitForEvent('download'); await p.getByRole('button', { name: 'Descargar PDF A5', exact: true }).click(); assert.equal((await downloaded).suggestedFilename(), 'fichas-A5-P1.pdf');
  });
  await check('clear photos process immediately and duplicate QR never adds another vote', async () => {
    await upload(p, 'clear-one.png'); await p.getByText('Contada', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].received, 1);
    await upload(p, 'another-one.png'); await p.getByText('Contada', { exact: true }).nth(1).waitFor(); assert.equal(f.state.paperPolls[0].received, 2);
    await upload(p, 'clear-copy.png'); await p.getByText('Ya había sido contada', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].received, 2);
    assert.equal(f.state.paperPolls[0].counts.MAT.options.p1, 2); assert.equal(f.state.paperPolls[0].counts.COM.options.p2, 2);
  });
  await check('uncertain marks wait for manual review of each area and explicit confirmation', async () => {
    await upload(p, 'unclear-one.png'); const row = p.locator('.paper-reading').filter({ hasText: 'unclear-one.png' }); await row.getByText('Revisión necesaria', { exact: true }).waitFor();
    assert.equal(f.state.paperPolls[0].received, 2); assert(await p.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).isDisabled());
    await row.getByLabel('Matemática · lectura', { exact: true }).selectOption('p3'); await row.getByLabel('Comunicación · lectura', { exact: true }).selectOption('__blank__');
    assert(await row.getByRole('button', { name: 'Confirmar y contar esta ficha', exact: true }).isDisabled());
    await row.getByLabel('Comparé esta lectura con la ficha original.', { exact: true }).check(); await row.getByRole('button', { name: 'Confirmar y contar esta ficha', exact: true }).click();
    await row.getByText('Contada', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].received, 3); assert.equal(f.state.paperPolls[0].counts.COM.blank, 1);
  });
  await check('wrong files are rejected locally and disabling automatic counting leaves clear scans pending', async () => {
    const previous = f.calls.filter(call => call.action === 'paper_scan_cast').length;
    await upload(p, 'not-a-photo.pdf', Buffer.from('%PDF-file'), 'application/pdf'); await p.getByText('No se puede leer', { exact: true }).waitFor(); assert.equal(f.calls.filter(call => call.action === 'paper_scan_cast').length, previous);
    await p.getByLabel('Registrar automáticamente las lecturas claras', { exact: true }).uncheck(); await upload(p, 'manual-one.png');
    const row = p.locator('.paper-reading').filter({ hasText: 'manual-one.png' }); await row.getByText('Revisión necesaria', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].received, 3);
    await row.getByLabel('Comparé esta lectura con la ficha original.', { exact: true }).check(); await row.getByRole('button', { name: 'Confirmar y contar esta ficha', exact: true }).click(); await row.getByText('Contada', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].received, 4);
  });
  await check('mobile view fits and closing produces visible independent area results including a tie', async () => {
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await p.locator('[aria-label="Resultados de la votación"] .table-wrap').evaluateAll(items => items.every(item => item.scrollWidth <= item.clientWidth)));
    mkdirSync('test-results', { recursive: true }); await p.screenshot({ path: 'test-results/paper-voting-mobile.png', fullPage: true });
    await p.getByLabel('Confirmo que terminó la recepción y revisé el escrutinio.', { exact: true }).check(); await p.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).click();
    await p.getByText('Recepción cerrada', { exact: true }).waitFor(); assert.equal(f.state.paperPolls[0].status, 'closed');
    await p.getByText('Mayoría: Editorial Alfa', { exact: true }).waitFor(); await p.getByText('Empate: Editorial Alfa / Editorial Beta', { exact: true }).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Cargar fotos de las fichas', exact: true }).count(), 0);
  });
  assert.deepEqual(pageErrors, []);
  writeFileSync('test-results/paper-voting-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'isolated UI API and scanner fixture; real PDF/scanner tested separately', passed: checks.length, checks, pageErrors }, null, 2));
} catch(error) {
  console.error(error); console.error('Page errors:', pageErrors);
  mkdirSync('test-results', { recursive: true });
  for (const context of contexts) for (const page of context.pages()) {
    try { console.error((await page.locator('body').innerText()).slice(0, 2200)); await page.screenshot({ path: 'test-results/paper-voting-failure.png', fullPage: true }); } catch {}
  }
  process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
