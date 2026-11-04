// UI and audio-driver regression checks against an isolated intercepted fixture.
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
const at = '2026-11-04T14:00:00.000Z'; const stamp = Date.parse(at);
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
const state = emptyState(); state.settings.rules.presentationSeconds = 8; state.settings.rules.transitionSeconds = 2;
state.publishers = [
  { id: 'one', version: 1, name: 'Editorial Uno', samplesReceived: false, sampleNote: '' },
  { id: 'two', version: 1, name: 'Editorial Dos', samplesReceived: false, sampleNote: '' },
  { id: 'three', version: 1, name: 'Editorial Tres', samplesReceived: false, sampleNote: '' },
];
let now = stamp; const calls = []; let failDraw = false;
async function page({ publicView = false, mobile = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } }); contexts.push(context);
  await context.addInitScript(() => {
    window.audioPulses = [];
    window.AudioContext = class {
      state = 'suspended'; currentTime = 0; destination = {};
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
      createOscillator() { const node = { type: '', frequency: { value: 0 }, connect() {}, disconnect() {}, start() { window.audioPulses.push(node.frequency.value); }, stop() {}, onended: null }; return node; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    };
  });
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/jornada-live-fixture.tsx';" }));
  await context.route('**/api/jornada-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    if (action === 'snapshot') return route.fulfill({ json: { state, actor: { id: publicView ? 'public' : 'director', name: 'Subdirector', role: publicView ? 'public' : 'coordinator' }, dataset: 'demo', serverNow: new Date(now).toISOString() } });
    if (action === 'presentation_draw') {
      assert.equal(payload.expectedVersion, state.presentationDraw?.version ?? 0); assert.equal(payload.confirmArrivals, true);
      if (failDraw) return route.fulfill({ status: 409, json: { message: 'El sorteo cambió. Actualice la información.' } });
      state.presentationDraw = { id: 'server-draw', version: (state.presentationDraw?.version ?? 0) + 1, publishers: [state.publishers[2], state.publishers[0], state.publishers[1]].map(({ id, name }) => ({ id, name })), completedPublisherIds: [], createdAt: at, createdBy: 'Subdirector' };
      state.turn = { publisherId: 'three', status: 'ready', startedAt: null, pausedAt: null, pausedMilliseconds: 0 }; return route.fulfill({ json: state.presentationDraw });
    }
    assert.equal(action, 'turn_control');
    assert.deepEqual(Object.keys(payload.expectedTurn).sort(), Object.keys(state.turn).sort());
    if (state.presentationDraw && !isDeepStrictEqual(payload.expectedTurn, state.turn)) return route.fulfill({ status: 409, json: { message: 'El turno cambió. Actualice la información antes de continuar.' } });
    if (payload.command === 'start' || payload.command === 'next') {
      assert.equal(payload.publisherId, state.presentationDraw.publishers.find(p => !state.presentationDraw.completedPublisherIds.includes(p.id)).id);
      state.turn = { publisherId: payload.publisherId, status: 'running', startedAt: new Date(now).toISOString(), pausedAt: null, pausedMilliseconds: 0 };
    } else if (payload.command === 'pause') state.turn = { ...state.turn, status: 'paused', pausedAt: new Date(now).toISOString() };
    else if (payload.command === 'resume') state.turn = { ...state.turn, status: 'running', pausedMilliseconds: state.turn.pausedMilliseconds + now - Date.parse(state.turn.pausedAt), pausedAt: null };
    else if (payload.command === 'finish') { state.presentationDraw.completedPublisherIds.push(state.turn.publisherId); state.presentationDraw.version++; state.turn = { ...state.turn, status: 'finished', pausedAt: new Date(now).toISOString() }; }
    return route.fulfill({ json: state.turn });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  await page.clock.install({ time: stamp }); await page.goto(base + (publicView ? '/?public=1' : '/')); await page.getByRole('heading', { name: publicView ? state.settings.title : 'Sala en vivo', exact: true }).waitFor();
  return page;
}
try {
  const p = await page();
  await check('draw requires arrivals confirmation and uses only the persisted server result', async () => {
    const button = p.getByRole('button', { name: 'Sortear orden de participación', exact: true }); assert(await button.isDisabled());
    await p.getByRole('checkbox', { name: 'Confirmo que ya registré todas las editoriales que llegaron.' }).check(); await button.click();
    const order = p.getByRole('region', { name: 'Orden de participación' }); await order.waitFor();
    assert.deepEqual(await order.locator('li>span:first-child').allTextContents(), ['1.Editorial Tres', '2.Editorial Uno', '3.Editorial Dos']);
    assert.equal(await p.getByLabel('Editorial del próximo turno').count(), 0);
    assert(calls.some(call => call.action === 'presentation_draw' && call.payload.expectedVersion === 0));
    assert((await p.locator('body').innerText()).includes('Próxima editorial del orden: Editorial Tres'));
  });
  await check('repeating a draw requires a reason; failed CAS keeps the previous visible order', async () => {
    const repeat = p.getByRole('button', { name: 'Repetir sorteo con motivo', exact: true }); assert(await repeat.isDisabled());
    await p.getByRole('checkbox', { name: 'Confirmo que ya registré todas las editoriales que llegaron.' }).check();
    await p.getByLabel('Motivo para repetir el sorteo').fill('Registro final revisado'); failDraw = true; await repeat.click();
    await p.getByRole('alert').filter({ hasText: 'El sorteo cambió.' }).waitFor(); failDraw = false;
    assert.deepEqual(await p.getByRole('region', { name: 'Orden de participación' }).locator('li>span:first-child').allTextContents(), ['1.Editorial Tres', '2.Editorial Uno', '3.Editorial Dos']);
  });
  await check('starting activates sound, beeps once, then warns at five seconds and alarms at zero', async () => {
    await p.getByRole('button', { name: 'Iniciar', exact: true }).click();
    await p.getByText('Sonido activado en este equipo', { exact: true }).waitFor(); await p.getByRole('timer').filter({ hasText: '00:08' }).waitFor();
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 1);
    now += 3000; await p.clock.runFor(3000); await p.getByText('Últimos 5 segundos de exposición.', { exact: true }).waitFor();
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 4);
    now += 5000; await p.clock.runFor(5000); assert.equal((await p.evaluate(() => window.audioPulses)).length, 6);
    now += 1000; await p.clock.runFor(1000); await p.getByRole('button', { name: 'Sincronizar', exact: true }).click(); assert.equal((await p.evaluate(() => window.audioPulses)).length, 6);
    assert(await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).isDisabled());
  });
  await check('finish/next respect the draw; an older tab cannot finish the following publisher', async () => {
    const stale = await page();
    const previousTurn = structuredClone(state.turn);
    await p.getByRole('button', { name: 'Finalizar', exact: true }).click(); await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).waitFor();
    assert((await p.getByRole('region', { name: 'Orden de participación' }).locator('li').first().innerText()).includes('Finalizada'));
    await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).click();
    await p.getByRole('heading', { name: 'Editorial Uno', exact: true }).waitFor(); assert.equal(state.turn.publisherId, 'one');
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 7);
    const currentTurn = structuredClone(state.turn);
    await stale.getByRole('button', { name: 'Finalizar', exact: true }).click();
    await stale.getByRole('alert').filter({ hasText: 'El turno cambió.' }).waitFor();
    assert.deepEqual(state.turn, currentTurn); assert.deepEqual(state.presentationDraw.completedPublisherIds, ['three']);
    assert.deepEqual(calls.findLast(call => call.action === 'turn_control').payload.expectedTurn, previousTurn);
  });
  await check('public projection shares the order, starts muted, and fits a phone', async () => {
    const projected = await page({ publicView: true, mobile: true });
    assert.deepEqual(await projected.getByRole('region', { name: 'Orden de participación' }).locator('li>span:first-child').allTextContents(), ['1.Editorial Tres', '2.Editorial Uno', '3.Editorial Dos']);
    assert.equal((await projected.evaluate(() => window.audioPulses)).length, 0);
    await projected.getByRole('button', { name: 'Activar sonido', exact: true }).click(); assert.equal((await projected.evaluate(() => window.audioPulses)).length, 1);
    assert(await projected.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    mkdirSync('test-results', { recursive: true }); await projected.screenshot({ path: 'test-results/sorteo-proyeccion-movil.png', fullPage: true });
  });
  assert.deepEqual(errors, []); mkdirSync('test-results', { recursive: true }); await p.screenshot({ path: 'test-results/sorteo-sala-en-vivo.png', fullPage: true });
  writeFileSync('test-results/jornada-live-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated intercepted server and instrumented audio driver', checks, pageErrors: errors }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
