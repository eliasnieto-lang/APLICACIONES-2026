// Destructive acceptance checks on a disposable local DEMO dataset only.
// Never point this script at a school's live or remote installation.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { emptyState } from '../shared/defaults.ts';
import { newPresentationEvaluation } from '../shared/presentation.ts';

const base = process.env.TEXTOS_BROWSER_URL || 'http://127.0.0.1:39001';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw Error('Use a disposable local installation.');
const owner = readFileSync('local/demo-owner-code.txt', 'utf8').trim();
const password = readFileSync('local/director-test-password', 'utf8').trim();
const secrets = [owner, password];
const checks = [], errors = [], contexts = [], deleteRequests = [];
const checked = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
const at = '2026-11-04T17:00:00Z';

async function response(action, payload = {}, code = owner) {
  const res = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: 'demo' }) });
  return { status: res.status, body: await res.json() };
}
async function rpc(action, payload = {}, code = owner) {
  const res = await response(action, payload, code);
  if (res.status !== 200) throw Error(`${action}: ${res.body.error?.message ?? res.body.message ?? 'Request failed'}`);
  return res.body;
}
const state = async () => (await rpc('snapshot')).state;

const seeded = emptyState();
seeded.settings.eventAt = '2026-11-12T08:30:00-05:00';
seeded.settings.venue = 'Sede del ensayo local de eliminación';
seeded.settings.rules.presentationSeconds = 900;
seeded.settings.rules.lockedAt = at;
seeded.publishers = ['alfa', 'beta'].map(id => ({ id: `cleanup-${id}`, version: 1,
  name: `Editorial ${id.toUpperCase()} · ensayo`, samplesReceived: true, sampleNote: '' }));
seeded.teachers = ['Ana', 'Beatriz'].map((name, index) => ({ id: `cleanup-teacher-${index}`, version: 1,
  name: `Ensayo ${name}`, firstNames: name, lastNames: 'Ensayo', area: 'MAT', categories: ['P1'],
  attended: true, attendanceEvidence: 'Ensayo local', selfRegistered: true }));
seeded.presentationQuestions = seeded.publishers.map(publisher => ({ id: `cleanup-question-${publisher.id}`,
  version: 1, publisherId: publisher.id, representativeName: 'Representante del ensayo', area: 'MAT',
  question: '¿Cómo acompaña la propuesta los distintos ritmos de aprendizaje?',
  answer: 'Incluye actividades de refuerzo y profundización con orientaciones para el docente.',
  status: 'answered', askedAt: at, answeredAt: at, updatedAt: at }));
for (const [teacherIndex, teacher] of seeded.teachers.entries()) for (const [publisherIndex, publisher] of seeded.publishers.entries()) {
  seeded.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id,
    area: 'MAT', block: 'P1' }), id: `cleanup-evaluation-${teacherIndex}-${publisherIndex}`, version: 1,
    rubricVersion: 2, scaleMax: 4, responseScore: teacherIndex === 0 ? 3 : null, questionVersion: teacherIndex === 0 ? 1 : null,
    scores: teacherIndex === 0 ? Array(10).fill(3) : [0, ...Array(9).fill(null)],
    status: teacherIndex === 0 ? 'closed' : 'draft', closedAt: teacherIndex === 0 ? at : null, updatedAt: at });
}

mkdirSync('test-results', { recursive: true });
rmSync('test-results/cleanup-local-browser-results.json', { force: true });
await rpc('demo_reset', { state: seeded });
const teacherCodes = [];
for (const teacher of seeded.teachers) {
  const result = await rpc('access_create', { role: 'teacher', teacherId: teacher.id });
  teacherCodes.push(result.code); secrets.push(result.code);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox'] });
async function newPage(viewport = { width: 1360, height: 960 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    try { if (request.method() === 'POST' && request.postDataJSON()?.p_action === 'data_delete_apply') deleteRequests.push('apply'); }
    catch { /* Non-JSON requests are unrelated. */ }
  });
  return page;
}
async function openAccess(page, code = owner) {
  await page.goto(`${base}/?datos=demo#access=${encodeURIComponent(code)}`);
  await page.getByRole('button', { name: 'Actualizar información', exact: true }).waitFor();
  assert(!page.url().includes(code));
}
async function rpcUi(page, action, click, expectedStatus = 200) {
  const pending = page.waitForResponse(res => {
    try { return res.request().method() === 'POST' && res.request().postDataJSON()?.p_action === action; }
    catch { return false; }
  });
  void pending.catch(() => undefined);
  await click(); const res = await pending; const body = await res.json();
  assert.equal(res.status(), expectedStatus, `Unexpected status for ${action}`); return body;
}
const director = await newPage();
const main = () => director.locator('main').last();
const summary = () => main().getByRole('region', { name: 'Resumen de eliminación', exact: true });
const finalButton = all => main().getByRole('button', { name: all ? 'Eliminar toda la información' : 'Eliminar información seleccionada', exact: true });
const confirmBox = () => main().getByRole('checkbox', { name: 'Confirmo que deseo eliminar la información indicada.', exact: true });
const preview = () => rpcUi(director, 'data_delete_preview', () => main().getByRole('button', { name: 'Revisar qué se eliminará', exact: true }).click());
async function scope(value) { await main().getByLabel('Información que deseas eliminar', { exact: true }).selectOption(value); }
async function choose(label) { const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); await main().getByRole('checkbox', { name: new RegExp(`^Seleccionar ${escaped}(?:$| ·)`) }).check(); }

try {
  await checked('opening the Subdirector cleanup page and its preview never deletes or changes a record', async () => {
    const before = await state(); const n = deleteRequests.length;
    await openAccess(director);
    await director.getByRole('button', { name: 'Eliminar información', exact: true }).click();
    await main().getByRole('heading', { name: 'Eliminar información', exact: true }).waitFor();
    assert.equal(deleteRequests.length, n); assert.deepEqual(await state(), before);
    await scope('teacher'); await choose(seeded.teachers[0].name);
    const plan = await preview(); assert.equal(plan.scope, 'teacher'); assert.deepEqual(plan.ids, [seeded.teachers[0].id]);
    assert.equal(plan.stateVersion, before.version); assert(plan.counts.presentationEvaluations >= 2);
    await summary().waitFor(); assert((await summary().innerText()).includes(seeded.teachers[0].name));
    assert.deepEqual(await state(), before); assert.equal(deleteRequests.length, n);
    await director.screenshot({ path: 'test-results/cleanup-real-preview.png', fullPage: true });
    await main().getByRole('button', { name: 'Cancelar eliminación', exact: true }).click();
    assert.equal(await summary().count(), 0); assert.deepEqual(await state(), before);
  });
  await checked('confirming one teacher removes their closed evaluations and access while preserving the other teacher and Subdirector session', async () => {
    await preview(); assert(await finalButton(false).isDisabled()); await confirmBox().check();
    const deleted = await rpcUi(director, 'data_delete_apply', () => finalButton(false).click()); assert.equal(deleted.deleted, true);
    const current = await state(); assert.equal(current.teachers.length, 1); assert.equal(current.teachers[0].id, seeded.teachers[1].id);
    assert.equal(current.publishers.length, 2); assert.equal(current.presentationEvaluations.length, 2);
    assert(current.presentationEvaluations.every(item => item.teacherId === seeded.teachers[1].id));
    assert.equal((await response('snapshot', {}, teacherCodes[0])).status, 401);
    assert.equal((await response('snapshot', {}, teacherCodes[1])).status, 200);
    const self = await rpc('snapshot'); assert.equal(self.actor.role, 'coordinator');
    await main().getByRole('heading', { name: 'Eliminar información', exact: true }).waitFor();
    assert.equal(current.presentationQuestions.length, 2);
  });
  await checked('deleting an editorial cascades its ficha and shared question without removing unrelated records', async () => {
    await scope('publisher'); await choose(seeded.publishers[0].name);
    const plan = await preview(); assert.equal(plan.counts.publishers, 1); assert.equal(plan.counts.presentationEvaluations, 1);
    assert.equal(plan.counts.presentationQuestions, 1);
    await confirmBox().check(); await rpcUi(director, 'data_delete_apply', () => finalButton(false).click());
    const current = await state(); assert.equal(current.publishers.length, 1); assert.equal(current.publishers[0].id, seeded.publishers[1].id);
    assert.equal(current.teachers.length, 1); assert.equal(current.presentationEvaluations.length, 1);
    assert(current.presentationEvaluations.every(item => item.publisherId === seeded.publishers[1].id));
    assert.equal(current.presentationQuestions.length, 1); assert.equal(current.presentationQuestions[0].publisherId, seeded.publishers[1].id);
    const old = seeded.presentationEvaluations.find(item => item.teacherId === seeded.teachers[1].id && item.publisherId === seeded.publishers[0].id);
    const staleWrite = await response('presentation_save', { publisherId: old.publisherId, area: 'MAT', block: 'P1',
      expectedVersion: old.version, scaleMax: 4, rubricVersion: 2, responseScore: 3, questionVersion: 1,
      scores: Array(10).fill(3) }, teacherCodes[1]);
    assert([400, 403, 404, 409].includes(staleWrite.status));
  });
  await checked('a stale deletion preview gets HTTP409 and cannot remove information added since the preview', async () => {
    const plan = await rpc('data_delete_preview', { scope: 'teacher', ids: [seeded.teachers[1].id] });
    await rpc('publisher_save', { publisher: { id: '', version: 0, name: 'Editorial incorporada después de revisar', samplesReceived: false, sampleNote: '' } });
    const before = await state();
    const result = await response('data_delete_apply', { scope: 'teacher', ids: plan.ids, expectedVersion: plan.stateVersion, confirmation: 'ELIMINAR' });
    assert.equal(result.status, 409); assert.deepEqual(await state(), before);
    await director.getByRole('button', { name: 'Actualizar información', exact: true }).click();
  });
  await checked('clearing the demo jornada requires typed confirmation and preserves event configuration and administrative access', async () => {
    const before = await state(); await scope('all'); const plan = await preview();
    assert.equal(plan.requiresFullConfirmation, true); assert.equal(plan.scope, 'all');
    assert(await finalButton(true).isDisabled()); await confirmBox().check(); assert(await finalButton(true).isDisabled());
    await main().getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR'); assert(await finalButton(true).isDisabled());
    await main().getByLabel('Escribe ELIMINAR TODO', { exact: true }).fill('ELIMINAR TODO');
    await rpcUi(director, 'data_delete_apply', () => finalButton(true).click());
    const after = await state();
    for (const key of ['publishers', 'series', 'offers', 'books', 'teachers', 'assignments', 'evaluations',
      'presentationEvaluations', 'presentationQuestions', 'presentationShortlists', 'sections', 'deliveries', 'rounds', 'shortlists', 'reviews', 'incidents']) {
      assert.equal((after[key] ?? []).length, 0, `${key} must be empty`);
    }
    assert.equal((after.paperPolls ?? []).length, 0); assert(!after.presentationDraw); assert(!after.presentationRanking);
    assert.equal(after.settings.school, before.settings.school); assert.equal(after.settings.eventAt, before.settings.eventAt);
    assert.equal(after.settings.venue, before.settings.venue); assert.equal(after.settings.rules.presentationSeconds, 900);
    assert.equal(after.settings.rules.lockedAt, null); assert(after.settings.version > before.settings.version); assert(after.version > before.version);
    assert.equal((await rpc('snapshot')).actor.role, 'coordinator');
    assert.equal((await response('snapshot', {}, teacherCodes[1])).status, 401);
    const login = await rpc('director_login', { password }); assert.equal(login.snapshot.actor.role, 'coordinator'); secrets.push(login.code);
    assert.equal(await director.getByRole('button', { name: 'Salir', exact: true }).count(), 1);
  });
  await checked('a fresh registration and editorial work after clearing and cleanup remains usable on a phone', async () => {
    const publisher = await rpc('publisher_save', { publisher: { id: '', version: 0, name: 'Editorial de la nueva jornada', samplesReceived: false, sampleNote: '' } });
    assert(publisher.id);
    const teacher = await rpc('teacher_register', { firstNames: 'Ana', lastNames: 'Ensayo', area: 'MAT', categories: ['P1'] }, null);
    assert.equal(teacher.snapshot.actor.role, 'teacher'); assert.notEqual(teacher.snapshot.actor.id, seeded.teachers[0].id); secrets.push(teacher.code);
    assert.equal(teacher.snapshot.state.publishers.length, 1); assert.equal(teacher.snapshot.state.presentationEvaluations.length, 0);
    await director.getByRole('button', { name: 'Actualizar información', exact: true }).click();
    await director.setViewportSize({ width: 390, height: 844 });
    await director.waitForFunction(() => !document.querySelector('.sidebar')?.classList.contains('open'));
    await director.waitForFunction(() => document.querySelector('.sidebar')?.getBoundingClientRect().right <= 1);
    assert(await director.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const closeToast = director.getByRole('button', { name: 'Cerrar aviso', exact: true }); if (await closeToast.count()) await closeToast.click();
    await director.screenshot({ path: 'test-results/cleanup-local-mobile.png', fullPage: true });
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/cleanup-local-browser-results.json', JSON.stringify({ at: new Date().toISOString(),
    backend: 'Node/Express + PostgreSQL + PostgREST reales; mutations restricted to demo', passed: checks.length,
    checks, pageErrors: errors }, null, 2));
} catch (error) {
  const message = secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, String(error?.stack || error));
  console.error(message); process.exitCode = 1;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); }
