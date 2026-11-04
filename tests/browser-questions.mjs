// Isolated UI regression; never contacts a database or production service.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { emptyState } from '../shared/defaults.ts';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }); await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [], contexts = [];
const check = async (name, operation) => { await operation(); checks.push(name); console.log(`✓ ${name}`); };
const state = emptyState();
state.publishers = [{ id: 'question-one', version: 1, name: 'Editorial de pregunta', samplesReceived: false, sampleNote: '' }];
state.turn = { publisherId: 'question-one', status: 'running', startedAt: new Date().toISOString(), pausedAt: null, pausedMilliseconds: 0 };
state.presentationQuestions = [];
const calls = [];
let saveFailure = null;
async function open(role = 'coordinator') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/questions-fixture.tsx';" }));
  await context.route('**/api/questions-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: { state, actor: { id: 'question-director', name: 'Subdirector', role }, dataset: 'demo', serverNow: new Date().toISOString() } });
    if (action === 'presentation_question_save') {
      assert.equal(role, 'coordinator');
      assert.deepEqual(Object.keys(payload).sort(), ['confirmed', 'expectedVersion', 'publisherId']);
      assert.equal(typeof payload.confirmed, 'boolean');
      if (saveFailure) { const message = saveFailure; saveFailure = null; return route.fulfill({ status: 503, json: { message } }); }
      const old = state.presentationQuestions.find(item => item.publisherId === payload.publisherId);
      if (payload.expectedVersion !== (old?.version ?? 0)) return route.fulfill({ status: 409, json: { message: 'La confirmación cambió en otra pantalla. Actualice antes de guardar.' } });
      const now = new Date().toISOString();
      const result = { id: old?.id ?? 'question-record', version: (old?.version ?? 0) + 1, publisherId: payload.publisherId,
        confirmed: payload.confirmed, status: payload.confirmed ? 'answered' : 'draft',
        askedAt: payload.confirmed ? old?.askedAt || now : null, answeredAt: payload.confirmed ? now : null, updatedAt: now };
      state.presentationQuestions = state.presentationQuestions.filter(item => item.publisherId !== payload.publisherId).concat(result);
      return route.fulfill({ json: result });
    }
    assert.equal(action, 'turn_control'); assert(isDeepStrictEqual(payload.expectedTurn, state.turn)); assert.equal(payload.command, 'finish');
    if (!state.presentationQuestions.some(item => item.publisherId === state.turn.publisherId && item.confirmed === true)) return route.fulfill({ status: 423, json: { message: 'Falta confirmar la pregunta obligatoria.' } });
    state.turn = { ...state.turn, status: 'finished', pausedAt: new Date().toISOString() };
    return route.fulfill({ json: state.turn });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Sala en vivo', exact: true }).waitFor();
  return page;
}
try {
  const p = await open();
  const region = p.getByRole('region', { name: 'Pregunta obligatoria de la editorial' });
  const checkbox = region.getByRole('checkbox', { name: 'Confirmo que un representante docente hizo la pregunta y la editorial respondió.', exact: true });
  await check('room question is one checkbox with no name, area, transcription or save form', async () => {
    assert.equal(await region.getByRole('checkbox').count(), 1);
    assert.equal(await region.locator('input:not([type="checkbox"]), select, textarea, button').count(), 0);
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isDisabled());
    assert.equal(calls.filter(call => call.action !== 'snapshot').length, 0);
    assert(await region.getByText(/Cada docente puede puntuar la respuesta de 0 a 4 en I11 sin esperar esta confirmación/).isVisible());
  });
  await check('checking auto-saves only the minimal confirmation and enables finishing', async () => {
    await checkbox.click();
    await region.getByText('Pregunta y respuesta confirmadas.', { exact: true }).waitFor();
    assert.equal(state.presentationQuestions[0].confirmed, true);
    assert.equal(state.presentationQuestions[0].status, 'answered');
    assert.equal(state.presentationQuestions[0].representativeName, undefined);
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isEnabled());
    assert(await checkbox.isChecked());
    assert.deepEqual(calls.filter(call => call.action === 'presentation_question_save').at(-1).payload,
      { publisherId: 'question-one', expectedVersion: 0, confirmed: true });
  });
  await check('closed teacher grades do not freeze the checkbox or change when it is unchecked', async () => {
    const now = new Date().toISOString();
    state.presentationEvaluations = [{ id: 'graded-zero', publisherId: 'question-one', teacherId: 'teacher-one', area: 'MAT', block: 'P1', scaleMax: 4, rubricVersion: 2, version: 1,
      scores: Array(10).fill(0), notes: Array(10).fill(''), responseScore: 0, questionVersion: 1, status: 'closed', closedAt: now, updatedAt: now, generalObservation: '', physicalText: '', rulesVersion: 1 }];
    await p.getByRole('button', { name: 'Sincronizar', exact: true }).click();
    assert(await checkbox.isEnabled());
    const grades = structuredClone(state.presentationEvaluations);
    await checkbox.click();
    await p.getByText('Confirmación retirada.', { exact: true }).waitFor();
    assert.equal(state.presentationQuestions[0].confirmed, false);
    assert(!await checkbox.isChecked());
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isDisabled());
    assert.deepEqual(state.presentationEvaluations, grades);
  });
  await check('a failed save leaves the persisted checkbox unchanged and allows retry', async () => {
    saveFailure = 'No se pudo guardar por falta de conexión.';
    await checkbox.click();
    await region.getByRole('alert').filter({ hasText: 'No se pudo guardar por falta de conexión.' }).waitFor();
    assert(!await checkbox.isChecked());
    assert.equal(state.presentationQuestions[0].confirmed, false);
    assert(await checkbox.isEnabled());
  });
  await check('a concurrent confirmation rejects stale CAS and refreshes before another change', async () => {
    const remote = state.presentationQuestions[0]; remote.version++; remote.confirmed = true; remote.status = 'answered'; remote.askedAt = remote.answeredAt = new Date().toISOString();
    const before = calls.filter(call => call.action === 'presentation_question_save').length;
    await checkbox.click();
    await region.getByRole('button', { name: 'Actualizar confirmación', exact: true }).waitFor();
    assert(!await checkbox.isChecked()); assert(await checkbox.isDisabled());
    assert.equal(calls.filter(call => call.action === 'presentation_question_save').length, before + 1);
    await region.getByRole('button', { name: 'Actualizar confirmación', exact: true }).click();
    await p.waitForFunction(() => document.querySelector('#pregunta-obligatoria input[type="checkbox"]')?.checked);
    assert(await checkbox.isChecked()); assert(await checkbox.isEnabled());
    await checkbox.click();
    await p.waitForFunction(() => !document.querySelector('#pregunta-obligatoria input[type="checkbox"]')?.checked);
    assert.equal(state.presentationQuestions[0].confirmed, false);
    await checkbox.click();
    await region.getByText('Pregunta y respuesta confirmadas.', { exact: true }).waitFor();
  });
  await check('finalization preserves the confirmation and other roles cannot edit it', async () => {
    await p.getByRole('button', { name: 'Finalizar', exact: true }).click();
    await region.getByText('La exposición finalizó. La confirmación se conserva.', { exact: true }).waitFor();
    assert(await checkbox.isChecked()); assert(await checkbox.isDisabled());
    for (const role of ['teacher', 'secretary']) { const other = await open(role); assert.equal(await other.getByRole('region', { name: 'Pregunta obligatoria de la editorial' }).count(), 0); }
  });
  await check('a missing confirmation can be recovered after finishing without changing teacher grades', async () => {
    const grades = structuredClone(state.presentationEvaluations);
    state.presentationQuestions = [];
    await p.getByRole('button', { name: 'Sincronizar', exact: true }).click();
    await region.getByText('La exposición finalizó. Puede recuperar la confirmación si la pregunta se realizó y la editorial respondió.', { exact: true }).waitFor();
    assert(!await checkbox.isChecked()); assert(await checkbox.isEnabled());
    await checkbox.click();
    await region.getByText('La exposición finalizó. La confirmación se conserva.', { exact: true }).waitFor();
    assert(await checkbox.isChecked()); assert(await checkbox.isDisabled());
    assert.equal(state.presentationQuestions[0].confirmed, true);
    assert.equal(state.turn.status, 'finished');
    assert.deepEqual(state.presentationEvaluations, grades);
  });
  await check('the confirmation fits a phone without horizontally scrolling', async () => {
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    mkdirSync('test-results', { recursive: true }); await region.screenshot({ path: 'test-results/pregunta-obligatoria-movil.png' });
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/questions-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated server responses; no database changes', passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
