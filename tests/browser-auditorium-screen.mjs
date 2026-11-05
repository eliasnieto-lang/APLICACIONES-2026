// Public projection fixture only. No database or official data is accessed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { emptyState } from '../shared/defaults.ts';
import { paperClassroomRoster } from '../shared/paper-vote.ts';
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }); await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
const state = emptyState();
state.publishers = Array.from({ length: 6 }, (_, index) => ({ id: `publisher-${index}`, version: 1, name: `Editorial finalista de muestra ${index + 1}`, samplesReceived: true, sampleNote: '' }));
state.teachers = [{ id: 'private-teacher', version: 1, name: 'DOCENTE PRIVADO NO PROYECTAR', attended: true, attendanceEvidence: 'EVIDENCIA NO PUBLICAR' }];
state.turn = { publisherId: state.publishers[0].id, status: 'running', startedAt: new Date(Date.now() - 30_000).toISOString(), pausedAt: null, pausedMilliseconds: 0 };
const display = { schemaVersion: 1, version: 1, mode: 'samples', rankingId: 'rank-final', rankingVersion: 1, visit: { status: 'running', durationSeconds: 600, remainingSeconds: 600, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 600_000).toISOString() }, categories: [
  { area: 'MAT', block: 'P1', publishers: state.publishers.slice(0, 3).map(({ id, name }, index) => ({ id, name, score: 90 - index * 5 })) },
  { area: 'COM', block: 'P1', publishers: state.publishers.slice(3).map(({ id, name }, index) => ({ id, name, score: index ? 85 : 0 })) },
] };
state.settings.auditoriumDisplay = display;
const options = state.publishers.slice(0, 3).map(({ id, name }) => ({ id, name }));
const classrooms = paperClassroomRoster('P1'); classrooms[0] = { ...classrooms[0], attendance: 'present', ballotIssued: true, received: true, choices: { MAT: options[0].id, COM: options[1].id }, voteVersion: 1 };
state.paperPolls = [{ id: 'classroom-poll', version: 2, block: 'P1', areas: ['MAT', 'COM'], options: { MAT: options, COM: options }, status: 'open', rankingId: 'rank-final', rankingVersion: 1, createdAt: new Date().toISOString(), closedAt: null, generated: 1, received: 1, counts: {}, results: {}, rosterVersion: 1, classrooms }];
let reads = 0; const pageErrors = [], checks = [];
const check = async (name, run) => { await run(); checks.push(name); console.log(`✓ ${name}`); };
await context.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: "import '/tests/auditorium-public-fixture.tsx';" }));
await context.route('**/api/auditorium-public-fixture', route => { reads++; return route.fulfill({ json: { actor: { id: 'public', name: 'Público', role: 'public' }, dataset: 'demo', state, serverNow: new Date().toISOString() } }); });
const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message));
const refresh = async () => { const request = page.waitForResponse(response => response.url().endsWith('/api/auditorium-public-fixture')); await page.getByRole('button', { name: 'Actualizar', exact: true }).click(); await request; };
const remaining = async () => (await page.getByRole('timer', { name: 'Tiempo restante para visitar las mesas', exact: true }).innerText()).split(':').map(Number).reduce((minutes, seconds) => minutes * 60 + seconds);
try {
  await page.goto(base);
  await check('public sample screen lists exactly three finalists per area and keeps the family ledger accessible', async () => {
    await page.getByRole('heading', { name: 'Visita a las mesas de muestra', exact: true }).waitFor();
    const screen = page.getByRole('region', { name: 'Visita a mesas de muestra', exact: true });
    assert.equal(await screen.locator('.auditorium-finalist-category').count(), 2); assert.equal(await screen.locator('.auditorium-finalist-category li').count(), 6);
    assert.equal(await page.getByRole('timer').count(), 1); assert.equal(await page.getByRole('heading', { name: 'Guion de la exposición', exact: true }).count(), 0);
    assert(await page.getByRole('table', { name: 'Votos registrados por aula', exact: true }).count() === 1);
    assert(!(await page.locator('body').innerText()).includes('DOCENTE PRIVADO NO PROYECTAR')); assert(!(await page.locator('body').innerText()).includes('EVIDENCIA NO PUBLICAR'));
  });
  await check('the shared deadline continues after a reload instead of restarting the ten-minute visit', async () => {
    const before = await remaining(); assert(before <= 600 && before > 580); await page.waitForTimeout(1200);
    await page.reload(); await page.getByRole('timer', { name: 'Tiempo restante para visitar las mesas', exact: true }).waitFor(); const after = await remaining();
    assert(after < before && after <= 599); assert(reads >= 2);
  });
  await check('paused and concluded visits keep the same finalists and show the next family-voting step', async () => {
    display.visit.status = 'paused'; display.visit.remainingSeconds = 135; display.visit.endsAt = null; await refresh();
    await page.getByText('Visita pausada', { exact: true }).waitFor(); assert.equal(await remaining(), 135); await page.waitForTimeout(1100); assert.equal(await remaining(), 135);
    display.visit.status = 'finished'; display.visit.remainingSeconds = 0; await refresh(); await page.getByText('Tiempo de visita concluido.', { exact: true }).waitFor();
    assert.equal(await remaining(), 0); assert.equal(await page.locator('.auditorium-finalist-category li').count(), 6); assert(await page.getByText(/Regresen al auditorio para la votación/).isVisible());
  });
  await check('instructions replace the live clock while the published vote ledger stays available', async () => {
    state.settings.auditoriumDisplay = { schemaVersion: 1, version: 2, mode: 'instructions', categories: [] }; await refresh();
    await page.getByRole('region', { name: 'Indicaciones para las editoriales', exact: true }).waitFor(); assert.equal(await page.getByRole('timer').count(), 0);
    assert(await page.getByText(/precio de venta al público/i).first().isVisible());
    assert.equal(await page.getByRole('table', { name: 'Votos registrados por aula', exact: true }).count(), 1);
    state.settings.auditoriumDisplay = null; await refresh(); await page.getByRole('heading', { name: 'Guion de la exposición', exact: true }).waitFor();
    assert.equal(await page.getByRole('timer').count(), 1);
  });
  await check('both projection modes fit a phone without hiding the vote table or exposing private forms', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); state.settings.auditoriumDisplay = display; await refresh();
    await page.getByRole('heading', { name: 'Visita a las mesas de muestra', exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/auditorium-samples-mobile.png', fullPage: true });
    state.settings.auditoriumDisplay = { schemaVersion: 1, version: 3, mode: 'instructions', categories: [] }; await refresh();
    await page.getByRole('region', { name: 'Indicaciones para las editoriales', exact: true }).waitFor(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await page.screenshot({ path: 'test-results/auditorium-instructions-mobile.png', fullPage: true });
  });
  assert.deepEqual(pageErrors, []);
  mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/auditorium-public-browser-results.json', JSON.stringify({ at: new Date().toISOString(), fixture: 'isolated public projection; no database or official data', passed: checks.length, checks, pageErrors }, null, 2));
  console.log(`${checks.length} recorridos de proyección pública aprobados.`);
} finally { await context.close(); await browser.close(); await vite.close(); }
