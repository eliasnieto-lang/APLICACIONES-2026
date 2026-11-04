import test from 'node:test';
import assert from 'node:assert/strict';
import { demoState, emptyState } from '../shared/defaults.js';
import {
  PRESENTATION_INDICATORS, PRESENTATION_SCALE, newPresentationEvaluation, presentationCategoryAssessment,
  presentationEvaluationIssues, presentationPublisherAssessment, presentationPublisherAvailable,
  presentationScore, presentationSummary, presentationTeacherInScope, presentationEvaluationScaleMax,
  presentationScaleLabel, presentationUsesCurrentScale, presentationUsesCurrentRubric, presentationMaximum,
} from '../shared/presentation.js';
import type { PresentationEvaluation, PresentationScore, State } from '../shared/types.js';

function liveState(count = 5, publisherCount = 1): State {
  const state = emptyState();
  state.teachers = Array.from({ length: count }, (_, index) => ({
    id: `teacher-${index}`, version: 1, name: `Docente ${index}`, attended: false, attendanceEvidence: '',
    area: 'MAT', categories: ['P1'], selfRegistered: true,
  }));
  state.publishers = Array.from({ length: publisherCount }, (_, index) => ({
    id: `publisher-${index}`, version: 1, name: `Editorial ${index}`, samplesReceived: false, sampleNote: '',
  }));
  state.presentationQuestions = state.publishers.map(publisher => ({ id: `q-${publisher.id}`, publisherId: publisher.id, version: 1, representativeName: 'Portavoz docente', area: 'MAT', question: '¿Cómo responde al aprendizaje?', answer: 'Explicación observada', status: 'answered', askedAt: '2026-11-04T18:00:00Z', answeredAt: '2026-11-04T18:00:00Z', updatedAt: '2026-11-04T18:00:00Z' }));
  return state;
}

function close(state: State, teacherIndex: number, score: number, publisherIndex = 0): PresentationEvaluation {
  let remaining = Math.round(score * 44 / 100);
  const scores = Array.from({ length: 10 }, () => {
    const value = Math.min(remaining, 4) as PresentationScore; remaining -= value!; return value;
  });
  const evaluation: PresentationEvaluation = {
    ...newPresentationEvaluation({ publisherId: `publisher-${publisherIndex}`, teacherId: `teacher-${teacherIndex}`, area: 'MAT', block: 'P1' }),
    id: `presentation-${publisherIndex}-${teacherIndex}`, version: 1,
    scores, responseScore: remaining as PresentationScore, questionVersion: 1, status: 'closed', closedAt: '2026-11-04T18:00:00.000Z', updatedAt: '2026-11-04T18:00:00.000Z',
  };
  state.presentationEvaluations.push(evaluation);
  return evaluation;
}

test('a live form starts with ten observations and the mandatory answer criterion pending', () => {
  const form = newPresentationEvaluation({ publisherId: 'publisher', teacherId: 'teacher', area: 'COM', block: 'S1', rulesVersion: 3 });
  assert.equal(PRESENTATION_INDICATORS.length, 10);
  assert.deepEqual(form.scores, Array(10).fill(null));
  assert.deepEqual(form.notes, Array(10).fill(''));
  assert.equal(form.version, 0);
  assert.equal(form.rulesVersion, 3);
  assert.equal(form.scaleMax, 4);
  assert.equal(presentationScore(form), null);
  assert.equal(presentationEvaluationIssues(form).length, 1);
  form.scores = Array(10).fill(0);
  assert.equal(presentationScore(form), null);
  form.responseScore = 0; form.questionVersion = 1;
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
  close(state, 0, 100); close(state, 1, 75); close(state, 2, 50);
  let summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.deepEqual({ registered: summary.registered, closed: summary.closed, pending: summary.pending, score: summary.score },
    { registered: 5, closed: 3, pending: 2, score: 75 });
  assert.equal(summary.state, 'pending');
  close(state, 3, 25); close(state, 4, 0);
  summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.deepEqual({ registered: summary.registered, closed: summary.closed, pending: summary.pending, score: summary.score },
    { registered: 5, closed: 5, pending: 0, score: 50 });
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
  form.scores[0] = 4;
  state.presentationEvaluations.push({ ...form, id: 'duplicate' });
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').closed, 0);
  for (const invalid of [-1, 5, 1.5, NaN, Infinity, '1', undefined]) {
    assert.throws(() => presentationScore([invalid, ...Array(9).fill(4)] as PresentationScore[]), /entero/);
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

test('category ranking has no minimum score and blocks an unresolved cutoff tie', () => {
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
    form.scores[1] = 3; form.responseScore = 1; // same eleven-criterion total, lower I2
  }
  category = presentationCategoryAssessment(state, 'MAT', 'P1');
  assert.equal(category.state, 'ready');
  assert.deepEqual(category.finalists, ['publisher-0', 'publisher-1', 'publisher-2']);
  assert.equal(category.ranked.find(item => item.publisherId === 'publisher-4')?.state, 'eligible');
});

test('three complete publishers classify even below a stored threshold or with an explicit zero', () => {
  const state = liveState(3, 3); state.settings.rules.threshold = 100;
  for (let publisher = 0; publisher < 3; publisher++) for (let teacher = 0; teacher < 3; teacher++) close(state, teacher, [20, 10, 0][publisher], publisher);
  const category = presentationCategoryAssessment(state, 'MAT', 'P1');
  assert.equal(category.state, 'ready'); assert.equal(category.pending, 0);
  assert.deepEqual(category.finalists, ['publisher-0', 'publisher-1', 'publisher-2']);
  assert(category.ranked.every(item => item.state === 'eligible')); assert.deepEqual(category.reasons, []);
});

test('one or two completed publishers are explicit and no grade assessment is invented', () => {
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
  assert.equal(real.settings.presentationScaleMax, 4);
  assert.deepEqual(real.presentationEvaluations, []); assert.deepEqual(real.presentationShortlists, []);
  const demo = demoState();
  assert.equal(demo.teachers.length, 5);
  assert.equal(presentationPublisherAssessment(demo, demo.publishers[0].id, 'MAT', 'P1').closed, 5);
  assert.equal(presentationCategoryAssessment(demo, 'MAT', 'P1').state, 'ready');
  assert.equal(demo.assignments.filter(item => item.bookId === demo.books[0].id && item.kind === 'initial').length, 2);
  assert.ok(demo.presentationEvaluations.every(evaluation => evaluation.scaleMax === 4));
  assert.equal(presentationPublisherAssessment(demo, demo.publishers[0].id, 'MAT', 'P1').score, 4000 / 44);
});

test('the five scale choices use one unified criterion description and no A/B signals', () => {
  assert.deepEqual(PRESENTATION_SCALE.map(item => item.value), [0, 1, 2, 3, 4]);
  assert.deepEqual(PRESENTATION_SCALE.map(item => item.label), ['Sin valoración', 'En inicio', 'En proceso', 'Logrado', 'Destacado']);
  assert.equal(presentationScaleLabel(0), 'Sin valoración');
  assert.equal(presentationScaleLabel(4), 'Destacado');
  assert.equal(presentationScaleLabel(null), 'Pendiente');
  for (const criterion of PRESENTATION_INDICATORS) {
    assert.ok(criterion.description.trim());
    assert.equal('a' in criterion, false); assert.equal('b' in criterion, false);
    for (const variant of Object.values(criterion.variants ?? {})) {
      assert.ok(variant.description.trim()); assert.equal('a' in variant, false); assert.equal('b' in variant, false);
    }
  }
});

test('explicit zero counts zero in the fixed maximum of forty and is different from an unanswered criterion', () => {
  assert.equal(presentationScore(Array(10).fill(4)), 100);
  assert.equal(presentationScore(Array(10).fill(0)), 0);
  assert.equal(presentationScore([0, ...Array(9).fill(4)]), 90);
  assert.equal(presentationScore([null, ...Array(9).fill(4)]), null);
  assert.equal(presentationScore(Array(10).fill(2)), 50);
  assert.equal(presentationScore(Array(10).fill(3)), 75);
  assert.equal(presentationScore([1, ...Array(9).fill(0)]), 2.5);
  const state = liveState(1); const form = close(state, 0, 0);
  assert.deepEqual(presentationEvaluationIssues(form), []);
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').closed, 1);
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').score, 0);
  assert.equal(presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1').state, 'eligible');
  const cohort = liveState(5);
  for (let teacher = 0; teacher < 5; teacher += 1) close(cohort, teacher, teacher === 4 ? 0 : 100);
  const summary = presentationPublisherAssessment(cohort, 'publisher-0', 'MAT', 'P1');
  assert.equal(summary.closed, 5); assert.equal(summary.pending, 0); assert.equal(summary.score, 80);
});

test('stored legacy scale keeps its original percentage and never infers scale from the numeric values', () => {
  const scores: PresentationScore[] = Array(10).fill(2);
  assert.equal(presentationScore({ scores }), 100);
  assert.equal(presentationScore({ scores, scaleMax: 2 }), 100);
  assert.equal(presentationScore({ scores, scaleMax: 4 }), 50);
  assert.equal(presentationScore(scores, 2), 100);
  assert.equal(presentationScore(scores), 50);
  assert.equal(presentationEvaluationScaleMax({}), 2);
  assert.equal(presentationEvaluationScaleMax({ scaleMax: 4 }), 4);
  assert.equal(presentationUsesCurrentScale({}), false);
  assert.equal(presentationUsesCurrentScale({ scaleMax: 2 }), false);
  assert.equal(presentationUsesCurrentScale({ scaleMax: 4 }), true);
  assert.throws(() => presentationScore({ scores, scaleMax: 3 as never }), /escala/);
  assert.throws(() => presentationScore(Array(10).fill(3), 2), /entero/);
  assert.throws(() => presentationScore(Array(10).fill(4), 3 as never), /escala/);
  assert.throws(() => presentationScore(Array(10) as PresentationScore[]), /entero/);
});

test('legacy live evaluations remain historical and pending an explicit new-scale review', () => {
  const state = liveState();
  close(state, 0, 100); close(state, 1, 75); close(state, 2, 50);
  const missingMetadata = close(state, 3, 70); delete missingMetadata.scaleMax; delete missingMetadata.rubricVersion; delete missingMetadata.responseScore; delete missingMetadata.questionVersion; missingMetadata.scores = Array(10).fill(2);
  const explicitLegacy = close(state, 4, 60); explicitLegacy.scaleMax = 2; delete explicitLegacy.rubricVersion; delete explicitLegacy.responseScore; delete explicitLegacy.questionVersion; explicitLegacy.scores = Array(10).fill(1);
  const preserved = structuredClone([missingMetadata, explicitLegacy]);
  let summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.deepEqual({ registered: summary.registered, closed: summary.closed, pending: summary.pending, pendingScaleUpdate: summary.pendingScaleUpdate, score: summary.score },
    { registered: 5, closed: 3, pending: 2, pendingScaleUpdate: 2, score: 75 });
  assert.equal(presentationScore(missingMetadata), 100); assert.equal(presentationScore(explicitLegacy), 50);
  assert.match(presentationEvaluationIssues(missingMetadata)[0], /Pendiente actualizar escala/);
  assert.match(presentationCategoryAssessment(state, 'MAT', 'P1').reasons.join(' '), /actualizar/);
  assert.deepEqual([missingMetadata, explicitLegacy], preserved);
  explicitLegacy.status = 'draft'; explicitLegacy.closedAt = null;
  summary = presentationPublisherAssessment(state, 'publisher-0', 'MAT', 'P1');
  assert.equal(summary.drafts, 1); assert.equal(summary.pendingScaleUpdate, 2); assert.equal(summary.closed, 3);
});

test('a historical published shortlist cannot mark the new scale as published', () => {
  const state = liveState(1, 3);
  for (let publisher = 0; publisher < 3; publisher += 1) close(state, 0, 80, publisher);
  const assessment = presentationCategoryAssessment(state, 'MAT', 'P1');
  state.presentationShortlists.push({ id: 'old-shortlist', version: 1, categoryId: 'MAT-P1', area: 'MAT', block: 'P1',
    publisherIds: state.publishers.map(publisher => publisher.id), status: 'published', statement: 'Histórico', folio: 'H-1',
    directorApproved: true, publishedAt: '2026-11-04T18:00:00.000Z', rulesVersion: 1,
    snapshot: { assessment: structuredClone(assessment), publishers: state.publishers, threshold: 70 } });
  assert.equal(presentationCategoryAssessment(state, 'MAT', 'P1').state, 'ready');
  state.presentationShortlists[0].snapshot.scaleMax = 2;
  assert.equal(presentationCategoryAssessment(state, 'MAT', 'P1').state, 'ready');
  state.presentationShortlists[0].snapshot.scaleMax = 4;
  assert.equal(presentationCategoryAssessment(state, 'MAT', 'P1').state, 'ready');
  state.presentationShortlists[0].snapshot.rubricVersion = 2;
  assert.equal(presentationCategoryAssessment(state, 'MAT', 'P1').state, 'published');
});


test('the answer is an equally weighted eleventh criterion, with zero counted and a fixed maximum of44', () => {
  const form = newPresentationEvaluation({ publisherId: 'p', teacherId: 't', area: 'MAT', block: 'P1' });
  assert.equal(presentationUsesCurrentRubric(form), true); assert.equal(presentationMaximum(form), 44);
  form.scores = Array(10).fill(4); assert.equal(presentationScore(form), null);
  form.responseScore = 0; form.questionVersion = 1; assert.equal(presentationScore(form), 4000 / 44);
  form.responseScore = 4; assert.equal(presentationScore(form), 100);
  for (const invalid of [-1, 5, 1.5, undefined]) assert.throws(() => presentationScore({ ...form, responseScore: invalid as never }), /entero/);
});

test('old ten-criterion forms preserve their original percentage but stay pending for current classification', () => {
  const state = liveState(1); const form = close(state, 0, 100);
  delete form.rubricVersion; delete form.responseScore; delete form.questionVersion;
  assert.equal(presentationMaximum(form), 40); assert.equal(presentationScore(form), 100);
  assert.equal(presentationUsesCurrentRubric(form), false); assert.match(presentationEvaluationIssues(form)[0], /pregunta obligatoria/);
  assert.equal(presentationPublisherAssessment(state, form.publisherId, form.area, form.block).pendingQuestionUpdate, 1);
  assert.equal(presentationPublisherAssessment(state, form.publisherId, form.area, form.block).closed, 0);
  form.rubricVersion = 2; form.responseScore = 0; form.questionVersion = 1;
  assert.equal(presentationPublisherAssessment(state, form.publisherId, form.area, form.block).closed, 1);
  state.presentationQuestions![0].version = 2;
  assert.equal(presentationPublisherAssessment(state, form.publisherId, form.area, form.block).closed, 0);
});
