// Full phone-flow regression on a disposable local installation. Mutations use demo only.
// Run: TEXTOS_BROWSER_URL=http://127.0.0.1:39001 node --import tsx tests/browser-teacher-mobile.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { emptyState } from '../shared/defaults.ts';

const base = process.env.TEXTOS_BROWSER_URL || 'http://127.0.0.1:39001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw Error('Use a disposable local installation.');
const owner = readFileSync('local/demo-owner-code.txt', 'utf8').trim();
const password = readFileSync('local/director-test-password', 'utf8').trim();
const secrets = [owner, password];
const checks = [], errors = [], contexts = [], measurements = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
const redact = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(value));
async function rpc(action, payload = {}, code = owner) {
  const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  const result = await response.json();
  if (!response.ok) throw Error(redact(`${action}: ${result.error?.message ?? result.message ?? response.status}`));
  return result;
}
async function until(predicate, message) {
  const end = Date.now() + 20000;
  while (!(await predicate())) { if (Date.now() >= end) throw Error(message); await new Promise(resolve => setTimeout(resolve, 100)); }
}
const state = emptyState();
state.publishers = [
  { id: 'phone-publisher-one', version: 1, name: 'EDITORIAL HORIZONTE PEDAGÓGICO Y APRENDIZAJE', samplesReceived: true, sampleNote: '' },
  { id: 'phone-publisher-two', version: 1, name: 'EDITORIAL NUEVA MIRADA', samplesReceived: true, sampleNote: '' },
  { id: 'phone-publisher-three', version: 1, name: 'EDITORIAL CAMINOS', samplesReceived: true, sampleNote: '' },
];
// A second teacher must never inflate the signed-in teacher's personal progress.
state.teachers = [{ id: 'phone-other-teacher', version: 1, name: 'Otra persona del ensayo', firstNames: 'Persona', lastNames: 'Otra', area: 'COM', categories: ['P1'], selfRegistered: true, attended: true, attendanceEvidence: '' }];
const config = await (await fetch(`${base}/config.json`)).json();
assert.equal(config.mode, 'local', 'This regression must use the local development API.');
await rpc('demo_reset', { state });
const draw = await rpc('presentation_draw', { expectedVersion: 0, confirmArrivals: true });
const beforeTurn = (await rpc('snapshot')).state.turn;
await rpc('turn_control', { command: 'start', publisherId: draw.publishers[0].id, expectedTurn: beforeTurn });

mkdirSync('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function pageFor(width, height = 844, mobile = true) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  contexts.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().includes('/api/rpc')) return;
    try { if (request.postDataJSON()?.p_dataset !== 'demo') errors.push('A test request targeted a non-demo dataset.'); } catch { errors.push('Malformed API request.'); }
  });
  return page;
}
async function overflow(page, label) {
  const actual = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert(actual.content <= actual.width, `${label}: horizontal page overflow ${actual.content}/${actual.width}`);
}
async function touchTarget(locator, label, minimum = 44) {
  const box = await locator.boundingBox(); assert(box, `${label}: target is hidden`);
  assert(box.width >= minimum - 0.5 && box.height >= minimum - 0.5, `${label}: touch target ${box.width}×${box.height}`);
}
async function inputTypeSize(page) {
  const sizes = await page.locator('input:not([type=checkbox]):not([type=radio]),select,textarea').evaluateAll(elements => elements.filter(element => element.getClientRects().length).map(element => ({ tag: element.tagName, size: parseFloat(getComputedStyle(element).fontSize) })));
  assert(sizes.length > 0);
  for (const item of sizes) assert(item.size >= 16, `${item.tag} text ${item.size}px can trigger mobile input zoom.`);
  return sizes;
}
async function landing(page) {
  await page.goto(`${base}/?datos=demo`);
  await page.getByRole('button', { name: 'INGRESAR COMO DOCENTE EVALUADOR', exact: true }).waitFor();
}
async function teacherNav(page, label) {
  // Teacher quick navigation is deliberately visible without opening a sidebar.
  const links = page.getByRole('button', { name: label, exact: true });
  for (const button of await links.all()) if (await button.isVisible()) { await touchTarget(button, label); return button; }
  throw Error(`${label} is not visible without opening a drawer.`);
}
const phonePages = [];
let teacher, teacherCode, activePublisher;
try {
  await check('320, 360, 390 and 430px: direct entry, readable fields, large choice targets and no horizontal overflow', async () => {
    for (const width of [320, 360, 390, 430]) {
      const page = await pageFor(width); phonePages.push(page);
      await landing(page); await overflow(page, `Landing ${width}`);
      await touchTarget(page.getByRole('button', { name: 'INGRESAR COMO DOCENTE EVALUADOR', exact: true }), `Teacher entry ${width}`);
      await touchTarget(page.getByRole('button', { name: 'INGRESAR COMO SUBDIRECTOR', exact: true }), `Director entry ${width}`);
      await page.getByRole('button', { name: 'INGRESAR COMO DOCENTE EVALUADOR', exact: true }).click();
      await page.getByLabel('Apellidos', { exact: true }).waitFor();
      assert.equal(await page.locator('input[type=password]').count(), 0);
      const fontSizes = await inputTypeSize(page);
      for (const choice of await page.locator('.entry-choice').all()) await touchTarget(choice, `Area/category ${width}`);
      await touchTarget(page.getByRole('button', { name: 'Comenzar mi evaluación', exact: true }), `Registration submit ${width}`);
      await overflow(page, `Registration ${width}`);
      measurements.push({ screen: 'teacher-registration', width, fontSizes });
      if (width === 390) { teacher = page; await page.screenshot({ path: 'test-results/docente-celular-390-registro.png', fullPage: true }); }
    }
  });
  await check('phone registration accepts a full name, one area and all three categories without a password', async () => {
    await teacher.getByLabel('Apellidos', { exact: true }).fill('Rodríguez de la Cruz Fernández');
    await teacher.getByLabel('Nombres', { exact: true }).fill('María de los Ángeles');
    await teacher.getByRole('radio', { name: 'Matemática', exact: true }).check();
    for (const box of await teacher.locator('.entry-block-options input[type=checkbox]').all()) await box.check();
    await teacher.getByRole('button', { name: 'Comenzar mi evaluación', exact: true }).click();
    await teacher.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
    const entry = await teacher.evaluate(() => JSON.parse(sessionStorage.getItem('textos-entry-session-v1:demo') || 'null'));
    teacherCode = entry.code; secrets.push(teacherCode);
    const snapshot = await rpc('snapshot', {}, teacherCode);
    assert.deepEqual(snapshot.state.teachers.find(item => item.id === snapshot.actor.id).categories.sort(), ['P1', 'P2', 'S1']);
    assert.equal(snapshot.state.teachers.length, 1, 'Teacher snapshots must exclude another teacher profile.');
    activePublisher = snapshot.state.turn.publisherId;
    assert.equal(snapshot.state.presentationQuestions?.length ?? 0, 0);
  });
  await check('all phone widths: visible personal navigation, readable editor, single-row 0–4 scores and large controls', async () => {
    for (const width of [320, 360, 390, 430]) {
      await teacher.setViewportSize({ width, height: 844 });
      await (await teacherNav(teacher, 'Mis evaluaciones')).click();
      await teacher.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
      await teacherNav(teacher, 'Mi jornada');
      await touchTarget(teacher.getByRole('button', { name: 'Actualizar información', exact: true }), `Refresh ${width}`);
      await touchTarget(teacher.getByRole('button', { name: 'Salir', exact: true }), `Exit ${width}`);
      const rows = [];
      for (const number of [1, 11]) {
        const buttons = teacher.getByRole('button', { name: new RegExp(`^I${number}: [0-4] puntos`) });
        assert.equal(await buttons.count(), 5);
        const boxes = await Promise.all((await buttons.all()).map(button => button.boundingBox()));
        assert(boxes.every(Boolean));
        assert(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) <= 1, `I${number} scores wrap at ${width}px`);
        for (const [index, button] of (await buttons.all()).entries()) await touchTarget(button, `I${number}/${index} ${width}`);
        rows.push({ criterion: number, targets: boxes.map(({ width, height }) => ({ width, height })) });
      }
      await touchTarget(teacher.getByRole('button', { name: 'Guardar ahora', exact: true }), `Save ${width}`);
      await touchTarget(teacher.getByRole('button', { name: 'Cerrar mi ficha', exact: true }), `Close ${width}`);
      await teacher.getByRole('button', { name: /^I1: 3 puntos/ }).evaluate(element => element.scrollIntoView({ block: 'center' }));
      const actions = await teacher.locator('.presentation-save-panel').boundingBox();
      assert(actions && actions.y >= 0 && actions.y + actions.height <= 845, `Save/close controls must stay inside the phone viewport at ${width}px.`);
      assert.equal(await teacher.locator('.presentation-save-panel').evaluate(element => getComputedStyle(element).position), 'fixed');
      const fontSizes = await inputTypeSize(teacher);
      await overflow(teacher, `Teacher editor ${width}`);
      measurements.push({ screen: 'teacher-editor', width, rows, fontSizes });
    }
    await teacher.setViewportSize({ width: 390, height: 844 });
    await teacher.getByRole('button', { name: /^I1: 3 puntos/ }).scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: 'test-results/docente-celular-390-ficha.png' });
  });
  await check('pending jump focuses the next ungraded criterion below the phone header; disclosure and guide targets remain easy to tap', async () => {
    await teacher.getByRole('button', { name: /^I1: 3 puntos/ }).tap();
    await teacher.getByRole('button', { name: 'Ir al siguiente pendiente', exact: true }).tap();
    const nextHeading = teacher.locator('.presentation-criterion h3').nth(1);
    assert(await nextHeading.evaluate(element => document.activeElement === element));
    await until(async () => {
      const heading = await nextHeading.boundingBox();
      const navigation = await teacher.getByRole('navigation', { name: 'Navegación del docente', exact: true }).boundingBox();
      const actions = await teacher.locator('.presentation-save-panel').boundingBox();
      return heading && navigation && actions && heading.y >= navigation.y + navigation.height && heading.y + heading.height < actions.y;
    }, 'The next pending heading remained underneath a fixed navigation or action panel.');
    const tapTargets = teacher.locator('.presentation-notes>summary,.presentation-scale-help summary,aside summary,[aria-label="Referencia documental MINEDU"] summary,aside>div>a');
    for (const target of await tapTargets.all()) if (await target.isVisible()) await touchTarget(target, 'Optional detail or guide reference');
  });
  await check('small 320×568 and short 390×500 screens retain scoring and leave the last text field clear of the action panel', async () => {
    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 500 }]) {
      await teacher.setViewportSize(size);
      await overflow(teacher, `Short phone ${size.width}×${size.height}`);
      for (const button of await teacher.getByRole('button', { name: /^I11: [0-4] puntos/ }).all()) await touchTarget(button, `Short phone I11 ${size.width}`);
      await touchTarget(teacher.getByRole('button', { name: 'Guardar ahora', exact: true }), 'Short phone save');
      await touchTarget(teacher.getByRole('button', { name: 'Cerrar mi ficha', exact: true }), 'Short phone close');
      const lastField = teacher.getByLabel('Observación general (opcional)', { exact: true });
      await lastField.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const field = await lastField.boundingBox();
      const panel = await teacher.locator('.presentation-save-panel').boundingBox();
      const position = await teacher.locator('.presentation-save-panel').evaluate(element => getComputedStyle(element).position);
      assert(field && field.y >= 0 && field.y + field.height <= size.height, 'The final optional field cannot be brought into view.');
      if (size.height <= 500) assert.equal(position, 'static');
      else assert(panel && field.y + field.height <= panel.y, 'The final optional field is hidden beneath the fixed actions.');
      const save = teacher.getByRole('button', { name: 'Guardar ahora', exact: true });
      await save.evaluate(element => element.scrollIntoView({ block: 'center' }));
      for (const action of [save, teacher.getByRole('button', { name: 'Cerrar mi ficha', exact: true })]) {
        const box = await action.boundingBox();
        assert(box && box.y >= 0 && box.y + box.height <= size.height, 'A short screen hides a save/close action.');
      }
      measurements.push({ screen: 'short-phone', ...size, footerPosition: position, fieldHeight: field.height });
    }
    await teacher.setViewportSize({ width: 390, height: 844 });
  });
  await check('phone scoring saves explicit I11 zero, closes all eleven criteria and preserves the current editorial', async () => {
    for (let number = 1; number <= 10; number++) await teacher.getByRole('button', { name: new RegExp(`^I${number}: 3 puntos`) }).click();
    await teacher.getByRole('button', { name: /^I11: 0 puntos/ }).click();
    await teacher.getByRole('button', { name: 'Guardar ahora', exact: true }).click();
    await until(async () => {
      const evaluations = (await rpc('snapshot', {}, teacherCode)).state.presentationEvaluations;
      return evaluations.some(item => item.publisherId === activePublisher && item.block === 'P1' && item.responseScore === 0 && item.scores.every(value => value === 3));
    }, 'The phone scores were not confirmed by the real local backend.');
    await until(async () => teacher.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).isEnabled(), 'The complete phone sheet could not be closed.');
    await teacher.getByRole('button', { name: /^I11: 0 puntos/ }).scrollIntoViewIfNeeded();
    await teacher.screenshot({ path: 'test-results/docente-celular-390-acciones.png' });
    await teacher.getByRole('button', { name: 'Cerrar mi ficha', exact: true }).click();
    await teacher.getByText('El servidor confirmó el cierre de esta ficha.', { exact: false }).first().waitFor();
    const evaluation = (await rpc('snapshot', {}, teacherCode)).state.presentationEvaluations.find(item => item.publisherId === activePublisher && item.block === 'P1');
    assert.equal(evaluation.status, 'closed'); assert.equal(evaluation.responseScore, 0);
    assert.equal(evaluation.questionVersion, null); assert.equal(evaluation.rubricVersion, 2);
    assert.equal(evaluation.scores.reduce((a, b) => a + b, 0), 30);
    const summary = await rpc('presentation_summary', { area: 'MAT', block: 'P1' });
    const consolidated = summary.ranked.find(item => item.publisherId === activePublisher);
    assert(consolidated && Math.abs(consolidated.score - 100 * 30 / 44) < 1e-9, 'Closing the phone sheet must contribute its actual result to the consolidated score.');
  });
  await check('personal home reports only this teacher progress; another category remains ungraded', async () => {
    await (await teacherNav(teacher, 'Mi jornada')).click();
    await teacher.locator('.teacher-home').waitFor();
    const text = await teacher.locator('main').innerText();
    assert(!text.includes('Otra persona del ensayo')); assert(!text.includes('Docentes registrados')); assert(!text.includes('Ternas publicadas'));
    assert(text.includes('9'), 'Personal progress should include three publishers × three categories.');
    assert.equal(await teacher.getByRole('progressbar', { name: 'Avance de mis fichas', exact: true }).getAttribute('aria-valuenow'), '11');
    await overflow(teacher, 'Personal teacher home');
    await teacher.screenshot({ path: 'test-results/docente-celular-390-jornada.png', fullPage: true });
    await (await teacherNav(teacher, 'Mis evaluaciones')).click();
    const categoryButtons = teacher.locator('[aria-label="Área y bloque de evaluación"] button');
    if (await categoryButtons.count() && await categoryButtons.first().isVisible()) await categoryButtons.nth(1).click();
    else await teacher.getByLabel(/Categoría.*evaluar|Categoría de evaluación/).selectOption('MAT-P2');
    await teacher.getByRole('button', { name: /^I1: 0 puntos/ }).waitFor();
    assert.equal(await teacher.getByRole('button', { name: /^I1: 0 puntos/ }).getAttribute('aria-pressed'), 'false');
  });
  await check('phone session survives refresh without asking for a password; landscape remains usable', async () => {
    await teacher.reload(); await teacher.getByRole('heading', { name: 'Evaluar exposición', exact: true }).waitFor();
    assert.equal(await teacher.locator('input[type=password]').count(), 0);
    // A reload opens the first category. Reopen the separate, unfinished P2 sheet for the landscape interaction.
    await teacher.getByLabel('Categoría de evaluación', { exact: true }).selectOption('MAT-P2');
    await teacher.setViewportSize({ width: 844, height: 390 });
    await overflow(teacher, 'Landscape teacher editor');
    assert.equal(await teacher.locator('.teacher-shell .sidebar').isVisible(), false, 'A rotated phone must keep the teacher layout rather than opening the desktop sidebar.');
    await teacherNav(teacher, 'Mi jornada');
    await teacherNav(teacher, 'Mis evaluaciones');
    assert.equal(await teacher.locator('.presentation-save-panel').evaluate(element => getComputedStyle(element).position), 'static', 'A short landscape viewport must leave room for the form rather than covering it with a fixed footer.');
    await teacher.getByRole('button', { name: /^I1: 4 puntos/ }).scrollIntoViewIfNeeded();
    const score = teacher.getByRole('button', { name: /^I1: 4 puntos/ });
    await score.click(); assert.equal(await score.getAttribute('aria-pressed'), 'true');
    await teacher.setViewportSize({ width: 390, height: 844 });
  });
  await check('1440px Subdirector retains the desktop sidebar and access to live projection controls', async () => {
    const director = await pageFor(1440, 960, false);
    await landing(director); await director.getByRole('button', { name: 'INGRESAR COMO SUBDIRECTOR', exact: true }).click();
    await director.getByLabel('Contraseña del subdirector', { exact: true }).fill(password);
    await director.getByRole('button', { name: 'Ingresar a la jornada', exact: true }).click();
    await director.getByRole('button', { name: 'Sala en vivo', exact: true }).first().waitFor();
    const sidebar = await director.locator('.sidebar').boundingBox(); assert(sidebar && sidebar.x === 0 && sidebar.width >= 200);
    assert.equal(await director.locator('.teacher-home').count(), 0);
    await director.getByRole('button', { name: 'Sala en vivo', exact: true }).first().click();
    await director.getByRole('button', { name: 'Activar sonido', exact: true }).click();
    await director.getByRole('button', { name: 'Probar sirena', exact: true }).waitFor();
    await director.locator('details[aria-label="Indicaciones generales de la jornada"]>summary').waitFor();
    await overflow(director, 'Desktop Subdirector live room');
    await director.screenshot({ path: 'test-results/subdireccion-escritorio-1440.png' });
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/teacher-mobile-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'Local Node/Express + PostgreSQL + PostgREST', browser: 'Chromium mobile emulation, touch enabled', passed: checks.length, checks, measurements, pageErrors: errors }, null, 2));
} catch (error) { console.error(redact(error?.stack || error)); process.exitCode = 1; }
finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
