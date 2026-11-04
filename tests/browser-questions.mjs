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
async function open(role = 'coordinator') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/questions-fixture.tsx';" }));
  await context.route('**/api/questions-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: { state, actor: { id: 'question-director', name: 'Subdirector', role }, dataset: 'demo', serverNow: new Date().toISOString() } });
    if (action === 'presentation_question_save') {
      assert.equal(role, 'coordinator');
      const old = state.presentationQuestions.find(item => item.publisherId === payload.publisherId);
      if (payload.expectedVersion !== (old?.version ?? 0)) return route.fulfill({ status: 409, json: { message: 'La pregunta cambió en otra pantalla. Actualice antes de guardar.' } });
      if (payload.status === 'answered') assert(payload.representativeName && payload.area && payload.question && payload.answer);
      const now = new Date().toISOString();
      const result = { id: old?.id ?? 'question-record', version: (old?.version ?? 0) + 1, publisherId: payload.publisherId,
        representativeName: payload.representativeName, area: payload.area, question: payload.question, answer: payload.answer, status: payload.status,
        askedAt: payload.status === 'answered' ? old?.askedAt || now : null, answeredAt: payload.status === 'answered' ? now : null, updatedAt: now };
      state.presentationQuestions = state.presentationQuestions.filter(item => item.publisherId !== payload.publisherId).concat(result);
      return route.fulfill({ json: result });
    }
    assert.equal(action, 'turn_control'); assert(isDeepStrictEqual(payload.expectedTurn, state.turn)); assert.equal(payload.command, 'finish');
    if (!state.presentationQuestions.some(item => item.publisherId === state.turn.publisherId && item.status === 'answered')) return route.fulfill({ status: 423, json: { message: 'Falta confirmar la pregunta obligatoria.' } });
    state.turn = { ...state.turn, status: 'finished', pausedAt: new Date().toISOString() };
    return route.fulfill({ json: state.turn });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Sala en vivo', exact: true }).waitFor();
  return page;
}
try {
  const p = await open();
  await check('manual exposition cannot finish before its required question and answer are confirmed', async () => {
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isDisabled());
    assert(await p.getByRole('button', { name: 'Confirmar pregunta y respuesta', exact: true }).isDisabled());
    assert.equal(calls.filter(call => call.action !== 'snapshot').length, 0);
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  await check('a representative may ask from either area; saving only a draft keeps finalization blocked', async () => {
    await p.getByLabel('Representante docente que pregunta', { exact: true }).fill('Docente representante de ensayo');
    await p.getByLabel('Área de la pregunta', { exact: true }).selectOption('COM');
    await p.getByLabel('Pregunta formulada a la editorial', { exact: true }).fill('¿Cómo retroalimentan una interpretación del texto?');
    await p.getByRole('button', { name: 'Guardar borrador de pregunta', exact: true }).click();
    await p.getByText('Borrador de pregunta guardado.', { exact: true }).waitFor();
    assert.equal(state.presentationQuestions[0].status, 'draft'); assert.equal(state.presentationQuestions[0].area, 'COM');
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isDisabled());
  });
  await check('an explicit observed answer unlocks finish without any minimum teacher score', async () => {
    await p.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).fill('Explicó una actividad y una devolución específica al estudiante.');
    assert(await p.getByRole('button', { name: 'Confirmar pregunta y respuesta', exact: true }).isDisabled());
    await p.getByRole('checkbox', { name: 'Confirmo que el representante hizo la pregunta y que la editorial respondió.', exact: true }).check();
    await p.getByRole('button', { name: 'Confirmar pregunta y respuesta', exact: true }).click();
    await p.getByText('Pregunta y respuesta confirmadas. Ya puede finalizar esta exposición.', { exact: true }).waitFor();
    assert.equal(state.presentationQuestions[0].status, 'answered'); assert.equal(state.presentationEvaluations.length, 0);
    assert(await p.getByRole('button', { name: 'Finalizar', exact: true }).isEnabled());
    mkdirSync('test-results', { recursive: true }); await p.getByRole('region', { name: 'Pregunta obligatoria de la editorial' }).screenshot({ path: 'test-results/pregunta-obligatoria-movil.png' });
  });
  await check('a stale question save keeps local text and requires consulting the newer server record', async () => {
    await p.getByRole('button', { name: 'Corregir registro antes de finalizar', exact: true }).click();
    await p.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).fill('Mi corrección local no se debe perder.');
    await p.getByLabel('Motivo de la corrección', { exact: true }).fill('Aclaración de lo escuchado antes de terminar');
    const remote = state.presentationQuestions[0]; remote.version++; remote.answer = 'Respuesta actualizada por otra pantalla.';
    await p.getByRole('checkbox', { name: 'Confirmo que el representante hizo la pregunta y que la editorial respondió.', exact: true }).check();
    await p.getByRole('button', { name: 'Confirmar pregunta y respuesta', exact: true }).click();
    await p.getByRole('alert').filter({ hasText: 'La pregunta cambió en otra pantalla.' }).waitFor();
    assert.equal(await p.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).inputValue(), 'Mi corrección local no se debe perder.');
    await p.getByRole('button', { name: 'Sincronizar', exact: true }).click();
    await p.getByRole('button', { name: 'Consultar el registro del servidor', exact: true }).click();
    assert.equal(await p.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).inputValue(), 'Respuesta actualizada por otra pantalla.');
  });
  await check('finalization freezes the shared answer and teaching/secretary roles cannot edit the question', async () => {
    await p.getByRole('button', { name: 'Finalizar', exact: true }).click();
    await p.getByText('La exposición ya finalizó o su respuesta fue valorada. Este registro se conserva para que todos evalúen la misma respuesta.', { exact: true }).waitFor();
    assert(await p.getByLabel('Resumen de la respuesta de la editorial', { exact: true }).isDisabled());
    assert.equal(await p.getByRole('button', { name: 'Corregir registro antes de finalizar', exact: true }).count(), 0);
    for (const role of ['teacher', 'secretary']) { const other = await open(role); assert.equal(await other.getByRole('region', { name: 'Pregunta obligatoria de la editorial' }).count(), 0); }
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/questions-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated server responses; no database changes', passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
