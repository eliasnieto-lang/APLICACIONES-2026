// Isolated UI/CAS regression checks. No installation or production dataset is mutated.
// Run: node --import tsx tests/browser-presentation-scale.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation } from '../shared/presentation.ts';

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const address = vite.httpServer.address();
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [];
mkdirSync('test-results', { recursive: true });
const fresh = (patch = {}) => ({ ...newPresentationEvaluation({ publisherId: 'scale-publisher', teacherId: 'scale-teacher', area: 'MAT', block: 'P1' }), id: 'scale-evaluation', version: 1, ...patch });
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
const scoreButton = (page, criterion, score) => page.getByRole('button', { name: new RegExp(`^I${criterion}: ${score} puntos · `) });
const waitFor = async (predicate, message) => {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 40)); }
};

async function fixture(evaluations = [], options = {}) {
  const state = emptyState();
  state.publishers = [{ id: 'scale-publisher', version: 1, name: 'Editorial de prueba de escala', samplesReceived: true, sampleNote: '' }, { id: 'scale-publisher-2', version: 1, name: 'Otra editorial disponible', samplesReceived: false, sampleNote: '' }];
  state.teachers = [{ id: 'scale-teacher', version: 1, name: 'Docente de prueba', area: 'MAT', categories: ['P1', 'P2', 'S1'], attended: true, attendanceEvidence: '' }];
  state.presentationEvaluations = structuredClone(evaluations);
  const questions = state.publishers.map(publisher => ({ id: `question-${publisher.id}`, publisherId: publisher.id, version: 1, representativeName: 'Representante', area: 'COM', question: '¿Cómo apoya la propuesta el aprendizaje?', answer: 'Con ejemplos y retroalimentación de las respuestas.', status: 'answered', askedAt: new Date().toISOString(), answeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  state.presentationQuestions = options.answered === false ? [] : structuredClone(questions);
  const history = [], calls = [];
  let offline = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const snapshot = () => ({ state, actor: { id: 'scale-teacher', role: 'teacher', name: 'Docente de prueba' }, dataset: 'demo', serverNow: new Date().toISOString() });
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/presentation-scale-fixture.tsx';" }));
  await context.route('**/api/scale-fixture', async route => {
    const { action, payload } = route.request().postDataJSON();
    calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: snapshot() });
    if (offline) return route.abort('failed');
    const existing = state.presentationEvaluations.find(item => action === 'presentation_save' ? item.publisherId === payload.publisherId && item.area === payload.area && item.block === payload.block : item.id === payload.evaluationId);
    if ((action !== 'presentation_enable_question' && payload.scaleMax !== 4) || payload.rubricVersion !== 2 || payload.expectedVersion !== (existing?.version ?? 0)) return route.fulfill({ status: 409, json: { code: 'PT409', message: 'La ficha cambió en otra pestaña; conflicto de versión.' } });
    if (action === 'presentation_save') {
      assert.equal(payload.scores.length, 10); assert(payload.scores.every(value => value === null || Number.isInteger(value) && value >= 0 && value <= 4));
      assert(payload.responseScore === null || Number.isInteger(payload.responseScore) && payload.responseScore >= 0 && payload.responseScore <= 4);
      if (payload.responseScore === null) assert.equal(payload.questionVersion, null);
      else assert(state.presentationQuestions.some(question => question.publisherId === payload.publisherId && question.status === 'answered' && question.version === payload.questionVersion));
      const result = { ...(existing ?? fresh({ version: 0 })), ...payload, teacherId: 'scale-teacher', version: (existing?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      delete result.expectedVersion;
      state.presentationEvaluations = state.presentationEvaluations.filter(item => item.id !== result.id).concat(result);
      return route.fulfill({ json: result });
    }
    assert(existing);
    if (action === 'presentation_close') {
      assert(existing.scores.every(value => value !== null)); assert.equal(existing.scaleMax, 4); assert.equal(existing.rubricVersion, 2); assert.notEqual(existing.responseScore, null); assert(state.presentationQuestions.some(question => question.publisherId === existing.publisherId && question.status === 'answered' && question.version === existing.questionVersion));
      Object.assign(existing, { version: existing.version + 1, status: 'closed', closedAt: new Date().toISOString() });
      return route.fulfill({ json: existing });
    }
    if (action === 'presentation_restart_scale') {
      assert.notEqual(existing.scaleMax, 4); history.push(structuredClone(existing));
      Object.assign(existing, { version: existing.version + 1, scaleMax: 4, rubricVersion: 2, responseScore: null, questionVersion: null, scores: Array(10).fill(null), status: 'draft', closedAt: null });
      return route.fulfill({ json: existing });
    }
    if (action === 'presentation_enable_question') {
      assert.equal(existing.scaleMax, 4); assert.equal(existing.rubricVersion, undefined); history.push(structuredClone(existing));
      Object.assign(existing, { version: existing.version + 1, rubricVersion: 2, responseScore: null, questionVersion: null, status: 'draft', closedAt: null });
      return route.fulfill({ json: existing });
    }
    throw new Error(`Unexpected action: ${action}`);
  });
  async function page() {
    const result = await context.newPage(); result.setDefaultTimeout(15000); result.on('pageerror', error => errors.push(error.message));
    await result.goto(base); await result.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
    return result;
  }
  return { context, state, calls, history, page, setOffline(value) { offline = value; }, answerQuestion() { state.presentationQuestions = structuredClone(questions); } };
}

try {
  await check('mobile: one description, five labeled choices, no default; all editorial and category choices remain available', async () => {
    const f = await fixture();
    try {
      const p = await f.page();
      const groups = p.locator('.presentation-score-buttons[role=group]'); assert.equal(await groups.count(), 11);
      assert.equal(await p.locator('.presentation-score-buttons button').count(), 55);
      assert.equal(await p.locator('.presentation-score-buttons button[aria-pressed=true]').count(), 0);
      assert.equal(await p.getByRole('button', { name: 'Sin valorar', exact: true }).count(), 0);
      assert.equal(await p.locator('strong').filter({ hasText: /^[AB]\.$/ }).count(), 0);
      assert.equal(await p.getByRole('button', { name: /Matemática · / }).count(), 3);
      assert.equal(await p.getByRole('button', { name: /Otra editorial disponible/ }).count(), 1);
      assert(await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).isDisabled());
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const metrics = await p.locator('.presentation-score-buttons button').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, labelSize: Number.parseFloat(getComputedStyle(element.querySelector('span')).fontSize) })));
      assert(metrics.every(metric => metric.width >= 120 && metric.height >= 88 && metric.labelSize >= 15));
      await p.screenshot({ path: 'test-results/escala-docente-movil-390.png', fullPage: true });
    } finally { await f.context.close(); }
  });

  await check('0 is explicit, persists as zero, counts toward all eleven answers and closes at 0/100', async () => {
    const f = await fixture();
    try {
      const p = await f.page(); await scoreButton(p, 1, 0).click();
      await waitFor(() => f.state.presentationEvaluations[0]?.scores[0] === 0, '0 was not saved');
      assert.deepEqual(f.state.presentationEvaluations[0].scores, [0, ...Array(9).fill(null)]);
      assert(await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).isDisabled());
      await p.getByText('1/11 criterios valorados · Las observaciones son opcionales.', { exact: true }).waitFor();
      for (let i = 2; i <= 11; i++) await scoreButton(p, i, 0).click();
      await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).click();
      await p.getByText('El servidor confirmó el cierre de esta ficha.', { exact: false }).waitFor();
      assert.deepEqual(f.state.presentationEvaluations[0].scores, Array(10).fill(0)); assert.equal(f.state.presentationEvaluations[0].responseScore, 0); assert.equal(f.state.presentationEvaluations[0].questionVersion, 1);
      await p.getByText('Total: 0 / 44 · Mi nota: 0.00 / 100', { exact: true }).waitFor();
      assert(f.calls.filter(call => call.action !== 'snapshot').every(call => call.payload.scaleMax === 4));
    } finally { await f.context.close(); }
  });

  await check('eleven Destacado values close at 44 points and 100/100 with optional notes empty', async () => {
    const f = await fixture();
    try {
      const p = await f.page(); for (let i = 1; i <= 11; i++) await scoreButton(p, i, 4).click();
      await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).click();
      await p.getByText('El servidor confirmó el cierre de esta ficha.', { exact: false }).waitFor();
      await p.getByText('Total: 44 / 44 · Mi nota: 100.00 / 100', { exact: true }).waitFor();
      assert.equal(f.state.presentationEvaluations[0].status, 'closed'); assert.deepEqual(f.state.presentationEvaluations[0].notes, Array(10).fill(''));
    } finally { await f.context.close(); }
  });

  await check('offline draft recovers 0 and 4 in isolated encrypted v3 storage; old encrypted draft is preserved', async () => {
    const f = await fixture();
    try {
      const p = await f.page(); await p.evaluate(() => window.presentationScaleFixture.seedLegacyDraft());
      const oldKeys = await p.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
      f.setOffline(true); await scoreButton(p, 1, 0).click(); await scoreButton(p, 2, 4).click(); await scoreButton(p, 11, 4).click();
      await p.getByLabel('Observación general (opcional)', { exact: true }).fill('observación secreta del borrador actual');
      await p.getByText('Sin sincronizar; se reintentará al volver la conexión', { exact: true }).waitFor();
      const local = await p.evaluate(() => window.presentationScaleFixture.currentDraft()); assert.equal(local.scaleMax, 4); assert.equal(local.rubricVersion, 2); assert.equal(local.responseScore, 4); assert.equal(local.questionVersion, 1); assert.deepEqual(local.scores, [0, 4, ...Array(8).fill(null)]);
      const raw = await p.evaluate(() => JSON.stringify({ ...localStorage })); assert(!raw.includes('observación secreta')); assert(!raw.includes('respaldo de escala anterior'));
      for (const [key, value] of Object.entries(oldKeys)) assert.equal(await p.evaluate(key => localStorage.getItem(key), key), value);
      await p.reload(); await p.getByRole('button', { name: 'Recuperar borrador', exact: true }).waitFor();
      assert.equal(await p.locator('.presentation-score-buttons button[aria-pressed=true]').count(), 0);
      f.setOffline(false); await p.getByRole('button', { name: 'Recuperar borrador', exact: true }).click();
      await waitFor(() => f.state.presentationEvaluations[0]?.scores[1] === 4, 'Recovered draft did not synchronize');
      assert.deepEqual(f.state.presentationEvaluations[0].scores, [0, 4, ...Array(8).fill(null)]); assert.equal(f.state.presentationEvaluations[0].responseScore, 4);
      assert.deepEqual((await p.evaluate(() => window.presentationScaleFixture.legacyDraft())).scores, Array(10).fill(2));
    } finally { await f.context.close(); }
  });

  await check('legacy 0–2 values remain read only at their original total until explicit CAS restart archives them', async () => {
    const old = fresh({ scaleMax: 2, scores: [2, 2, 2, 2, 2, 2, 2, 0, 0, 0], status: 'closed', closedAt: '2026-11-01T12:00:00Z', notes: ['nota histórica', ...Array(9).fill('')] });
    delete old.rubricVersion; delete old.responseScore; delete old.questionVersion;
    const f = await fixture([old]);
    try {
      const p = await f.page(); await p.getByText('Ficha anterior · rúbrica histórica de 0 a 2 · solo lectura', { exact: true }).waitFor();
      await p.getByText('Esta ficha conserva sus puntajes originales: 14 / 20 puntos. Mi nota anterior: 70.00 / 100.', { exact: true }).waitFor();
      assert.equal(await p.locator('.presentation-score-buttons button').count(), 0); assert.equal(f.calls.filter(call => call.action !== 'snapshot').length, 0);
      assert.equal(await p.locator('strong').filter({ hasText: /^[AB]\.$/ }).count(), 20);
      await p.getByText('La exposición relaciona la propuesta con los aprendizajes del área y bloque.', { exact: false }).waitFor();
      await p.getByRole('button', { name: 'Evaluar con nueva escala', exact: true }).click();
      await scoreButton(p, 1, 4).waitFor(); assert.equal(await p.locator('.presentation-score-buttons button[aria-pressed=true]').count(), 0);
      assert.deepEqual(f.history, [old]); assert.deepEqual(f.state.presentationEvaluations[0].scores, Array(10).fill(null)); assert.equal(f.state.presentationEvaluations[0].scaleMax, 4); assert.equal(f.state.presentationEvaluations[0].rubricVersion, 2); assert.equal(f.state.presentationEvaluations[0].responseScore, null);
      assert.equal(await p.getByLabel('Observación del criterio (opcional)', { exact: true }).first().inputValue(), 'nota histórica');
      const restart = f.calls.find(call => call.action === 'presentation_restart_scale'); assert.deepEqual(restart.payload, { evaluationId: old.id, expectedVersion: 1, scaleMax: 4, rubricVersion: 2 });
    } finally { await f.context.close(); }
  });

  await check('a ten-criterion 0–4 history stays at 75/100 until its author explicitly adds I11 without discarding the ten ratings', async () => {
    const old = fresh({ scores: Array(10).fill(3), status: 'closed', closedAt: '2026-11-01T12:00:00Z', notes: ['observación conservada', ...Array(9).fill('')] });
    delete old.rubricVersion; delete old.responseScore; delete old.questionVersion;
    const f = await fixture([old]);
    try {
      const p = await f.page(); await p.getByText(/Su nota anterior: 75.00 \/100/).waitFor();
      assert.equal(f.calls.filter(call => call.action !== 'snapshot').length, 0); assert.equal(await p.locator('.presentation-score-buttons button').count(), 0);
      await p.getByRole('button', { name: 'Completar ficha con la pregunta', exact: true }).click();
      await scoreButton(p, 11, 0).waitFor(); assert.equal(await p.locator('.presentation-score-buttons button[aria-pressed=true]').count(), 10);
      assert.deepEqual(f.history, [old]); assert.deepEqual(f.state.presentationEvaluations[0].scores, Array(10).fill(3)); assert.equal(f.state.presentationEvaluations[0].responseScore, null);
      assert(await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).isDisabled());
      await scoreButton(p, 11, 0).click(); await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).click();
      await p.getByText('Total: 30 / 44 · Mi nota: 68.18 / 100', { exact: true }).waitFor();
      assert.deepEqual(f.state.presentationEvaluations[0].notes, old.notes); assert.equal(f.state.presentationEvaluations[0].responseScore, 0);
      const enable = f.calls.find(call => call.action === 'presentation_enable_question'); assert.deepEqual(enable.payload, { evaluationId: old.id, expectedVersion: 1, rubricVersion: 2 });
    } finally { await f.context.close(); }
  });

  await check('before the common question is answered only the first ten criteria can save and the sheet cannot close', async () => {
    const f = await fixture([], { answered: false });
    try {
      const p = await f.page(); assert(await scoreButton(p, 11, 4).isDisabled());
      for (let criterion = 1; criterion <= 10; criterion++) await scoreButton(p, criterion, 4).click();
      await waitFor(() => f.state.presentationEvaluations[0]?.scores.every(value => value === 4), 'Ten ratings were not saved');
      assert.equal(f.state.presentationEvaluations[0].responseScore, null); assert.equal(f.state.presentationEvaluations[0].questionVersion, null);
      assert(await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).isDisabled()); assert.equal(f.calls.filter(call => call.action === 'presentation_close').length, 0);
      f.answerQuestion(); await p.evaluate(() => window.presentationScaleFixture.refresh()); await scoreButton(p, 11, 0).click();
      await p.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).click(); await p.getByText('Total: 40 / 44 · Mi nota: 90.91 / 100', { exact: true }).waitFor();
      assert.equal(f.state.presentationEvaluations[0].responseScore, 0); assert.equal(f.state.presentationEvaluations[0].status, 'closed');
    } finally { await f.context.close(); }
  });

  await check('two tabs retain CAS protection; local changes never silently overwrite the newer version', async () => {
    const f = await fixture([fresh()]);
    try {
      const a = await f.page(), b = await f.page(); await scoreButton(a, 1, 3).click();
      await waitFor(() => f.state.presentationEvaluations[0].version === 2, 'First tab did not save');
      await scoreButton(b, 2, 0).click(); await b.getByText('La ficha cambió en el servidor. Sus valores locales se conservan.', { exact: true }).waitFor();
      assert.equal(f.state.presentationEvaluations[0].scores[1], null);
      await b.getByRole('button', { name: 'Consultar versión del servidor', exact: true }).click();
      await b.getByText(/Servidor: versión 2, escala de 0 a 4/).waitFor();
      await b.getByRole('button', { name: 'Recargar ficha del servidor', exact: true }).click();
      await b.getByText('Ficha recargada desde el servidor', { exact: true }).waitFor();
      assert.equal(await scoreButton(b, 1, 3).getAttribute('aria-pressed'), 'true'); assert.equal(await scoreButton(b, 2, 0).getAttribute('aria-pressed'), 'false');
      assert.equal(f.state.presentationEvaluations[0].version, 2);
    } finally { await f.context.close(); }
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/presentation-scale-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'isolated browser UI fixture with CAS and encrypted browser drafts', passed: checks.length, checks, pageErrors: errors }, null, 2));
} finally { await browser.close(); await vite.close(); }
