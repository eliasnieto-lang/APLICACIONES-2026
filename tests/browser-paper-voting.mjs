// Isolated UI acceptance: manual classroom voting; never touches an installed dataset.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PDFDocument } from 'pdf-lib';
import { emptyState } from '../shared/defaults.ts';
import { paperClassroomRoster } from '../shared/paper-vote.ts';

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const base = 'http://127.0.0.1:' + vite.httpServer.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const checks = [], pageErrors = [], contexts = [];
const document = await PDFDocument.create(); document.addPage([419.527, 595.276]); const pdfBytes = [...await document.save()];
const at = '2026-11-05T01:00:00.000Z';
async function check(name, operation) { await operation(); checks.push(name); console.log('✓ ' + name); }
function makeState(provisional = false) {
  const state = emptyState();
  state.publishers = ['Alfa', 'Beta', 'Gamma'].map((name, index) => ({ id: 'p' + (index + 1), name: 'Editorial ' + name, version: 1, samplesReceived: true, sampleNote: '' }));
  state.presentationRanking = { id: 'rank-paper', version: 1, drawId: 'draw-paper', createdAt: at, provisional,
    categories: ['P1', 'P2', 'S1'].flatMap(block => ['MAT', 'COM'].map(area => ({ area, block, categoryId: area + '-' + block, state: 'ready', registered: 5, closed: 15, pending: 0,
      ranked: state.publishers.map((publisher, index) => ({ publisherId: publisher.id, area, block, registered: 5, closed: 5, pending: 0, drafts: 0, score: 90 - index * 5, i2: 4, state: 'eligible' })), finalists: ['p1', 'p2', 'p3'], tied: [], reasons: [] }))) };
  state.paperPolls = [];
  return state;
}
function newPoll(state, block, id, legacy = false) {
  return { id, version: 1, block, areas: ['MAT', 'COM'],
    options: Object.fromEntries(['MAT', 'COM'].map(area => [area, state.publishers.map(({ id, name }) => ({ id, name }))])),
    counts: Object.fromEntries(['MAT', 'COM'].map(area => [area, { options: { p1: 0, p2: 0, p3: 0 }, blank: 0, invalid: 0 }])),
    status: 'open', rankingId: 'rank-paper', rankingVersion: 1, createdAt: at, closedAt: null, generated: 0, received: 0, results: {},
    ...(!legacy ? { rosterVersion: 1, classrooms: paperClassroomRoster(block) } : {}),
  };
}
async function fixture({ provisional = false, legacy = false, role = 'coordinator' } = {}) {
  const state = makeState(provisional), calls = [], faults = [];
  if (legacy) state.paperPolls.push(newPoll(state, 'P1', 'poll-legacy', true));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  const snapshot = () => ({ state, actor: { id: 'paper-director', name: 'Subdirector', role }, dataset: 'demo', serverNow: at });
  await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/paper-voting-fixture.tsx';" }));
  await context.route('**/src/paper-reports.ts*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export async function buildPaperVotingPdf(state,poll,codes,options){window.__paperLastPrint={pollId:poll.id,codes,ballots:options.ballots};return new Uint8Array(' + JSON.stringify(pdfBytes) + ');}' }));
  function tally(poll, choices, delta) {
    for (const area of poll.areas) {
      const value = choices[area]; assert(Object.hasOwn(choices, area));
      if (value === null) poll.counts[area].blank += delta;
      else if (value === '__invalid__') poll.counts[area].invalid += delta;
      else { assert(poll.options[area].some(item => item.id === value)); poll.counts[area].options[value] += delta; }
    }
  }
  await context.route('**/api/paper-fixture', async route => {
    const { action, payload } = route.request().postDataJSON(); calls.push({ action, payload });
    const fault = faults.find(item => item.action === action);
    if (fault) { faults.splice(faults.indexOf(fault), 1); return route.fulfill({ status: fault.status, json: { code: 'PT' + fault.status, message: fault.message } }); }
    if (action === 'snapshot') return route.fulfill({ json: snapshot() });
    if (action === 'paper_evidence_list') return route.fulfill({ json: [] });
    if (action === 'paper_poll_create') {
      assert.deepEqual(payload.areas, ['MAT', 'COM']); assert.equal(payload.rankingId, state.presentationRanking.id);
      assert.equal(payload.expectedRankingVersion, 1);
      const poll = newPoll(state, payload.block, 'poll-' + payload.block); state.paperPolls.push(poll); return route.fulfill({ json: poll });
    }
    const poll = state.paperPolls.find(item => item.id === payload.pollId); assert(poll);
    if (payload.expectedVersion !== poll.version) return route.fulfill({ status: 409, json: { message: 'La votación cambió en otra pantalla. Actualice antes de guardar.' } });
    if (action === 'paper_attendance_save') {
      const classroom = poll.classrooms.find(item => item.id === payload.classroomId); assert(classroom);
      if (classroom.received) return route.fulfill({ status: 423, json: { message: 'Esta aula ya tiene un voto registrado.' } });
      classroom.attendance = payload.attendance; poll.version++; return route.fulfill({ json: poll });
    }
    if (action === 'paper_ballots_generate') {
      assert.equal(payload.count, undefined);
      const classrooms = payload.classroomIds ? poll.classrooms.filter(item => payload.classroomIds.includes(item.id)) : poll.classrooms.filter(item => !item.ballotIssued && !item.received && item.attendance !== 'absent');
      assert(classrooms.length);
      for (const classroom of classrooms) {
        assert(!classroom.received && classroom.attendance !== 'absent');
        if (!classroom.ballotIssued) { classroom.ballotIssued = true; poll.generated++; }
      }
      const ballots = classrooms.map(item => ({ classroomId: item.id, classroomLabel: item.label, folio: item.folio }));
      poll.version++; return route.fulfill({ json: { poll, codes: ballots.map(item => item.folio), ballots } });
    }
    if (action === 'paper_manual_cast' || action === 'paper_manual_correct') {
      const classroom = poll.classrooms.find(item => item.id === payload.classroomId); assert(classroom);
      assert.equal(payload.code, undefined);
      if (classroom.attendance === 'absent') return route.fulfill({ status: 423, json: { message: 'El aula figura sin asistencia.' } });
      if (action === 'paper_manual_cast') {
        assert.equal(payload.confirmation, true);
        if (classroom.received) return route.fulfill({ status: 409, json: { message: 'Esta aula ya tiene un voto registrado.' } });
        if (!classroom.ballotIssued) { classroom.ballotIssued = true; poll.generated++; }
        classroom.received = true; classroom.attendance = 'present'; classroom.voteVersion = 1; classroom.recordedAt = at; poll.received++;
      } else {
        assert(classroom.received); assert.equal(payload.expectedVoteVersion, classroom.voteVersion); assert(payload.reason.trim().length >= 8);
        tally(poll, classroom.choices, -1); classroom.voteVersion++; classroom.correctedAt = at;
      }
      tally(poll, payload.choices, 1); classroom.choices = structuredClone(payload.choices); poll.version++;
      return route.fulfill({ json: { poll, accepted: true, ...(action.endsWith('correct') ? { corrected: true } : {}) } });
    }
    if (action === 'paper_poll_close') {
      poll.status = 'closed'; poll.version++; poll.closedAt = at;
      poll.results = Object.fromEntries(poll.areas.map(area => {
        const values = Object.entries(poll.counts[area].options), max = Math.max(...values.map(([, n]) => n));
        const tiedIds = values.filter(([, n]) => n === max).map(([id]) => id);
        return [area, { state: max === 0 ? 'no_valid_votes' : tiedIds.length === 1 ? 'winner' : 'tie', winnerId: max > 0 && tiedIds.length === 1 ? tiedIds[0] : null, tiedIds }];
      }));
      return route.fulfill({ json: poll });
    }
    throw Error('Unexpected action ' + action);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: role === 'coordinator' ? 'Votación en papel' : 'Votación familiar en papel', exact: true }).waitFor();
  return { page, context, state, calls, fault: (action, status, message) => faults.push({ action, status, message }) };
}
async function create(f, block = 'P1') {
  const details = f.page.locator('details').first();
  if (!await details.getAttribute('open').then(value => value !== null)) await details.locator('summary').click();
  await f.page.getByLabel('Categoría de la votación', { exact: true }).selectOption(block);
  await f.page.getByLabel(/Confirmo que las familias pudieron revisar/).check();
  await f.page.getByRole('button', { name: 'Crear votación en papel', exact: true }).click();
  await f.page.waitForFunction(value => document.querySelector('select[aria-label="Votación"]')?.value === 'poll-' + value, block);
  await f.page.getByRole('region', { name: 'Padrón de aulas', exact: true }).waitFor();
}
const row = (page, label) => page.getByRole('region', { name: 'Padrón de aulas', exact: true }).getByRole('article', { name: label, exact: true });
async function manual(page, classroomId, choices) {
  await page.getByRole('button', { name: 'Transcribir voto manualmente', exact: true }).click();
  const form = page.getByRole('form', { name: 'Transcripción manual del voto', exact: true });
  await form.getByLabel('Aula del voto manual', { exact: true }).selectOption(classroomId);
  await fillChoices(form, choices);
  return form;
}
async function fillChoices(form, choices) {
  await form.getByLabel('Matemática · voto manual', { exact: true }).selectOption(choices.MAT ?? '__blank__');
  await form.getByLabel('Comunicación · voto manual', { exact: true }).selectOption(choices.COM ?? '__blank__');
  await form.getByLabel('Comparé los votos con la ficha de papel original.', { exact: true }).check();
}
async function submit(form, correction = false) {
  await form.getByRole('button', { name: correction ? 'Guardar corrección' : 'Guardar voto manual', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
}

try {
  await check('provisional ranking cannot open voting and the form has no scanner or long-code input', async () => {
    const f = await fixture({ provisional: true });
    assert(await f.page.getByRole('button', { name: 'Crear votación en papel', exact: true }).isDisabled());
    assert.equal(await f.page.locator('input[type=file]').count(), 0);
    assert.equal(await f.page.getByRole('button', { name: /Cargar fotos|Tomar foto/ }).count(), 0);
    assert(!(await f.page.locator('body').innerText()).includes('Código anónimo'));
    await f.context.close();
  });
  const f = await fixture(), p = f.page;
  await check('P1 creates ten named classrooms A–E, with short folios and both areas on one ballot', async () => {
    await create(f); const poll = f.state.paperPolls[0];
    assert.equal(poll.classrooms.length, 10); assert.deepEqual(poll.areas, ['MAT', 'COM']);
    assert.equal(await p.getByRole('region', { name: 'Padrón de aulas' }).getByRole('article').count(), 10);
    assert.equal(poll.classrooms[0].folio, 'P1-01'); assert.equal(poll.classrooms.at(-1).folio, 'P1-10');
    assert.equal(await p.getByLabel('Cantidad de fichas A5', { exact: true }).count(), 0);
    assert.equal(await p.getByRole('link', { name: 'Tabla pública para padres ↗', exact: true }).getAttribute('href'), '/?vista=publica&datos=demo#votacion-padres');
  });
  await check('manual transcription needs only classroom and two choices, without printing or uploading a photo', async () => {
    const form = await manual(p, 'PRI1-A', { MAT: 'p1', COM: 'p2' });
    assert.equal(await form.locator('input:not([type=checkbox])').count(), 0);
    await submit(form);
    const poll = f.state.paperPolls[0], classroom = poll.classrooms[0];
    assert.equal(poll.received, 1); assert.equal(poll.generated, 1); assert.equal(classroom.attendance, 'present');
    assert.deepEqual(classroom.choices, { MAT: 'p1', COM: 'p2' });
    assert.equal(await row(p, classroom.label).getByRole('button', { name: 'Revisar voto', exact: true }).count(), 1);
    assert(await row(p, classroom.label).getByLabel('Asistencia · ' + classroom.label, { exact: true }).isDisabled());
    assert.equal(f.calls.filter(call => call.action === 'paper_manual_cast').length, 1);
  });
  await check('Sin asistencia is saved and blocks voting and printing for that classroom', async () => {
    const classroom = f.state.paperPolls[0].classrooms.at(-1);
    const control = row(p, classroom.label).getByLabel('Asistencia · ' + classroom.label, { exact: true });
    const saved = p.waitForResponse(response => response.url().includes('/api/paper-fixture') && response.request().postDataJSON().action === 'paper_attendance_save');
    await control.selectOption('absent'); await saved; await p.waitForFunction(() => document.querySelector('select[aria-label="Asistencia · 2.º de primaria · E"]')?.value === 'absent');
    assert.equal(classroom.attendance, 'absent');
    assert(await row(p, classroom.label).getByRole('button', { name: 'Transcribir voto', exact: true }).isDisabled());
    assert(await row(p, classroom.label).getByRole('button', { name: 'Generar ficha A5', exact: true }).isDisabled());
    await p.getByLabel('Filtrar aulas', { exact: true }).selectOption('absent');
    assert.equal(await p.getByRole('region', { name: 'Padrón de aulas' }).getByRole('article').count(), 1);
    await p.getByLabel('Filtrar aulas', { exact: true }).selectOption('all');
  });
  await check('the PDF batch follows remaining classrooms and passes only classroom labels and short folios', async () => {
    await p.getByRole('button', { name: 'Generar fichas A5 del padrón', exact: true }).click();
    await p.getByRole('button', { name: 'Descargar PDF A5', exact: true }).waitFor();
    const last = await p.evaluate(() => window.__paperLastPrint);
    assert.equal(last.codes.length, 8); assert.equal(last.ballots.length, 8);
    assert(last.codes.every(code => /^P1-\d{2}$/.test(code)));
    assert(last.ballots.every(item => item.classroomLabel && item.folio && !item.code));
    assert.equal(f.state.paperPolls[0].generated, 9);
    const downloaded = p.waitForEvent('download'); await p.getByRole('button', { name: 'Descargar PDF A5', exact: true }).click();
    assert.equal((await downloaded).suggestedFilename(), 'fichas-A5-P1.pdf');
    assert.equal(await p.locator('iframe[title="Vista previa de las fichas A5"]').count(), 1);
  });
  await check('replacing one classroom ballot keeps its folio and does not create a second eligible vote', async () => {
    const classroom = f.state.paperPolls[0].classrooms[2];
    await row(p, classroom.label).getByRole('button', { name: 'Reponer ficha A5', exact: true }).click();
    await p.getByRole('heading', { name: '1 ficha A5 preparada', exact: true }).waitFor();
    assert.equal(f.state.paperPolls[0].generated, 9);
    assert.deepEqual((await p.evaluate(() => window.__paperLastPrint)).codes, [classroom.folio]);
  });
  await check('blank and invalid votes are explicit manual choices and an already received classroom cannot be recounted', async () => {
    const form = await manual(p, 'PRI1-B', { MAT: '__invalid__', COM: null }); await submit(form);
    const poll = f.state.paperPolls[0]; assert.equal(poll.received, 2); assert.equal(poll.counts.MAT.invalid, 1); assert.equal(poll.counts.COM.blank, 1);
    await p.getByRole('button', { name: 'Transcribir voto manualmente', exact: true }).click();
    const fresh = p.getByRole('form', { name: 'Transcripción manual del voto' });
    assert(await fresh.getByLabel('Aula del voto manual', { exact: true }).locator('option[value="PRI1-A"]').evaluate(option => option.disabled), JSON.stringify({ classroom:poll.classrooms[0], options:await fresh.getByLabel('Aula del voto manual', { exact: true }).locator('option').evaluateAll(options => options.map(option => ({v:option.value,d:option.disabled}))) }));
    assert(await fresh.getByLabel('Aula del voto manual', { exact: true }).locator('option[value="PRI2-E"]').evaluate(option => option.disabled));
    await fresh.getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(poll.received, 2);
  });
  await check('review shows the recorded vote and correction updates counts without adding a received ballot', async () => {
    const classroom = f.state.paperPolls[0].classrooms[1];
    await row(p, classroom.label).getByRole('button', { name: 'Revisar voto', exact: true }).click();
    const form = p.getByRole('form', { name: 'Transcripción manual del voto' });
    assert.equal(await form.getByLabel('Matemática · voto manual', { exact: true }).inputValue(), '__invalid__');
    assert.equal(await form.getByLabel('Comunicación · voto manual', { exact: true }).inputValue(), '__blank__');
    await fillChoices(form, { MAT: 'p3', COM: 'p1' });
    assert(await form.getByRole('button', { name: 'Guardar corrección', exact: true }).isDisabled());
    await form.getByLabel('Motivo de la corrección', { exact: true }).fill('Se corrigió la transcripción al cotejar el papel.');
    await submit(form, true);
    const poll = f.state.paperPolls[0]; assert.equal(poll.received, 2); assert.equal(poll.counts.MAT.invalid, 0); assert.equal(poll.counts.MAT.options.p3, 1); assert.equal(poll.counts.COM.blank, 0); assert.equal(classroom.voteVersion, 2);
  });
  await check('a rejected attendance change keeps the saved selection and a failed correction preserves entered work', async () => {
    const classroom = f.state.paperPolls[0].classrooms[2];
    f.fault('paper_attendance_save', 409, 'La votación cambió en otra pantalla. Actualice antes de guardar.');
    const control = row(p, classroom.label).getByLabel('Asistencia · ' + classroom.label, { exact: true });
    await control.selectOption('absent'); await p.getByRole('alert').filter({ hasText: 'La votación cambió' }).waitFor();
    assert.equal(await control.inputValue(), 'pending');
    await row(p, f.state.paperPolls[0].classrooms[0].label).getByRole('button', { name: 'Revisar voto', exact: true }).click();
    const form = p.getByRole('form', { name: 'Transcripción manual del voto' }); await fillChoices(form, { MAT: 'p2', COM: 'p3' });
    await form.getByLabel('Motivo de la corrección', { exact: true }).fill('Revisión pendiente de actualizar por otra pantalla.');
    const before = JSON.stringify(f.state.paperPolls[0].counts);
    f.fault('paper_manual_correct', 409, 'El voto fue corregido en otra pantalla. Actualice antes de continuar.');
    await form.getByRole('button', { name: 'Guardar corrección', exact: true }).click();
    await p.getByRole('alert').filter({ hasText: 'El voto fue corregido' }).waitFor();
    assert.equal(await form.getByLabel('Matemática · voto manual', { exact: true }).inputValue(), 'p2');
    assert.match(await form.getByLabel('Motivo de la corrección', { exact: true }).inputValue(), /Revisión pendiente/);
    assert.equal(JSON.stringify(f.state.paperPolls[0].counts), before);
    await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
  });
  await check('mobile ledger fits and closing leaves the votes visible with no further editing', async () => {
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await p.locator('[aria-label="Resultados de la votación"] .table-wrap').evaluateAll(items => items.every(item => item.scrollWidth <= item.clientWidth)));
    mkdirSync('test-results', { recursive: true }); await p.screenshot({ path: 'test-results/paper-voting-mobile.png', fullPage: true });
    await p.getByLabel('Confirmo que terminó la recepción y revisé el escrutinio.', { exact: true }).check();
    await p.getByRole('button', { name: 'Cerrar votación y calcular resultado', exact: true }).click();
    await p.getByText('Recepción cerrada', { exact: true }).waitFor();
    assert.equal(f.state.paperPolls[0].status, 'closed');
    const outcome = await p.locator('[aria-label="Resultados de la votación"]').innerText();
    assert.doesNotMatch(outcome, /[Mm]ayoría/);
    for (const area of f.state.paperPolls[0].areas) {
      const result = f.state.paperPolls[0].results[area];
      if (result?.state === 'winner') {
        const name = f.state.paperPolls[0].options[area].find(option => option.id === result.winnerId).name;
        assert(outcome.includes('Editorial elegida: ' + name));
      }
    }

    assert.equal(await p.getByRole('button', { name: 'Transcribir voto manualmente', exact: true }).count(), 0);
    assert.equal(await p.getByRole('button', { name: 'Revisar voto', exact: true }).count(), 0);
    assert((await row(p, f.state.paperPolls[0].classrooms[0].label).innerText()).includes('Editorial Alfa'));
  });
  await check('changing category creates twenty or fifteen classrooms and clears the previous manual form', async () => {
    const g = await fixture(); await create(g, 'P2'); assert.equal(g.state.paperPolls[0].classrooms.length, 20);
    await g.page.getByRole('button', { name: 'Transcribir voto manualmente', exact: true }).click();
    const form = g.page.getByRole('form', { name: 'Transcripción manual del voto' }); await form.getByLabel('Aula del voto manual', { exact: true }).selectOption('PRI3-A');
    await create(g, 'S1'); assert.equal(g.state.paperPolls[1].classrooms.length, 15);
    assert.equal(await g.page.getByRole('form', { name: 'Transcripción manual del voto' }).count(), 0);
    assert.equal(await g.page.getByRole('region', { name: 'Padrón de aulas' }).getByRole('article').count(), 15);
    await g.context.close();
  });
  await check('legacy polls remain readable and non-coordinators never see recording controls', async () => {
    const legacy = await fixture({ legacy: true }); await legacy.page.getByText(/Esta votación anterior conserva sus resultados/).waitFor();
    assert.equal(await legacy.page.getByRole('button', { name: 'Transcribir voto manualmente', exact: true }).count(), 0);
    assert.equal(await legacy.page.getByRole('button', { name: /Leer fotos|Tomar foto|Registrar automáticamente/ }).count(), 0); await legacy.context.close();
    const other = await fixture({ role: 'teacher' }); await other.page.getByText('El registro de la votación corresponde a Subdirección.', { exact: true }).waitFor();
    assert.equal(await other.page.getByRole('button', { name: 'Crear votación en papel', exact: true }).count(), 0);
    assert(other.calls.every(call => call.action === 'snapshot')); await other.context.close();
  });
  assert.deepEqual(pageErrors, []);
  writeFileSync('test-results/paper-voting-browser-results.json', JSON.stringify({ at: new Date().toISOString(), backend: 'isolated UI API; real SQL and PDF tested separately', passed: checks.length, checks, pageErrors }, null, 2));
} catch (error) {
  console.error(error); console.error('Page errors:', pageErrors);
  mkdirSync('test-results', { recursive: true });
  for (const context of contexts) for (const page of context.pages()) {
    try { console.error((await page.locator('body').innerText()).slice(-2600)); await page.screenshot({ path: 'test-results/paper-voting-failure.png', fullPage: true }); } catch {}
  }
  process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await vite.close(); }
