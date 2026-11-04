import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../shared/defaults.js';
import { newPresentationEvaluation, presentationCategoryAssessment } from '../shared/presentation.js';
import { presentationDrawFinished, presentationOrderedPublishers, presentationRankingRows, teacherProgress, type JornadaState } from '../shared/jornada.js';
import type { Block, PresentationScore } from '../shared/types.js';

function state(teachers = 1): JornadaState {
  const s = emptyState();
  s.publishers = ['a', 'b'].map(id => ({ id, version: 1, name: `Editorial ${id}`, samplesReceived: false, sampleNote: '' }));
  s.teachers = Array.from({ length: teachers }, (_, index) => ({ id: `t${index}`, version: 1, name: `Docente ${index}`, area: 'MAT' as const, categories: ['P1', 'P2'] as Block[], attended: false, attendanceEvidence: '' }));
  s.presentationQuestions = s.publishers.map(publisher => ({ id: `q-${publisher.id}`, version: 1, publisherId: publisher.id,
    representativeName: 'Portavoz del ensayo', area: 'MAT', question: 'Pregunta del ensayo', answer: 'Respuesta del ensayo',
    status: 'answered', askedAt: '2026-11-04T10:00:00Z', answeredAt: '2026-11-04T10:00:01Z', updatedAt: '2026-11-04T10:00:01Z' }));
  return s;
}
function form(s: JornadaState, publisherId: string, block: Block, scores: PresentationScore[], closed = false, scaleMax: 2 | 4 = 4) {
  const value = { ...newPresentationEvaluation({ publisherId, teacherId: 't0', area: 'MAT', block }), id: `${publisherId}-${block}`, version: 1, scores, scaleMax, rubricVersion: scaleMax === 4 ? 2 as const : undefined, responseScore: scaleMax === 4 && scores.every(value => value !== null) ? 0 as const : null, questionVersion: scaleMax === 4 && scores.every(value => value !== null) ? 1 : null, status: closed ? 'closed' as const : 'draft' as const };
  s.presentationEvaluations.push(value); return value;
}

test('shared draw order is stable, retains global position and leaves late arrivals without an invented place', () => {
  const s = state();
  s.publishers.push({ id: 'late', version: 1, name: 'Llegó después', samplesReceived: false, sampleNote: '' });
  s.presentationDraw = { id: 'draw', version: 1, publishers: [{ id: 'b', name: 'Editorial b' }, { id: 'a', name: 'Editorial a' }], completedPublisherIds: ['b'], createdAt: '2026-11-04T10:00:00Z', createdBy: 'Subdirector' };
  s.turn = { publisherId: 'a', status: 'running', startedAt: '2026-11-04T10:01:00Z', pausedAt: null, pausedMilliseconds: 0 };
  const rows = presentationOrderedPublishers(s, 'MAT', 'P1');
  assert.deepEqual(rows.map(row => [row.id, row.participationOrder, row.completed, row.current]), [['b', 1, true, false], ['a', 2, false, true], ['late', null, false, false]]);
  assert.deepEqual(s.publishers.map(row => row.id), ['a', 'b', 'late']);
});

test('teacher progress includes every chosen category and explicit zero, but does not count historical responses', () => {
  const s = state(8);
  form(s, 'a', 'P1', Array(10).fill(0), true);
  form(s, 'b', 'P1', [0, 4, 3, 2, 1, ...Array(5).fill(null)]);
  form(s, 'a', 'P2', Array(10).fill(2), true, 2);
  const rows = teacherProgress(s);
  assert.equal(rows.length, 8);
  assert.deepEqual({ expected: rows[0].expectedSheets, marked: rows[0].markedCriteria, denominator: rows[0].expectedCriteria, percentage: rows[0].percentage, closed: rows[0].closedSheets, historical: rows[0].historicalSheets }, { expected: 4, marked: 16, denominator: 44, percentage: 36.4, closed: 1, historical: 1 });
  const scoped = teacherProgress(s, { area: 'MAT', block: 'P1' })[0];
  assert.equal(scoped.expectedSheets, 2); assert.equal(scoped.percentage, 72.7); assert.equal(scoped.closedSheets, 1);
  assert.deepEqual(teacherProgress(s, { area: 'COM' }), []);
});

test('100% responses still needs closure; every completed zero-valued form can finish the teacher work', () => {
  const s = state(); s.teachers[0].categories = ['P1'];
  form(s, 'a', 'P1', Array(10).fill(0)); form(s, 'b', 'P1', Array(10).fill(4), true);
  const pending = teacherProgress(s)[0]; assert.equal(pending.percentage, 100); assert.equal(pending.status, 'in_progress'); assert.equal(pending.pendingSheets, 1);
  s.presentationEvaluations[0].status = 'closed';
  const closed = teacherProgress(s)[0]; assert.equal(closed.status, 'complete'); assert.equal(closed.closedSheets, 2);
});

test('unregistered profiles and empty publisher catalogs never appear complete; duplicate sheets never inflate progress', () => {
  const s = state(); s.teachers[0].categories = ['P1'];
  const original = form(s, 'a', 'P1', Array(10).fill(4), true);
  s.presentationEvaluations.push({ ...original, id: 'duplicate' });
  const duplicate = teacherProgress(s)[0]; assert.equal(duplicate.conflictingSheets, 1); assert.equal(duplicate.markedCriteria, 0); assert.equal(duplicate.closedSheets, 0);
  s.teachers.push({ id: 'legacy', version: 1, name: 'Perfil anterior', attended: false, attendanceEvidence: '' });
  assert.equal(teacherProgress(s)[1].status, 'waiting');
  s.publishers = []; assert(teacherProgress(s).every(row => row.status === 'waiting' && row.percentage === 0));
});

test('ranking preserves zeros, leaves missing scores pending and includes every editorial tied at Top boundary', () => {
  const s = state();
  const category = presentationCategoryAssessment(s, 'MAT', 'P1');
  const row = category.ranked[0];
  category.ranked = [
    { ...row, publisherId: 'a', score: 95, i2: 4 },
    { ...row, publisherId: 'b', score: 80, i2: 3 },
    { ...row, publisherId: 'c', score: 80, i2: 3 },
    { ...row, publisherId: 'd', score: 0, i2: 0 },
    { ...row, publisherId: 'e', score: null, i2: null },
  ];
  assert.deepEqual(presentationRankingRows(category, 2).map(item => [item.assessment.publisherId, item.position, item.tied]), [['a', 1, false], ['b', 2, true], ['c', 2, true]]);
  assert.deepEqual(presentationRankingRows(category).map(item => item.position), [1, 2, 2, 4, null]);
  assert.equal(presentationRankingRows(category)[3].assessment.score, 0);
});

test('ranking readiness requires a nonempty draw and completion of all its publishers', () => {
  const s = state(); assert.equal(presentationDrawFinished(s), false);
  s.presentationDraw = { id: 'draw', version: 1, publishers: [], completedPublisherIds: [], createdAt: '', createdBy: '' };
  assert.equal(presentationDrawFinished(s), false);
  s.presentationDraw.publishers = [{ id: 'a', name: 'Editorial a' }, { id: 'b', name: 'Editorial b' }];
  s.presentationDraw.completedPublisherIds = ['a']; assert.equal(presentationDrawFinished(s), false);
  s.presentationDraw.completedPublisherIds.push('b'); assert.equal(presentationDrawFinished(s), true);
  s.presentationQuestions = []; assert.equal(presentationDrawFinished(s), false);
});
