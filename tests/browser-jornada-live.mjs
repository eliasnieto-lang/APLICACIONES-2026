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
state.presentationQuestions = state.publishers.map(publisher => ({ id: `q-${publisher.id}`, publisherId: publisher.id, version: 1, representativeName: 'Portavoz de prueba', area: 'MAT', question: 'Pregunta del ensayo', answer: 'Respuesta del ensayo', status: 'answered', askedAt: at, answeredAt: at, updatedAt: at }));
let now = stamp; const calls = []; let failDraw = false;
async function page({ publicView = false, mobile = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 1000 } }); contexts.push(context);
  await context.addInitScript(() => {
    window.audioPulses = []; window.audioRecords = [];
    const parameter = () => ({ value: 0, events: [],
      setValueAtTime(value, time) { this.value = value; this.events.push({ kind: 'set', value, time }); return this; },
      linearRampToValueAtTime(value, time) { this.value = value; this.events.push({ kind: 'ramp', value, time }); return this; },
      cancelScheduledValues(time) { this.events.push({ kind: 'cancel', time }); return this; },
    });
    window.AudioContext = class {
      state = 'suspended'; currentTime = 0; destination = {};
      async resume() { this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
      createOscillator() {
        let envelope = null; let record = null;
        const node = { type: '', frequency: parameter(),
          connect(gain) { envelope = gain.gain.events; },
          disconnect() { if (record) record.disconnected = true; },
          start(time) { window.audioPulses.push(node.frequency.value); record = { type: node.type, frequency: node.frequency.events, envelope, start: time, stop: null, disconnected: false }; window.audioRecords.push(record); },
          stop(time) { if (record) record.stop = time; }, onended: null,
        }; return node;
      }
      createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
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
  await page.clock.install({ time: stamp }); await page.clock.pauseAt(stamp + 1000); await page.goto(base + (publicView ? '/?public=1' : '/')); await page.getByRole('heading', { name: publicView ? state.settings.title : 'Sala en vivo', exact: true }).waitFor();
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
  await check('starting beeps once, then plays louder swept sirens at five seconds and zero without duplicates', async () => {
    await p.getByRole('button', { name: 'Iniciar', exact: true }).click();
    await p.getByText('Sonido activado en este equipo', { exact: true }).waitFor(); await p.getByRole('timer').filter({ hasText: '00:08' }).waitFor();
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 1);
    now += 3000; await p.clock.runFor(3000); await p.getByText('Últimos 5 segundos de exposición.', { exact: true }).waitFor();
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 2);
    now += 5000; await p.clock.runFor(5000); assert.equal((await p.evaluate(() => window.audioPulses)).length, 3);
    now += 1000; await p.clock.runFor(1000); await p.getByRole('button', { name: 'Sincronizar', exact: true }).click(); assert.equal((await p.evaluate(() => window.audioPulses)).length, 3);
    assert(await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).isDisabled());
  });
  await check('finish/next respect the draw; an older tab cannot finish the following publisher', async () => {
    const stale = await page();
    const previousTurn = structuredClone(state.turn);
    await p.getByRole('button', { name: 'Finalizar', exact: true }).click(); await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).waitFor();
    assert((await p.getByRole('region', { name: 'Orden de participación' }).locator('li').first().innerText()).includes('Finalizada'));
    await p.getByRole('button', { name: 'Siguiente editorial', exact: true }).click();
    await p.getByRole('heading', { name: 'Editorial Uno', exact: true }).waitFor(); assert.equal(state.turn.publisherId, 'one');
    assert.equal((await p.evaluate(() => window.audioPulses)).length, 4);
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
  await check('siren preview uses the final alarm and muting disconnects it without replaying old thresholds', async () => {
    const preview = await page({ publicView: true });
    await preview.getByRole('button', { name: 'Activar sonido', exact: true }).click();
    let record = await preview.evaluate(() => window.audioRecords.at(-1));
    assert.equal(record.type, 'sawtooth');
    assert.equal(Math.max(...record.envelope.filter(item => item.value !== undefined).map(item => item.value)), .78);
    assert.equal(record.frequency.filter(item => item.kind === 'ramp').length, 12);
    assert.equal(record.stop - record.start, 4.22);
    await preview.getByRole('button', { name: 'Probar sirena', exact: true }).click();
    assert.equal((await preview.evaluate(() => window.audioPulses)).length, 2);
    assert.equal((await preview.evaluate(() => window.audioRecords))[0].disconnected, true);
    await preview.getByRole('button', { name: 'Silenciar avisos', exact: true }).click();
    record = await preview.evaluate(() => window.audioRecords.at(-1));
    assert.equal(record.disconnected, true); assert.equal(record.stop, 0);
    assert.equal(record.envelope.at(-1).value, 0);
  });
  await check('native offline Web Audio renders bounded, louder frequency sweeps and cancels active sirens', async () => {
    const rendered = await p.evaluate(async () => {
      const { playTimerSound } = await import('/src/timer-audio.ts');
      const sampleRate = 24000;
      const stats = (buffer, duration) => {
        const data = buffer.getChannelData(0); let energy = 0, peak = 0, last = -1;
        for (let index = 0; index < data.length; index++) { const value = data[index]; energy += value * value; peak = Math.max(peak, Math.abs(value)); if (Math.abs(value) > 1e-5) last = index / sampleRate; }
        const frequencies = [];
        for (let start = .08; start + .07 < duration - .1; start += .17) {
          let rises = 0; const from = Math.floor(start * sampleRate), end = Math.floor((start + .07) * sampleRate);
          for (let index = from + 1; index < end; index++) if (data[index - 1] <= 0 && data[index] > 0) rises++;
          frequencies.push(rises / .07);
        }
        return { rms: Math.sqrt(energy / data.length), peak, last, minFrequency: Math.min(...frequencies), maxFrequency: Math.max(...frequencies) };
      };
      const results = {};
      for (const [sound, duration] of [['five-seconds', 2.4], ['finish', 4.2]]) {
        const context = new OfflineAudioContext(1, Math.ceil((duration + .15) * sampleRate), sampleRate);
        playTimerSound(context, sound);
        results[sound] = stats(await context.startRendering(), duration);
      }
      const old = new OfflineAudioContext(1, Math.ceil(4.35 * sampleRate), sampleRate);
      const oscillator = old.createOscillator(); const gain = old.createGain();
      oscillator.frequency.value = 880; gain.gain.value = .18; oscillator.connect(gain); gain.connect(old.destination); oscillator.start(0); oscillator.stop(4.2);
      results.previous = stats(await old.startRendering(), 4.2);
      const canceled = new OfflineAudioContext(1, sampleRate * 5, sampleRate);
      const stop = playTimerSound(canceled, 'finish'); const suspended = canceled.suspend(.5); const complete = canceled.startRendering();
      await suspended; stop(); await canceled.resume();
      results.canceled = stats(await complete, .5);
      return results;
    });
    for (const [sound, duration] of [['five-seconds', 2.4], ['finish', 4.2]]) {
      assert(rendered[sound].rms > rendered.previous.rms * 2.3, JSON.stringify(rendered));
      assert(rendered[sound].peak < 1); assert(rendered[sound].peak > .5);
      assert(rendered[sound].last > duration - .03 && rendered[sound].last <= duration + .01);
      assert(rendered[sound].maxFrequency - rendered[sound].minFrequency > 400, JSON.stringify(rendered));
    }
    assert(rendered.canceled.last <= .51); assert(rendered.canceled.last >= .48);
    writeFileSync('test-results/siren-waveform-results.json', JSON.stringify(rendered, null, 2));
  });
  assert.deepEqual(errors, []); mkdirSync('test-results', { recursive: true }); await p.screenshot({ path: 'test-results/sorteo-sala-en-vivo.png', fullPage: true });
  writeFileSync('test-results/jornada-live-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated intercepted server and instrumented audio driver', checks, pageErrors: errors }, null, 2));
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
