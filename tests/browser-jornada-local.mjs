// Full local integration only. Every mutation is restricted to the disposable demo dataset.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation } from '../shared/presentation.ts';
import { PAPER_A5, paperChoiceBoxes } from '../shared/paper-layout.ts';

const base = process.env.TEXTOS_BROWSER_URL || 'http://127.0.0.1:39001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw Error('Use a disposable local development installation.');
const owner = readFileSync('local/demo-owner-code.txt', 'utf8').trim();
const password = readFileSync('local/director-test-password', 'utf8').trim();
const secrets = [owner, password];
const privateObservation = 'OBSERVACION_PRIVADA_DEL_ENSAYO_REAL';
const checks = [], pageErrors = [], cspErrors = [], contexts = [];
const checked = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
async function rpc(action, payload = {}, code = owner) {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  const value = await response.json();
  if (!response.ok) throw Error(`${action}: ${value.error?.message ?? value.message ?? 'Request failed'}`);
  return value;
}
const seeded = emptyState();
seeded.publishers = ['alfa', 'beta', 'gamma'].map(id => ({ id: `jornada-${id}`, version: 1, name: `Editorial ${id.toUpperCase()}`, samplesReceived: true, sampleNote: 'Ejemplar físico del ensayo' }));
seeded.teachers = ['MAT', 'MAT', 'COM', 'COM'].map((area, index) => ({ id: `jornada-docente-${index}`, version: 1, name: `Ensayo ${index + 1} Docente`, firstNames: 'Docente', lastNames: `Ensayo ${index + 1}`, area, categories: ['P1'], attended: true, attendanceEvidence: 'Ensayo local', selfRegistered: true }));
seeded.presentationQuestions = seeded.publishers.map(publisher => ({ id: `jornada-pregunta-${publisher.id}`, version: 1, publisherId: publisher.id, representativeName: 'Representante del ensayo', area: 'MAT', question: '¿Cómo se atienden los diferentes ritmos de aprendizaje?', answer: 'Con actividades de refuerzo y profundización y orientaciones para el docente.', status: 'answered', askedAt: '2026-11-04T15:00:00Z', answeredAt: '2026-11-04T15:00:00Z', updatedAt: '2026-11-04T15:00:00Z' }));
for (const [teacherIndex, teacher] of seeded.teachers.entries()) for (const [publisherIndex, publisher] of seeded.publishers.entries()) {
  const value = teacher.area === 'MAT' ? publisherIndex === 0 ? teacherIndex : publisherIndex + 2 : 4 - publisherIndex;
  seeded.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1' }), id: `jornada-ficha-${teacherIndex}-${publisherIndex}`, version: 1, rubricVersion: 2, responseScore: value, questionVersion: 1, scores: Array(10).fill(value), status: 'closed', closedAt: '2026-11-04T15:00:00Z', updatedAt: '2026-11-04T15:00:00Z', generalObservation: privateObservation });
}
mkdirSync('test-results', { recursive: true });
rmSync('test-results/jornada-local-browser-results.json', { force: true });
await rpc('demo_reset', { state: seeded });
const teacherCodes = [];
for (const teacher of seeded.teachers) { const issued = await rpc('access_create', { role: 'teacher', teacherId: teacher.id }); teacherCodes.push(issued.code); secrets.push(issued.code); }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function newPage(viewport = { width: 1360, height: 960 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /content security policy|content-security-policy|refused to (?:frame|load|connect).*blob:/i.test(message.text())) cspErrors.push(message.text()); });
  page.on('response', async response => {
    try {
      if (response.request().method() === 'POST' && response.request().postDataJSON()?.p_action === 'paper_ballots_generate' && response.ok()) {
        const body = await response.json(); if (Array.isArray(body.codes)) secrets.push(...body.codes);
      }
    } catch { /* A non-RPC request has no JSON body. */ }
  });
  return page;
}
async function rpcUi(page, action, click, expectedStatus = 200) {
  const pending = page.waitForResponse(response => {
    try { return response.request().method() === 'POST' && response.request().postDataJSON()?.p_action === action; } catch { return false; }
  });
  void pending.catch(() => undefined);
  await click(); const response = await pending; const body = await response.json();
  assert.equal(response.status(), expectedStatus, `Unexpected HTTP status for ${action}`); return body;
}
async function openAccess(page, code) {
  await page.goto(`${base}/?datos=demo#access=${encodeURIComponent(code)}`);
  await page.getByRole('button', { name: 'Actualizar información', exact: true }).waitFor();
  assert(!page.url().includes(code));
}
async function currentState() { return (await rpc('snapshot')).state; }
function markX(page, box) {
  const inset = 2.5;
  page.drawLine({ start: { x: box.x + inset, y: PAPER_A5.height - box.y - inset }, end: { x: box.x + box.size - inset, y: PAPER_A5.height - box.y - box.size + inset }, thickness: 2.2, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: box.x + inset, y: PAPER_A5.height - box.y - box.size + inset }, end: { x: box.x + box.size - inset, y: PAPER_A5.height - box.y - inset }, thickness: 2.2, color: rgb(0, 0, 0) });
}
async function markedPhoto(original, poll, extraMark = false) {
  const pdf = await PDFDocument.load(original); assert.equal(pdf.getPageCount(), 1);
  const sheet = pdf.getPage(0); assert(Math.abs(sheet.getWidth() - PAPER_A5.width) < .01); assert(Math.abs(sheet.getHeight() - PAPER_A5.height) < .01);
  const boxes = paperChoiceBoxes(poll);
  markX(sheet, boxes.find(box => box.area === 'MAT' && box.optionId === poll.options.MAT[0].id));
  markX(sheet, boxes.find(box => box.area === 'COM' && box.optionId === poll.options.COM[1].id));
  if (extraMark) markX(sheet, boxes.find(box => box.area === 'MAT' && box.optionId === poll.options.MAT[1].id));
  const stem = extraMark ? 'test-results/anonima-demo-dudosa' : 'test-results/anonima-demo-marcada';
  writeFileSync(`${stem}.pdf`, await pdf.save());
  execFileSync('pdftoppm', ['-r', '144', '-png', '-singlefile', `${stem}.pdf`, stem], { stdio: ['ignore', 'ignore', 'pipe'] });
  return `${stem}.png`;
}
let draw, teacherPage, poll, ballotBytes, acceptedPhoto;
const director = await newPage();
async function uploadAndObserve(photo, expectedStatus = 'Contada', expectedHttp = 200) {
  const input = director.locator('input[type=file][aria-label="Archivos de fotos para leer"]');
  await director.waitForFunction(() => { const input = document.querySelector('input[type=file][aria-label="Archivos de fotos para leer"]'); return input && !input.disabled; });
  const name = basename(photo);
  const before = await director.locator('.paper-reading').filter({ hasText: name }).count();
  const pending = director.waitForResponse(response => { try { return response.request().method() === 'POST' && response.request().postDataJSON()?.p_action === 'paper_scan_cast'; } catch { return false; } });
  void pending.catch(() => undefined);
  await input.setInputFiles(photo);
  await director.waitForFunction(({ name, before }) => [...document.querySelectorAll('.paper-reading')].filter(row => row.querySelector('strong')?.textContent === name).length > before, { name, before });
  await director.waitForFunction(name => {
    const row = [...document.querySelectorAll('.paper-reading')].filter(item => item.querySelector('strong')?.textContent === name).at(-1);
    const status = row?.querySelector('.status')?.textContent?.trim(); return status && !['Leyendo foto', 'Guardando'].includes(status);
  }, name);
  const row = director.locator('.paper-reading').filter({ hasText: name }).last();
  const status = (await row.locator('.status').innerText()).trim();
  if (status !== expectedStatus) {
    const reasons = await row.locator('.paper-reading-reasons li').allTextContents();
    writeFileSync('test-results/jornada-lectura-diagnostico.json', JSON.stringify({ status, reasons }, null, 2));
    throw new Error(`Photo reader status: ${status}; ${reasons.join(' · ')}`);
  }
  const response = await pending; const body = await response.json(); assert.equal(response.status(), expectedHttp); return body;
}
try {
  await checked('server draw saves one random participation order and shares that exact order with teacher and public views', async () => {
    await openAccess(director, owner);
    await director.getByRole('button', { name: 'Sala en vivo', exact: true }).click();
    await director.getByRole('checkbox', { name: 'Confirmo que ya registré todas las editoriales que llegaron.', exact: true }).check();
    await rpcUi(director, 'presentation_draw', () => director.getByRole('button', { name: 'Sortear orden de participación', exact: true }).click());
    draw = (await currentState()).presentationDraw;
    assert.equal(draw.publishers.length, 3); assert.deepEqual(new Set(draw.publishers.map(item => item.id)), new Set(seeded.publishers.map(item => item.id)));
    const order = director.locator('[aria-label="Orden de participación"] ol li'); await order.first().waitFor(); assert.equal(await order.count(), 3);
    for (const [index, publisher] of draw.publishers.entries()) assert((await order.nth(index).innerText()).includes(publisher.name));
    teacherPage = await newPage({ width: 390, height: 844 }); await openAccess(teacherPage, teacherCodes[0]);
    await teacherPage.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
    assert.deepEqual(await teacherPage.locator('[aria-label="Editoriales"] button strong').allTextContents(), draw.publishers.map((publisher, index) => `${index + 1}. ${publisher.name}`));
    const teacherSnapshot = (await rpc('snapshot', {}, teacherCodes[0])).state;
    assert.deepEqual(teacherSnapshot.presentationDraw.publishers, draw.publishers);
    assert.equal(teacherSnapshot.presentationEvaluations.length, 3);
    const projected = (await rpc('public_snapshot')).state; assert.deepEqual(projected.presentationDraw.publishers, draw.publishers);
    assert(!JSON.stringify(projected).includes(privateObservation)); assert(!JSON.stringify(projected).includes(seeded.teachers[0].name));
  });
  await checked('live-room controls start, finish and advance atomically through every drawn editorial', async () => {
    for (const [index, publisher] of draw.publishers.entries()) {
      await rpcUi(director, 'turn_control', () => director.getByRole('button', { name: index === 0 ? 'Iniciar' : 'Siguiente editorial', exact: true }).click());
      const running = await currentState(); assert.equal(running.turn.status, 'running'); assert.equal(running.turn.publisherId, publisher.id);
      await teacherPage.getByRole('button', { name: 'Actualizar información', exact: true }).click();
      await teacherPage.getByText(`En exposición: ${index + 1}. ${publisher.name}`, { exact: true }).waitFor();
      const direct = teacherPage.getByRole('button', { name: 'Ir a la editorial en exposición', exact: true });
      if (await direct.isEnabled()) await direct.click();
      assert((await teacherPage.locator('[aria-label="Editoriales"] button[aria-pressed=true] strong').innerText()).includes(publisher.name));
      await rpcUi(director, 'turn_control', () => director.getByRole('button', { name: 'Finalizar', exact: true }).click());
      const completed = await currentState(); assert.equal(completed.turn.status, 'finished'); assert.equal(completed.presentationDraw.completedPublisherIds.length, index + 1);
    }
    await director.getByText('Todas las editoriales del sorteo finalizaron.', { exact: true }).waitFor();
    await director.screenshot({ path: 'test-results/sorteo-real-completado.png', fullPage: true });
  });
  await checked('Subdirector home opens server-generated ranking with final values and every teacher reaches 100% confirmed progress', async () => {
    await director.getByRole('button', { name: 'Panel del subdirector', exact: true }).click();
    await director.getByRole('button', { name: /Generar ranking \/ Top.*Revise las posiciones/ }).click();
    await director.getByRole('heading', { name: 'Ranking y Top de editoriales', exact: true }).waitFor();
    await rpcUi(director, 'presentation_ranking_generate', () => director.getByRole('button', { name: 'Generar ranking / Top', exact: true }).click());
    const ranking = (await currentState()).presentationRanking;
    assert.equal(ranking.provisional, false); assert.equal(ranking.stale, false);
    await director.getByLabel('Mostrar', { exact: true }).selectOption('3'); assert.equal(await director.locator('.ranking-table tbody tr').count(), 3);
    assert((await director.locator('.ranking-table tbody tr').first().innerText()).includes('GAMMA'));
    await director.screenshot({ path: 'test-results/ranking-real-final.png', fullPage: true });
    await director.getByRole('button', { name: 'Docentes y avance', exact: true }).click();
    await director.getByRole('heading', { name: 'Docentes y avance', exact: true }).waitFor();
    assert.equal(await director.locator('.progress-table tbody tr').count(), 4);
    for (const row of await director.locator('.progress-table tbody tr').all()) { const text = await row.innerText(); assert(text.includes('100 %')); assert(text.includes('3 / 3')); assert(text.includes('Finalizado')); }
    await director.getByLabel('Área', { exact: true }).selectOption('MAT'); assert.equal(await director.locator('.progress-table tbody tr').count(), 2);
    await director.getByLabel('Estado', { exact: true }).selectOption('in_progress'); await director.getByText('No hay docentes con estos filtros.', { exact: true }).waitFor();
    await director.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
    await director.setViewportSize({ width: 390, height: 844 });
    await director.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
    const closeToast = director.getByRole('button', { name: 'Cerrar aviso', exact: true }); if (await closeToast.count()) await closeToast.click();
    assert(await director.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await director.screenshot({ path: 'test-results/seguimiento-real-movil.png', fullPage: true }); await director.setViewportSize({ width: 1360, height: 960 });
    const teacherSnapshot = (await rpc('snapshot', {}, teacherCodes[0])).state;
    const publicSnapshot = (await rpc('public_snapshot')).state;
    assert(!teacherSnapshot.presentationRanking); assert(!publicSnapshot.presentationRanking);
  });
  await checked('paper UI creates an anonymous two-area election and serves the actual one-page A5 PDF through its CSP-permitted blob frame', async () => {
    await director.getByRole('button', { name: 'Votación de padres · A5', exact: true }).click();
    await director.getByRole('heading', { name: 'Votación en papel', exact: true }).waitFor();
    await director.getByRole('checkbox', { name: 'Confirmo que las familias pudieron revisar los ejemplares físicos y que estas son las opciones que se imprimirán.', exact: true }).check();
    poll = await rpcUi(director, 'paper_poll_create', () => director.getByRole('button', { name: 'Crear votación en papel', exact: true }).click());
    assert.deepEqual(poll.areas, ['MAT', 'COM']); assert.equal(poll.block, 'P1');
    await director.getByLabel('Cantidad de fichas A5', { exact: true }).fill('1');
    const generated = await rpcUi(director, 'paper_ballots_generate', () => director.getByRole('button', { name: 'Generar fichas A5', exact: true }).click());
    secrets.push(...generated.codes); poll = generated.poll; assert.equal(poll.generated, 1);
    const frame = director.getByTitle('Vista previa de las fichas A5', { exact: true }); await frame.waitFor({ state: 'visible' });
    const url = await frame.getAttribute('src'); assert(url.startsWith('blob:'));
    ballotBytes = new Uint8Array(await director.evaluate(async source => Array.from(new Uint8Array(await (await fetch(source)).arrayBuffer())), url));
    const pdf = await PDFDocument.load(ballotBytes); assert.equal(pdf.getPageCount(), 1);
    assert(Math.abs(pdf.getPage(0).getWidth() - PAPER_A5.width) < .01); assert(Math.abs(pdf.getPage(0).getHeight() - PAPER_A5.height) < .01);
    writeFileSync('test-results/anonima-demo-A5.pdf', ballotBytes);
    acceptedPhoto = await markedPhoto(ballotBytes, poll);
  });
  await checked('a real rasterized A5 photograph passes local QR and mark recognition and immediately updates server vote aggregates', async () => {
    const accepted = await uploadAndObserve(acceptedPhoto);
    assert.equal(accepted.accepted, true); poll = accepted.poll;
    assert.equal(poll.received, 1); assert.equal(poll.counts.MAT.options[poll.options.MAT[0].id], 1); assert.equal(poll.counts.COM.options[poll.options.COM[1].id], 1);
    const reading = director.locator('.paper-reading').filter({ hasText: 'anonima-demo-marcada.png' });
    await reading.getByText('Contada', { exact: true }).waitFor();
    assert(await reading.locator('img').evaluate(image => image.complete && image.naturalWidth > 0));
    const serverPoll = (await currentState()).paperPolls.find(item => item.id === poll.id); assert.equal(serverPoll.received, 1);
  });
  await checked('photographing the same sheet again yields a server conflict and never adds a second vote', async () => {
    await uploadAndObserve(acceptedPhoto, 'Ya había sido contada', 409);
    await director.getByText('La ficha ya fue registrada; esta foto no añadió votos.', { exact: true }).waitFor();
    const serverPoll = (await currentState()).paperPolls.find(item => item.id === poll.id); assert.equal(serverPoll.received, 1); assert.equal(serverPoll.counts.MAT.options[poll.options.MAT[0].id], 1);
  });
  await checked('multiple dark choices stay in manual review and cannot silently alter the anonymous count', async () => {
    const doubtfulPhoto = await markedPhoto(ballotBytes, poll, true);
    await director.waitForFunction(() => !document.querySelector('input[type=file][aria-label="Archivos de fotos para leer"]').disabled);
    await director.locator('input[type=file][aria-label="Archivos de fotos para leer"]').setInputFiles(doubtfulPhoto);
    const reading = director.locator('.paper-reading').filter({ hasText: 'anonima-demo-dudosa.png' }); await reading.getByText('Revisión necesaria', { exact: true }).waitFor();
    assert((await reading.innerText()).includes('más de una casilla marcada'));
    assert.equal((await currentState()).paperPolls.find(item => item.id === poll.id).received, 1);
    assert(await director.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).isDisabled());
    await reading.getByRole('button', { name: 'Quitar anonima-demo-dudosa.png de la lista', exact: true }).click();
  });
  await checked('closing the paper election computes distinct winners without exposing codes, photos or private ranking to public and teacher snapshots', async () => {
    await director.getByRole('checkbox', { name: 'Confirmo que terminó la recepción y revisé el escrutinio.', exact: true }).check();
    const closed = await rpcUi(director, 'paper_poll_close', () => director.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).click());
    assert.equal(closed.status, 'closed'); assert.equal(closed.results.MAT.state, 'winner'); assert.equal(closed.results.COM.state, 'winner');
    assert.equal(closed.results.MAT.winnerId, poll.options.MAT[0].id); assert.equal(closed.results.COM.winnerId, poll.options.COM[1].id);
    await director.locator('[aria-label="Resultados de la votación"]').screenshot({ path: 'test-results/recuento-real-resultados.png' });
    for (const state of [(await rpc('snapshot', {}, teacherCodes[0])).state, (await rpc('public_snapshot')).state]) {
      assert(!state.presentationRanking); assert(!state.paperPolls?.length); const serialized = JSON.stringify(state);
      assert(!serialized.includes(privateObservation) || state.presentationEvaluations?.every(form => form.teacherId === seeded.teachers[0].id));
      for (const secret of secrets) assert(!serialized.includes(secret));
    }
    assert.deepEqual(cspErrors, []); assert.deepEqual(pageErrors, []);
  });
  writeFileSync('test-results/jornada-local-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'Node/Express + PostgreSQL + PostgREST reales; QR y OMR reales en Chromium', passed: checks.length, checks, pageErrors, cspErrors }, null, 2));
} catch (error) {
  const message = secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(error?.stack ?? error)); console.error(message); process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
