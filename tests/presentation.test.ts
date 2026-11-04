import test from 'node:test';
import assert from 'node:assert/strict';
import { demoState, emptyState } from '../shared/defaults.js';
import {
  PRESENTATION_INDICATORS, newPresentationEvaluation, presentationCategoryAssessment,
  presentationEvaluationIssues, presentationPublisherAssessment, presentationPublisherAvailable,
  presentationScore, presentationSummary, presentationTeacherInScope,
} from '../shared/presentation.js';
import type { PresentationEvaluation, Score, State } from '../shared/types.js';

function liveState(count = 5, publisherCount = 1): State {
  const state = emptyState();
  state.teachers = Array.from({ length: count }, (_, index) => ({
    id: `teacher-${index}`, version: 1, name: `Docente ${index}`, attended: false, attendanceEvidence: '',
    area: 'MAT', categories: ['P1'], selfRegistered: true,
  }));
  state.publishers = Array.from({ length: publisherCount }, (_, index) => ({
    id: `publisher-${index}`, version: 1, name: `Editorial ${index}`, samplesReceived: false, sampleNote: '',
  }));
  return state;
}

function close(state: State, teacherIndex: number, score: number, publisherIndex = 0): PresentationEvaluation {
  let remaining = score / 5;
  const scores = Array.from({ length: 10 }, () => {
    const value = Math.min(remaining, 2) as Score; remaining -= value!; return value;
  });
  const evaluation: PresentationEvaluation = {
    ...newPresentationEvaluation({ publisherId: `publisher-${publisherIndex}`, teacherId: `teacher-${teacherIndex}`, area: 'MAT', block: 'P1' }),
    id: `presentation-${publisherIndex}-${teacherIndex}`, version: 1,
    scores, status: 'closed', closedAt: '2026-11-04T18:00:00.000Z', updatedAt: '2026-11-04T18:00:00.000Z',
  };
  state.presentationEvaluations.push(evaluation);
  return evaluation;
}

test('a live form starts with ten unanswered indicators and optional personal observations', () => {
  const form = newPresentationEvaluation({ publisherId: 'publisher', teacherId: 'teacher', area: 'COM', block: 'S1', rulesVersion: 3 });
  assert.equal(PRESENTATION_INDICATORS.length, 10);
  assert.deepEqual(form.scores, Array(10).fill(null));
  assert.deepEqual(form.notes, Array(10).fill(''));
  assert.equal(form.version, 0);
  assert.equal(form.rulesVersion, 3);
  assert.equal(presentationScore(form), null);
  assert.equal(presentationEvaluationIssues(form).length, 1);
  form.scores = Array(10).fill(0);
  assert.equal(presentationScore(form), 0);
  assert.deepEqual(presentationEvaluationIssues(form), []);
});

test('closing live observations needs no preloaded book, dossier, price, workload or ten mandatory notes', () => {
  const state = liveState(1);
  const form = close(state, 0, 80);
  assert.deepEqual(state.books, []);
  assert.deepEqual(state.assignments, []);
  assert.deepEqual(form.notes, Array(10).fill(''));
  assert.equal(form.physicalText, '');
  assert.equal(form.materialViewed, undefined);
  assert.deepEqual(presentationEvaluationIssues(form), []);
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').state, 'eligible');
});

test('all three or five closed teachers contribute to the mean without a two-teacher cap', () => {
  const state = liveState();
  close(state, 0, 100); close(state, 1, 90); close(state, 2, 80);
  let summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.deepEqual({ registered: summary.registered, closed: summary.closed, pending: summary.pending, score: summary.score },
    { registered: 5, closed: 3, pending: 2, score: 90 });
  assert.equal(summary.state, 'pending');
  close(state, 3, 70); close(state, 4, 60);
  summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.deepEqual({ registered: summary.registered, closed: summary.closed, pending: summary.pending, score: summary.score },
    { registered: 5, closed: 5, pending: 0, score: 80 });
  assert.equal(summary.state, 'eligible');
});

test('pending counts use the selected area and blocks and do not depend on attendance or assignments', () => {
  const state = liveState();
  state.teachers[4].area = 'COM';
  state.teachers[3].categories = ['S1'];
  state.teachers.push({ id: 'historical', version: 1, name: 'Sin perfil de exposición', attended: true, attendanceEvidence: 'Anterior' });
  close(state, 0, 100); close(state, 1, 90);
  const draft = close(state, 2, 80); draft.status = 'draft'; draft.closedAt = null;
  const summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.equal(summary.registered, 3); assert.equal(summary.closed, 2); assert.equal(summary.pending, 1); assert.equal(summary.drafts, 1);
  assert.equal(presentationTeacherInScope(state.teachers[0], 'MAT', 'P1'), true);
  assert.equal(presentationTeacherInScope(state.teachers[0], 'COM', 'P1'), false);
});

test('historical grades never become presentation scores and unauthorized teachers cannot inflate the mean', () => {
  const state = liveState(1);
  state.evaluations = [{ id: 'legacy', scores: Array(10).fill(2), status: 'closed' } as never];
  let summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.equal(summary.score, null); assert.equal(summary.pending, 1);
  close(state, 0, 75);
  state.presentationEvaluations.push({ ...state.presentationEvaluations[0], id: 'outsider', teacherId: 'another-teacher', scores: Array(10).fill(2) });
  summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.equal(summary.score, 75); assert.equal(summary.closed, 1);
});

test('invalid and duplicate live forms stay pending instead of inventing scores', () => {
  const state = liveState(1);
  const form = close(state, 0, 100);
  form.scores[0] = null;
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').pending, 1);
  form.scores[0] = 2;
  state.presentationEvaluations.push({ ...form, id: 'duplicate' });
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').closed, 0);
  for (const invalid of [-1, 3, 1.5, '1', undefined]) {
    assert.throws(() => presentationScore([invalid, ...Array(9).fill(2)] as Score[]), /entero/);
  }
});

test('editorials are available without a catalog and explicit offer scope is respected', () => {
  const state = liveState(1);
  assert.equal(presentationPublisherAvailable(state, 'publisher-0', 'MAT', 'P1'), true);
  state.series.push({ id: 'series', version: 1, publisherId: 'publisher-0', name: 'Serie' });
  state.offers.push({ id: 'offer', version: 1, seriesId: 'series', area: 'COM', block: 'S1', edition: '', status: 'offered', withdrawalReason: '' });
  assert.equal(presentationPublisherAvailable(state, 'publisher-0', 'MAT', 'P1'), false);
  assert.equal(presentationPublisherAvailable(state, 'publisher-0', 'COM', 'S1'), true);
  assert.equal(presentationCategoryAssessment(state, 'MAT', 'P1').ranked.length, 0);
});

test('category ranking applies threshold to category averages and blocks an unresolved cutoff tie', () => {
  const state = liveState(5, 5);
  for (let publisher = 0; publisher < 5; publisher += 1) for (let teacher = 0; teacher < 5; teacher += 1) {
    close(state, teacher, [90, 85, 80, 80, 65][publisher], publisher);
  }
  let category = presentationCategoryAssessment(state, 'MAT', 'P1');
  assert.equal(category.registered, 5); assert.equal(category.closed, 25); assert.equal(category.pending, 0);
  assert.equal(category.state, 'tie');
  assert.deepEqual(category.tied, ['publisher-2', 'publisher-3']);
  assert.deepEqual(category.finalists, []);
  for (const form of state.presentationEvaluations.filter(item => item.publisherId === 'publisher-3')) {
    form.scores[1] = 1; form.scores[8] = 1; // same total, lower I2
  }
  category = presentationCategoryAssessment(state, 'MAT', 'P1');
  assert.equal(category.state, 'ready');
  assert.deepEqual(category.finalists, ['publisher-0', 'publisher-1', 'publisher-2']);
  assert.equal(category.ranked.find(item => item.publisherId === 'publisher-4')?.state, 'ineligible');
});

test('one or two eligible publishers are explicit and no grade assessment is invented', () => {
  const state = liveState(3, 2);
  for (let publisher = 0; publisher < 2; publisher += 1) for (let teacher = 0; teacher < 3; teacher += 1) close(state, teacher, 80, publisher);
  const category = presentationCategoryAssessment(state, 'MAT', 'P1');
  assert.equal(category.state, 'less_than_three');
  assert.deepEqual(category.finalists, ['publisher-0', 'publisher-1']);
  assert.equal('grades' in category.ranked[0], false);
  assert.equal(presentationSummary(state).length, 6);
});

test('real data starts empty and demonstration separates five live teachers from historical assignment pairs', () => {
  const real = emptyState();
  assert.equal(real.settings.evaluationMode, 'presentation');
  assert.deepEqual(real.presentationEvaluations, []); assert.deepEqual(real.presentationShortlists, []);
  const demo = demoState();
  assert.equal(demo.teachers.length, 5);
  assert.equal(presentationPublisherAssessment(demo, demo.publishers[0].id, 'MAT', 'P1').closed, 5);
  assert.equal(presentationCategoryAssessment(demo, 'MAT', 'P1').state, 'ready');
  assert.equal(demo.assignments.filter(item => item.bookId === demo.books[0].id && item.kind === 'initial').length, 2);
});
