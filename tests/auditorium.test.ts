import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyState } from '../shared/defaults';
import { newPresentationEvaluation, presentationSummary } from '../shared/presentation';
import { buildAuditoriumCategories, readAuditoriumDisplay, visitRemaining, type AuditoriumDisplay } from '../shared/auditorium';
import AuditoriumControls from '../src/components/AuditoriumControls';
import type { Api, Role, Snapshot, State, PresentationScore } from '../shared/types';

function readyState(): State {
  const state = emptyState();
  state.publishers = Array.from({ length: 4 }, (_, index) => ({ id: `auditorium-p${index}`, version: 1, name: `Editorial ${index + 1}`, contact: 'CONTACTO_PRIVADO', samplesReceived: true, sampleNote: '' }));
  state.teachers = (['MAT', 'COM'] as const).map(area => ({ id: `teacher-${area}`, version: 1, name: 'DOCENTE_PRIVADO', area, categories: ['P1' as const], attended: true, attendanceEvidence: '' }));
  state.presentationEvaluations = state.teachers.flatMap(teacher => state.publishers.map((publisher, index) => ({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: teacher.area!, block: 'P1' }), id: `${teacher.id}-${publisher.id}`, version: 2, scores: Array(10).fill(4 - index), responseScore: (4 - index) as PresentationScore, notes: Array(10).fill('NOTA_PRIVADA'), status: 'closed' as const, closedAt: '2026-11-05T15:00:00Z', updatedAt: '2026-11-05T15:00:00Z' })));
  state.presentationDraw = { id: 'auditorium-draw', version: 1, publishers: state.publishers.map(({ id, name }) => ({ id, name })), completedPublisherIds: state.publishers.map(publisher => publisher.id), createdAt: '2026-11-05T14:00:00Z', createdBy: 'Subdirección' };
  state.presentationRanking = { id: 'auditorium-ranking', version: 1, drawId: state.presentationDraw.id, categories: presentationSummary(state), provisional: false, createdAt: '2026-11-05T15:01:00Z' };
  return state;
}
function sampleDisplay(state = readyState()): AuditoriumDisplay {
  return { schemaVersion: 1, version: 1, mode: 'samples', categories: buildAuditoriumCategories(state), rankingId: state.presentationRanking!.id, rankingVersion: 1,
    visit: { status: 'running', durationSeconds: 600, remainingSeconds: 600, startedAt: '2026-11-05T15:02:00Z', endsAt: '2026-11-05T15:12:00Z' } };
}

test('auditorium categories publish exactly three resolved finalists and no private form/profile fields', () => {
  const state = readyState(); const frozen = JSON.stringify(state);
  const groups = buildAuditoriumCategories(state);
  assert.equal(groups.length, 2); assert(groups.every(group => group.block === 'P1' && group.publishers.length === 3));
  assert.deepEqual(groups[0].publishers.map(publisher => [publisher.name, publisher.score]), [['Editorial 1', 100], ['Editorial 2', 75], ['Editorial 3', 50]]);
  assert.doesNotMatch(JSON.stringify(groups), /CONTACTO_PRIVADO|DOCENTE_PRIVADO|NOTA_PRIVADA|teacher-|scores|notes|registered/);
  assert.equal(JSON.stringify(state), frozen);
});

test('projection never invents finalists for incomplete, provisional, stale or unfinished rankings', () => {
  for (const modify of [(s: State) => { s.presentationRanking!.provisional = true; }, (s: State) => { s.presentationRanking!.stale = true; }, (s: State) => { s.presentationDraw!.completedPublisherIds.pop(); }, (s: State) => { delete s.presentationRanking; }]) {
    const state = readyState(); modify(state); assert.deepEqual(buildAuditoriumCategories(state), []);
  }
  const state = readyState(); state.presentationEvaluations[0].status = 'draft';
  assert.deepEqual(buildAuditoriumCategories(state).map(group => group.area), ['COM']);
});

test('database and browser decimal precision do not hide valid finalists, while changed scores are rejected', () => {
  const state = readyState();
  state.publishers.pop(); state.presentationDraw!.publishers.pop(); state.presentationDraw!.completedPublisherIds.pop();
  const mathematics = state.teachers.find(teacher => teacher.area === 'MAT')!;
  const evaluators = [0, 1, 2].map(index => ({ ...mathematics, id: `decimal-teacher-${index}` }));
  state.teachers = [...state.teachers.filter(teacher => teacher.area !== 'MAT'), ...evaluators];
  state.presentationEvaluations = state.presentationEvaluations.filter(form => form.area === 'COM' && form.publisherId !== 'auditorium-p3');
  for (const [index, teacher] of evaluators.entries()) for (const publisher of state.publishers) {
    const first = publisher.id === 'auditorium-p0' ? [0, 1, 3][index] : publisher.id === 'auditorium-p1' ? 1 : 0;
    state.presentationEvaluations.push({ ...newPresentationEvaluation({ publisherId: publisher.id, teacherId: teacher.id, area: 'MAT', block: 'P1' }), id: `${teacher.id}-${publisher.id}`, version: 2, scores: [first as PresentationScore, ...Array(9).fill(0)], responseScore: 0, status: 'closed', closedAt: '2026-11-05T15:00:00Z', updatedAt: '2026-11-05T15:00:00Z' });
  }
  state.presentationRanking!.categories = presentationSummary(state);
  const category = state.presentationRanking!.categories.find(item => item.area === 'MAT' && item.block === 'P1')!;
  const row = category.ranked.find(item => item.publisherId === 'auditorium-p0')!;
  assert.notEqual(row.score, 400 / 132);
  row.score = 400 / 132;
  assert.equal(buildAuditoriumCategories(state).find(item => item.area === 'MAT')?.publishers[0].score, 400 / 132);
  row.score += .01;
  assert.deepEqual(buildAuditoriumCategories(state).map(item => item.area), ['COM']);
});

test('a tie at the third place blocks that category and an explicit zero can still be a finalist', () => {
  const tied = readyState();
  tied.presentationEvaluations.filter(form => form.publisherId === 'auditorium-p3').forEach(form => { form.scores = Array(10).fill(2); form.responseScore = 2; });
  tied.presentationRanking!.categories = presentationSummary(tied);
  assert.deepEqual(buildAuditoriumCategories(tied), []);
  const zero = readyState(); zero.publishers.pop(); zero.presentationEvaluations = zero.presentationEvaluations.filter(form => form.publisherId !== 'auditorium-p3');
  zero.presentationEvaluations.filter(form => form.publisherId === 'auditorium-p2').forEach(form => { form.scores = Array(10).fill(0); form.responseScore = 0; });
  zero.presentationDraw!.publishers.pop(); zero.presentationDraw!.completedPublisherIds.pop(); zero.presentationRanking!.categories = presentationSummary(zero);
  assert.equal(buildAuditoriumCategories(zero)[0].publishers[2].score, 0);
});

test('stored display is parsed by a public allowlist while malformed and future metadata are ignored', () => {
  const value = sampleDisplay();
  Object.assign(value, { privateCode: 'SECRETO' }); Object.assign(value.categories[0], { teacherName: 'PRIVADO' }); Object.assign(value.categories[0].publishers[0], { notes: 'NOTAS' });
  const parsed = readAuditoriumDisplay(value); assert(parsed); assert.doesNotMatch(JSON.stringify(parsed), /SECRETO|PRIVADO|NOTAS|privateCode/);
  for (const malformed of [{ ...value, schemaVersion: 2 }, { ...value, rankingId: undefined }, { ...value, categories: [] }, { ...value, visit: { ...value.visit, durationSeconds: 0 } }, { ...value, visit: { ...value.visit, endsAt: 'invalid' } }]) assert.equal(readAuditoriumDisplay(malformed), null);
  assert.deepEqual(readAuditoriumDisplay({ schemaVersion: 1, version: 1, mode: 'instructions', categories: [], privateCode: 'NOT_PUBLIC' }), { schemaVersion: 1, version: 1, mode: 'instructions', categories: [] });
  assert.equal(readAuditoriumDisplay(null), null);
});

test('the visit countdown survives reloads, stops at zero and pauses independently of the exposition clock', () => {
  const value = sampleDisplay(); const start = Date.parse(value.visit!.startedAt);
  assert.equal(visitRemaining(value.visit, start), 600); assert.equal(visitRemaining(value.visit, start + 1000), 599);
  assert.equal(visitRemaining(structuredClone(value.visit), start + 123000), 477);
  assert.equal(visitRemaining(value.visit, start + 700000), 0);
  const paused = { ...value.visit!, status: 'paused' as const, remainingSeconds: 120, endsAt: null };
  assert.equal(visitRemaining(paused, start + 3600000), 120);
  assert.equal(visitRemaining({ ...paused, status: 'finished', remainingSeconds: 0 }, start), 0);
});

test('only coordination sees projection controls and instructions do not require any ranking', () => {
  const state = emptyState();
  const api: Api = { dataset: 'demo', draftSecret: () => 'fixture', async call<T>() { return undefined as T; } };
  function render(role: Role) { const snapshot: Snapshot = { state, actor: { id: 'actor', name: 'Actor', role }, dataset: 'demo', serverNow: new Date().toISOString() }; return renderToStaticMarkup(createElement(AuditoriumControls, { snapshot, api, refresh: async () => undefined, notify: () => undefined })); }
  assert.equal(render('teacher'), ''); assert.equal(render('secretary'), ''); assert.equal(render('public'), '');
  const html = render('coordinator'); assert.match(html, /Proyectar indicaciones/); assert.match(html, /value="10"/); assert.match(html, /Iniciar visita a mesas/); assert.match(html, /ranking final actualizado/);
});
