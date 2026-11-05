// Full local integration only. Every mutation is restricted to the disposable demo dataset.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation } from '../shared/presentation.ts';
import { PAPER_A5 } from '../shared/paper-layout.ts';

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
seeded.presentationQuestions = [];
for (const [teacherIndex, teacher] of seeded.teachers.entries()) for (const [publisherIndex, publisher] of seeded.publishers.entries()) {
  const value = teacher.area === 'MAT' ? publisherIndex === 0 ? teacherIndex : publisherIndex + 2 : 4 - publisherIndex;
  seeded.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: teacher.area, block: 'P1' }), id: `jornada-ficha-${teacherIndex}-${publisherIndex}`, version: 1, rubricVersion: 2, responseScore: value, questionVersion: null, scores: Array(10).fill(value), status: 'closed', closedAt: '2026-11-04T15:00:00Z', updatedAt: '2026-11-04T15:00:00Z', generalObservation: privateObservation });
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
        const body = await response.json(); if (Array.isArray(body.codes)) secrets.push(...body.codes.filter(code => code.length >= 20));
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
  assert.equal(response.status(), expectedStatus, `Unexpected HTTP status for ${action}: ${secrets.reduce((message, secret) => secret ? message.split(secret).join('[redacted]') : message, String(body.error?.message ?? body.message ?? ''))}`); return body;
}
async function openAccess(page, code) {
  await page.goto(`${base}/?datos=demo#access=${encodeURIComponent(code)}`);
  await page.getByRole('button', { name: 'Actualizar información', exact: true }).waitFor();
  assert(!page.url().includes(code));
}
async function currentState() { return (await rpc('snapshot')).state; }
let draw, teacherPage, poll, ballotBytes;
const director = await newPage();
const classroom = id => poll.classrooms.find(item => item.id === id);
const classroomRow = id => director.getByRole('region', { name: 'Padrón de aulas', exact: true }).getByRole('article', { name: classroom(id).label, exact: true });
async function currentPoll() { return (await currentState()).paperPolls.find(item => item.id === poll.id); }
async function rawRpc(action, payload) {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: owner, p_dataset: 'demo' }) });
  return { status: response.status, body: await response.json() };
}
async function manualForm(classroomId, choices, correcting = false) {
  if (correcting) await classroomRow(classroomId).getByRole('button', { name: 'Revisar voto', exact: true }).click();
  else await classroomRow(classroomId).getByRole('button', { name: 'Transcribir voto', exact: true }).click();
  const form = director.getByRole('form', { name: 'Transcripción manual del voto', exact: true }); await form.waitFor();
  const aula = form.getByLabel('Aula del voto manual', { exact: true });
  if (await aula.isEnabled()) await aula.selectOption(classroomId);
  await form.getByLabel('Matemática · voto manual', { exact: true }).selectOption(choices.MAT ?? '__blank__');
  await form.getByLabel('Comunicación · voto manual', { exact: true }).selectOption(choices.COM ?? '__blank__');
  await form.getByRole('checkbox', { name: 'Comparé los votos con la ficha de papel original.', exact: true }).check();
  if (correcting) await form.getByLabel('Motivo de la corrección', { exact: true }).fill('Corrección contrastada con la ficha de papel original');
  return form;
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
  await checked('a single checkbox confirms each question and answer while existing teacher scores remain independent', async () => {
    const formsBefore = (await currentState()).presentationEvaluations;
    for (const [index, publisher] of draw.publishers.entries()) {
      await rpcUi(director, 'turn_control', () => director.getByRole('button', { name: index === 0 ? 'Iniciar' : 'Siguiente editorial', exact: true }).click());
      const running = await currentState(); assert.equal(running.turn.status, 'running'); assert.equal(running.turn.publisherId, publisher.id);
      await teacherPage.getByRole('button', { name: 'Actualizar información', exact: true }).click();
      await teacherPage.getByText(`En exposición: ${index + 1}. ${publisher.name}`, { exact: true }).waitFor();
      const direct = teacherPage.getByRole('button', { name: 'Ir a la editorial en exposición', exact: true });
      if (await direct.isEnabled()) await direct.click();
      assert((await teacherPage.locator('[aria-label="Editoriales"] button[aria-pressed=true] strong').innerText()).includes(publisher.name));
      assert(await director.getByRole('button', { name: 'Finalizar', exact: true }).isDisabled());
      assert.equal(await director.getByLabel('Representante docente que pregunta', { exact: true }).count(), 0);
      assert.equal(await director.getByLabel('Área de la pregunta', { exact: true }).count(), 0);
      assert.equal(await director.getByLabel('Pregunta formulada a la editorial', { exact: true }).count(), 0);
      assert.equal(await director.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).count(), 0);
      const checkbox = director.getByRole('checkbox', { name: /Confirmo que un representante docente hizo la pregunta y la editorial respondió/ });
      const confirmation = await rpcUi(director, 'presentation_question_save', () => checkbox.click());
      assert.equal(confirmation.publisherId, publisher.id); assert.equal(confirmation.confirmed, true); assert.equal(confirmation.status, 'answered');
      await director.waitForFunction(() => document.querySelector('#pregunta-obligatoria input[type=checkbox]')?.checked === true);
      await rpcUi(director, 'turn_control', () => director.getByRole('button', { name: 'Finalizar', exact: true }).click());
      const completed = await currentState(); assert.equal(completed.turn.status, 'finished'); assert.equal(completed.presentationDraw.completedPublisherIds.length, index + 1);
    }
    assert.deepEqual((await currentState()).presentationEvaluations, formsBefore);
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
  await checked('paper voting creates exactly five A–E classrooms per grade, without a photo scanner or arbitrary ballot quantity', async () => {
    await director.getByRole('button', { name: 'Votación de padres · A5', exact: true }).click();
    await director.getByRole('heading', { name: 'Votación en papel', exact: true }).waitFor();
    await director.getByRole('checkbox', { name: 'Confirmo que las familias pudieron revisar los ejemplares físicos y que estas son las opciones que se imprimirán.', exact: true }).check();
    poll = await rpcUi(director, 'paper_poll_create', () => director.getByRole('button', { name: 'Crear votación en papel', exact: true }).click());
    assert.deepEqual(poll.areas, ['MAT', 'COM']); assert.equal(poll.block, 'P1'); assert.equal(poll.rosterVersion, 1);
    assert.equal(poll.classrooms.length, 10);
    for (const grade of ['PRI1', 'PRI2']) assert.deepEqual(poll.classrooms.filter(item => item.gradeId === grade).map(item => item.section), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(await director.getByRole('region', { name: 'Padrón de aulas', exact: true }).getByRole('article').count(), 10);
    assert.equal(await director.getByLabel('Cantidad de fichas A5', { exact: true }).count(), 0);
    assert.equal(await director.locator('input[type=file][aria-label="Archivos de fotos para leer"]').count(), 0);
    assert.equal(await director.getByRole('button', { name: 'Leer fotos', exact: true }).count(), 0);
  });
  await checked('Sin asistencia is saved per classroom and excludes that classroom from printing and manual voting', async () => {
    const attendance = director.getByLabel(`Asistencia · ${classroom('PRI2-E').label}`, { exact: true });
    poll = await rpcUi(director, 'paper_attendance_save', () => attendance.selectOption('absent'));
    assert.equal(classroom('PRI2-E').attendance, 'absent'); assert.equal(poll.received, 0); assert.equal(poll.generated, 0);
    const before = await currentPoll();
    const rejected = await rawRpc('paper_manual_cast', { pollId: poll.id, classroomId: 'PRI2-E', choices: { MAT: poll.options.MAT[0].id, COM: poll.options.COM[1].id }, expectedVersion: poll.version, confirmation: true });
    assert([400, 409, 423].includes(rejected.status)); assert.deepEqual(await currentPoll(), before);
    assert(await classroomRow('PRI2-E').getByRole('button', { name: 'Transcribir voto', exact: true }).isDisabled());
    assert(await classroomRow('PRI2-E').getByRole('button', { name: 'Generar ficha A5', exact: true }).isDisabled());
  });
  await checked('a classroom vote can be transcribed without a photograph, QR code or previously issued ballot', async () => {
    const form = await manualForm('PRI1-B', { MAT: poll.options.MAT[0].id, COM: poll.options.COM[1].id });
    const absentOption = form.getByLabel('Aula del voto manual', { exact: true }).locator('option[value="PRI2-E"]');
    assert(await absentOption.count() === 0 || await absentOption.evaluate(option => option.disabled));
    const accepted = await rpcUi(director, 'paper_manual_cast', () => form.getByRole('button', { name: 'Guardar voto manual', exact: true }).click());
    assert.equal(accepted.accepted, true); poll = accepted.poll;
    assert.equal(poll.generated, 1); assert.equal(poll.received, 1);
    assert.equal(classroom('PRI1-B').attendance, 'present'); assert.equal(classroom('PRI1-B').ballotIssued, true); assert.equal(classroom('PRI1-B').received, true);
    assert.equal(poll.counts.MAT.options[poll.options.MAT[0].id], 1); assert.equal(poll.counts.COM.options[poll.options.COM[1].id], 1);
    assert.equal(await director.getByLabel('Código anónimo', { exact: true }).count(), 0);
  });
  await checked('A5 printing uses only outstanding non-absent classrooms and shows each classroom and short folio without QR or long codes', async () => {
    const generated = await rpcUi(director, 'paper_ballots_generate', () => director.getByRole('button', { name: 'Generar fichas A5 del padrón', exact: true }).click());
    poll = generated.poll; assert.equal(poll.generated, 9); assert.equal(poll.received, 1); assert.equal(generated.ballots.length, 8);
    assert(!generated.ballots.some(item => ['PRI1-B', 'PRI2-E'].includes(item.classroomId)));
    assert(generated.ballots.every(item => /^P1-\d{2}$/.test(item.folio)));
    const frame = director.getByTitle('Vista previa de las fichas A5', { exact: true }); await frame.waitFor({ state: 'visible' });
    const url = await frame.getAttribute('src'); assert(url.startsWith('blob:'));
    ballotBytes = new Uint8Array(await director.evaluate(async source => Array.from(new Uint8Array(await (await fetch(source)).arrayBuffer())), url));
    const pdf = await PDFDocument.load(ballotBytes); assert.equal(pdf.getPageCount(), 8);
    for (const page of pdf.getPages()) { assert(Math.abs(page.getWidth() - PAPER_A5.width) < .01); assert(Math.abs(page.getHeight() - PAPER_A5.height) < .01); }
    writeFileSync('test-results/aulas-demo-A5.pdf', ballotBytes);
    execFileSync('pdftotext', ['-layout', 'test-results/aulas-demo-A5.pdf', 'test-results/aulas-demo-A5.txt'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const text = readFileSync('test-results/aulas-demo-A5.txt', 'utf8').replace(/\s+/g, ' ');
    for (const ballot of generated.ballots) { assert(text.includes(ballot.classroomLabel)); assert(text.includes(ballot.folio)); }
    assert.doesNotMatch(text, /Código anónimo|AE27\||Fotografíe|QR/); assert(!text.includes(classroom('PRI2-E').label)); assert(!text.includes(classroom('PRI1-B').label));
  });
  await checked('a second manual classroom vote is counted once and an immediate duplicate is rejected without changing aggregates', async () => {
    const choices = { MAT: poll.options.MAT[0].id, COM: poll.options.COM[1].id };
    const form = await manualForm('PRI1-A', choices);
    const accepted = await rpcUi(director, 'paper_manual_cast', () => form.getByRole('button', { name: 'Guardar voto manual', exact: true }).click());
    poll = accepted.poll; assert.equal(poll.received, 2); assert.equal(poll.generated, 9);
    const before = await currentPoll();
    const duplicate = await rawRpc('paper_manual_cast', { pollId: poll.id, classroomId: 'PRI1-A', choices, expectedVersion: poll.version, confirmation: true });
    assert.equal(duplicate.status, 409); assert.deepEqual(await currentPoll(), before);
    const absent = await rawRpc('paper_attendance_save', { pollId: poll.id, classroomId: 'PRI1-A', attendance: 'absent', expectedVersion: poll.version });
    assert([409, 423].includes(absent.status)); assert.deepEqual(await currentPoll(), before);
  });
  await checked('a documented correction changes only the selected choices and never adds a classroom or a received vote', async () => {
    const choices = { MAT: poll.options.MAT[1].id, COM: poll.options.COM[1].id };
    const originalVoteVersion = classroom('PRI1-B').voteVersion;
    const form = await manualForm('PRI1-B', choices, true);
    const corrected = await rpcUi(director, 'paper_manual_correct', () => form.getByRole('button', { name: 'Guardar corrección', exact: true }).click());
    poll = corrected.poll ?? corrected;
    assert.equal(poll.received, 2); assert.equal(poll.generated, 9);
    assert.equal(poll.counts.MAT.options[poll.options.MAT[0].id], 1); assert.equal(poll.counts.MAT.options[poll.options.MAT[1].id], 1);
    assert.equal(poll.counts.COM.options[poll.options.COM[1].id], 2);
    assert.equal(classroom('PRI1-B').received, true); assert.equal(classroom('PRI1-B').voteVersion, originalVoteVersion + 1);
    assert.deepEqual(classroom('PRI1-B').choices, choices);
    const before = await currentPoll();
    const stale = await rawRpc('paper_manual_correct', { pollId: poll.id, classroomId: 'PRI1-B', choices, expectedVersion: poll.version, expectedVoteVersion: originalVoteVersion, reason: 'Un intento atrasado no debe alterar el voto ya corregido', confirmation: true });
    assert.equal(stale.status, 409); assert.deepEqual(await currentPoll(), before);
  });
  await checked('public results identify each classroom and its registered options while preserving coordinator access secrets', async () => {
    const projected = (await rpc('public_snapshot')).state;
    assert(!projected.presentationRanking);
    const serialized = JSON.stringify(projected);
    assert(serialized.includes('PRI1-A')); assert(serialized.includes('PRI1-B')); assert(serialized.includes('PRI2-E'));
    assert(serialized.includes(poll.options.MAT[0].id)); assert(serialized.includes(poll.options.MAT[1].id)); assert(serialized.includes(poll.options.COM[1].id));
    assert(!serialized.includes(privateObservation));
    for (const secret of secrets) assert(!serialized.includes(secret));
    const projection = await newPage({ width: 390, height: 844 });
    await projection.goto(`${base}/?vista=publica&datos=demo#votacion-padres`);
    await projection.getByRole('heading', { name: 'Votación por aula', exact: true }).waitFor();
    const election = projection.getByLabel('Votación de familias', { exact: true });
    if (await election.count()) await election.selectOption(poll.id);
    const table = projection.getByRole('table', { name: 'Votos registrados por aula', exact: true });
    await table.waitFor(); assert.equal(await table.locator('tbody tr').count(), 10);
    const corrected = table.locator('tbody tr').filter({ hasText: classroom('PRI1-B').label });
    assert((await corrected.innerText()).includes(poll.options.MAT[1].name));
    assert((await corrected.innerText()).includes(poll.options.COM[1].name));
    assert((await table.locator('tbody tr').filter({ hasText: classroom('PRI2-E').label }).innerText()).includes('Sin asistencia'));
    assert(await projection.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await projection.screenshot({ path: 'test-results/votacion-aulas-publica-movil.png', fullPage: true });
  });
  await checked('closing freezes classroom entry and computes a Mathematics tie independently of the Communication winner', async () => {
    for (const room of poll.classrooms.filter(item => !item.received && item.attendance !== 'absent')) {
      poll = await rpc('paper_attendance_save', { pollId: poll.id, classroomId: room.id, attendance: 'absent', expectedVersion: poll.version });
    }
    await rpcUi(director, 'snapshot', () => director.getByRole('button', { name: 'Actualizar información', exact: true }).click());
    await director.waitForFunction(() => [...document.querySelectorAll('select[aria-label^="Asistencia · "]')].every(select => select.value === 'absent' || select.disabled && select.value === 'present'));
    await director.getByRole('checkbox', { name: 'Confirmo que terminó la recepción y revisé el escrutinio.', exact: true }).check();
    const closed = await rpcUi(director, 'paper_poll_close', () => director.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).click());
    assert.equal(closed.status, 'closed'); assert.equal(closed.results.MAT.state, 'tie'); assert.equal(closed.results.COM.state, 'winner');
    assert.equal(closed.results.COM.winnerId, poll.options.COM[1].id); assert.equal(closed.received, 2);
    await director.locator('[aria-label="Resultados de la votación"]').screenshot({ path: 'test-results/recuento-real-resultados.png' });
    const retry = await rawRpc('paper_manual_cast', { pollId: poll.id, classroomId: 'PRI1-C', choices: { MAT: poll.options.MAT[0].id, COM: poll.options.COM[1].id }, expectedVersion: closed.version, confirmation: true });
    assert.equal(retry.status, 423);
    assert.deepEqual(cspErrors, []); assert.deepEqual(pageErrors, []);
  });
  writeFileSync('test-results/jornada-local-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'Node/Express + PostgreSQL + PostgREST reales; padrón, asistencia, A5 por aula y voto manual con corrección', passed: checks.length, checks, pageErrors, cspErrors }, null, 2));
} catch (error) {
  const message = secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(error?.stack ?? error)); console.error(message); process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
