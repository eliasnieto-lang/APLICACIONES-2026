// Isolated browser UI; no database, official data or external image service.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { paperClassroomRoster } from '../shared/paper-vote.ts';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }); await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const options = [{ id: 'one', name: 'Editorial Uno' }, { id: 'two', name: 'Editorial Dos' }, { id: 'three', name: 'Editorial Tres' }];
const poll = { id: 'photo-test-poll', version: 7, block: 'P1', areas: ['MAT', 'COM'], options: { MAT: options, COM: options }, status: 'closed', rankingId: 'rank', rankingVersion: 1, createdAt: new Date().toISOString(), closedAt: new Date().toISOString(), generated: 0, received: 0, counts: { MAT: { options: { one: 0, two: 0, three: 0 }, blank: 0, invalid: 0 }, COM: { options: { one: 0, two: 0, three: 0 }, blank: 0, invalid: 0 } }, results: {}, rosterVersion: 1, classrooms: paperClassroomRoster('P1') };
let photos = [], failNext = false; const calls = [], errors = [], checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/paper-evidence-fixture.tsx';" }));
await context.route('**/api/paper-evidence-fixture', async route => {
  const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
  if (action === 'snapshot') return route.fulfill({ json: poll });
  assert.equal(payload.pollId, poll.id);
  if (action === 'paper_evidence_list') return route.fulfill({ json: photos.map(({ data, ...metadata }) => metadata) });
  if (action === 'paper_evidence_add') {
    if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { message: 'No se pudo guardar por falta de conexión.' } }); }
    assert.deepEqual(Object.keys(payload).sort(), ['classroomId', 'data', 'filename', 'mimeType', 'pollId']); assert.equal(payload.mimeType, 'image/jpeg'); assert.ok(Buffer.from(payload.data, 'base64').subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')));
    const existing = photos.find(item => item.data === payload.data && item.classroomId === payload.classroomId);
    if (existing) return route.fulfill({ json: { ...existing, duplicate: true, data: undefined } });
    const saved = { id: `photo-${photos.length + 1}`, ...payload, bytes: Buffer.from(payload.data, 'base64').length, createdAt: new Date().toISOString() }; photos.push(saved);
    return route.fulfill({ json: { ...saved, data: undefined } });
  }
  const photo = photos.find(item => item.id === payload.evidenceId); assert.ok(photo);
  if (action === 'paper_evidence_get') return route.fulfill({ json: photo });
  assert.equal(action, 'paper_evidence_delete'); photos = photos.filter(item => item.id !== payload.evidenceId); return route.fulfill({ json: { deleted: true } });
});
const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base); await page.getByRole('heading', { name: 'Respaldo opcional de la votación' }).waitFor();
  const summary = page.getByText('Fotos de respaldo (opcional)', { exact: true });
  await check('photos stay optional and collapsed without requesting a code or recognizing a vote', async () => {
    assert.equal(calls.filter(item => item.action !== 'snapshot').length, 0); await summary.click();
    await page.getByText(/No hay fotos cargadas/).waitFor(); assert.equal(await page.locator('input[type="text"]').count(), 0);
    assert(await page.getByText(/incluso cuando la votación ya esté cerrada/).isVisible()); assert(await page.getByText(/No se leen automáticamente ni cambian los votos registrados/).isVisible());
  });
  const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 260; canvas.height = 360; const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 260, 360); c.fillStyle = '#000'; c.font = '20px sans-serif'; c.fillText('Ficha P1-01', 20, 40); c.fillText('Aula 1 A', 20, 70); return canvas.toDataURL('image/png').split(',')[1]; });
  await check('a photo may be saved after closing and is listed under its classroom without changing totals', async () => {
    await page.getByLabel('Aula de la ficha', { exact: true }).selectOption('PRI1-A');
    await page.getByLabel('Foto de respaldo', { exact: true }).setInputFiles({ name: 'ficha.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.getByRole('button', { name: 'Guardar foto de respaldo', exact: true }).click();
    await page.getByText('Foto de respaldo guardada. Los votos no se modificaron.', { exact: true }).waitFor();
    assert.equal(photos.length, 1); assert.equal(poll.version, 7); assert.equal(poll.received, 0); assert(await page.locator('strong').filter({ hasText: 'P1-01 · 1.º de primaria · A' }).isVisible());
  });
  await check('stored photos can be viewed and downloaded separately from the JSON backup', async () => {
    await page.getByRole('button', { name: 'Ver foto', exact: true }).click(); const photo = page.locator('img[alt^="Respaldo de"]'); await photo.waitFor();
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0);
    const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar foto', exact: true }).click(); const download = await waiting; assert.equal(download.suggestedFilename(), 'ficha.jpg');
    assert(await page.getByText(/respaldo JSON de la jornada no incluye las imágenes/).isVisible());
  });
  await check('a failed upload remains unsaved and can retry without altering the count', async () => {
    failNext = true; await page.getByLabel('Foto de respaldo', { exact: true }).setInputFiles({ name: 'otra.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await page.getByRole('button', { name: 'Guardar foto de respaldo', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'No se pudo guardar por falta de conexión.' }).waitFor();
    assert.equal(photos.length, 1); assert(await page.getByRole('button', { name: 'Guardar foto de respaldo', exact: true }).isEnabled());
    await page.getByRole('button', { name: 'Guardar foto de respaldo', exact: true }).click(); await page.getByText('Esta foto ya estaba guardada.', { exact: true }).waitFor(); assert.equal(photos.length, 1);
  });
  await check('an invalid image is rejected locally and a saved photo can be removed without changing votes', async () => {
    const previous = calls.filter(item => item.action === 'paper_evidence_add').length;
    await page.getByLabel('Foto de respaldo', { exact: true }).setInputFiles({ name: 'not-a-photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await page.getByRole('button', { name: 'Guardar foto de respaldo', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Elija una foto JPG, PNG o WebP' }).waitFor(); assert.equal(calls.filter(item => item.action === 'paper_evidence_add').length, previous);
    await page.getByRole('button', { name: 'Eliminar foto', exact: true }).click(); await page.getByText('Foto eliminada; el voto se conserva.', { exact: true }).waitFor(); assert.equal(photos.length, 0); assert.equal(poll.received, 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); assert.deepEqual(errors, []);
  });
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/paper-evidence-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated API; real browser photo decode, resize, preview and download', passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); await vite.close(); }
