import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book, Evaluation, Offer, Score, State } from '../shared/types.js';
import { defaultBook, defaultSupportProfile, demoState, emptyState } from '../shared/defaults.js';
import {
  assessBook, assessCategory, assessOffer, basePrice, practiceSummary, samplePositions,
  scoreEvaluation, sourceToTargetGrade, supportScoreConstraints, workloadSummary,
} from '../shared/domain.js';

function scoresFor(total: number, i2 = 2): Score[] {
  const scores: Score[] = Array(10).fill(0);
  scores[1] = i2 as Score;
  let remaining = total - i2;
  for (let index = 0; index < 10; index += 1) if (index !== 1) {
    const value = Math.min(2, remaining);
    scores[index] = value as Score; remaining -= value;
  }
  assert.equal(remaining, 0);
  return scores;
}
function setBookScores(state: State, book: Book, firstTotal: number, secondTotal = firstTotal, i2 = 2): void {
  const evaluations = state.evaluations.filter(evaluation => evaluation.bookId === book.id);
  evaluations.forEach((evaluation, index) => {
    evaluation.scores = scoresFor(index ? secondTotal : firstTotal, i2);
    evaluation.status = 'closed'; evaluation.closedAt = '2026-11-05T22:00:00.000Z';
    evaluation.evidence = Array(10).fill('Índice, pp. 2–3; tareas pp. 4–16; demostración folio D-03.');
  });
}
function fixture(): State {
  const state = demoState();
  state.offers = state.offers.filter(offer => offer.area === 'MAT' && offer.block === 'P1');
  const offerIds = new Set(state.offers.map(offer => offer.id));
  state.books = state.books.filter(book => offerIds.has(book.offerId));
  const bookIds = new Set(state.books.map(book => book.id));
  state.assignments = state.assignments.filter(assignment => bookIds.has(assignment.bookId));
  state.evaluations = state.evaluations.filter(evaluation => bookIds.has(evaluation.bookId));
  state.offers.forEach((offer, index) => setOffer(state, offer, [18, 17, 16, 15][index]));
  return state;
}
function setOffer(state: State, offer: Offer, total: number, i2 = 2): void {
  state.books.filter(book => book.offerId === offer.id).forEach(book => setBookScores(state, book, total, total, i2));
}
function additionalReview(state: State, offers: Offer[], totals: number[], shared = true): void {
  offers.forEach((offer, index) => {
    const reviewId = shared ? 'review-shared' : `review-${index}`;
    if (!state.reviews.some(review => review.id === reviewId)) state.reviews.push({
      id: reviewId, version: 1, categoryId: 'MAT-P1', offerIds: shared ? offers.map(item => item.id) : [offer.id],
      unitReference: shared ? 'Unidad adicional 4, misma pauta de observación' : `Unidad ${index + 1}`,
      reason: 'Desempate técnico de la última plaza; no sustituye el puntaje inicial.',
    });
    const initial = state.assignments.filter(assignment => assignment.kind === 'initial' && state.books.some(book => book.id === assignment.bookId && book.offerId === offer.id));
    for (const original of initial) {
      const assignment = { ...original, id: `${original.id}-additional`, kind: 'additional' as const, reviewId };
      state.assignments.push(assignment);
      const evaluation: Evaluation = {
        ...state.evaluations.find(item => item.assignmentId === original.id)!,
        id: `${assignment.id}-evaluation`, assignmentId: assignment.id, scores: scoresFor(totals[index]),
      };
      state.evaluations.push(evaluation);
    }
  });
}

test('14/20 son 70; nueve respuestas, cero comprobado y ficha histórica conservan estados distintos', () => {
  assert.equal(scoreEvaluation(scoresFor(14)), 70);
  assert.equal(scoreEvaluation(Array(9).fill(2)), null);
  assert.equal(scoreEvaluation([...Array(9).fill(2), 0]), 90);
  const historical = demoState().evaluations[0];
  historical.legacyIndicatorCount = 8;
  assert.equal(scoreEvaluation(historical), null);
  for (const invalid of [-1, 3, 0.5, undefined, NaN]) assert.throws(() => scoreEvaluation([invalid, ...Array(9).fill(0)] as Score[]));
  assert.throws(() => scoreEvaluation(Array(10)));
});

test('dos fichas de 75 y 85 producen 80 y exactamente 70 pasa el corte por grado', () => {
  const state = fixture(); const book = state.books[0];
  setBookScores(state, book, 15, 17);
  assert.equal(assessBook(state, book).score, 80);
  setBookScores(state, book, 14);
  assert.equal(assessBook(state, book).state, 'eligible');
  assert.equal(assessBook(state, book).score, 70);
});

test('P2 usa todos sus grados con igual peso; un 65 no se rescata con el promedio del bloque', () => {
  const state = demoState();
  const offer = state.offers.find(item => item.area === 'MAT' && item.block === 'P2')!;
  const books = state.books.filter(book => book.offerId === offer.id);
  [16, 15, 17, 18].forEach((total, index) => setBookScores(state, books[index], total));
  assert.equal(assessOffer(state, offer).score, 82.5);
  assert.equal(assessOffer(state, offer).state, 'eligible');
  setBookScores(state, books[1], 13);
  assert.equal(assessOffer(state, offer).score, 80);
  assert.equal(assessOffer(state, offer).state, 'ineligible');
});

test('los cálculos de bloque conservan el valor completo para ordenar', () => {
  const state = demoState();
  const offer = state.offers.find(item => item.area === 'MAT' && item.block === 'P2')!;
  state.books.filter(book => book.offerId === offer.id).forEach((book, index) => setBookScores(state, book, index ? 16 : 15, 17));
  assert.equal(assessOffer(state, offer).score, 81.875);
});

test('docentes repetidos, versión distinta y evidencia ausente no producen una nota de grado', () => {
  const state = fixture(); const book = state.books[0];
  const assignments = state.assignments.filter(item => item.bookId === book.id);
  assignments[1].teacherId = assignments[0].teacherId;
  assert.equal(assessBook(state, book).score, null);
  assert.equal(assessBook(state, book).state, 'pending');
  assignments[1].teacherId = state.teachers[1].id;
  book.version = 2;
  assert.equal(assessBook(state, book).score, null);
  book.version = 1;
  state.evaluations.find(item => item.bookId === book.id)!.evidence[3] = '';
  assert.equal(assessBook(state, book).state, 'pending');
});

test('sin oferta, ficha pendiente, retiro e incumplimiento son distintos y no se convierten en cero', () => {
  const state = fixture(); const offer = state.offers[0]; const book = state.books[0];
  book.active = false;
  assert.equal(assessBook(state, book).state, 'not_offered');
  assert.equal(assessBook(state, book).score, null);
  assert.equal(assessOffer(state, offer).state, 'ineligible');
  book.active = true;
  state.evaluations.find(item => item.bookId === book.id)!.status = 'draft';
  assert.equal(assessBook(state, book).state, 'pending');
  assert.equal(assessBook(state, book).score, null);
  book.checks[0] = { status: 'fail', evidence: 'Incumplimiento documentado', note: 'Comité, folio 3' };
  assert.equal(assessBook(state, book).state, 'ineligible');
  offer.status = 'withdrawn'; offer.withdrawalReason = 'Retiro documentado';
  assert.equal(assessOffer(state, offer).state, 'withdrawn');
});

test('16 temas por bimestres y los mismos 16 por capítulos siguen siendo 16; el detalle sustituye la carga rápida', () => {
  const book = demoState().books[0];
  assert.equal(workloadSummary(book).total, 16);
  assert.deepEqual(workloadSummary(book).bimesters, [4, 3, 5, 4]);
  assert.deepEqual(workloadSummary(book).samplePositions, [1, 8, 16]);
  book.workloadMode = 'quick'; book.bimesters = [99, 99, 99, 99];
  const detail = workloadSummary(book);
  assert.equal(detail.source, 'detailed'); assert.equal(detail.total, 16);
  assert.equal(detail.discrepancies.length, 4); assert.equal(detail.complete, false);
  book.workloadNote = 'Corrección documentada: prevalece el índice detallado, folio C-01.';
  assert.equal(workloadSummary(book).complete, true);
});

test('temas retomados no duplican la carga; una lección distinta sí cuenta', () => {
  const book = demoState().books[0];
  book.topics.push({ ...book.topics[0], id: 'revisit', code: 'R1', order: 17, revisitOf: 'T1' });
  assert.equal(workloadSummary(book).total, 16);
  book.topics[16].distinctLesson = true;
  assert.equal(workloadSummary(book).total, 17);
  assert.deepEqual(workloadSummary(book).samplePositions, [1, 9, 17]);
});

test('bimestre pendiente es null; cero comprobado exige observación y no se confunde con pendiente', () => {
  const book = defaultBook({ workloadSource: 'Índice p. 2', bimesters: [4, 3, null, 4], chapters: [{ name: 'Unidad', topicCount: 11, source: 'Índice p. 2' }] });
  assert.equal(workloadSummary(book).total, null);
  book.bimesters = [4, 3, 0, 4];
  assert.equal(workloadSummary(book).total, 11); assert.equal(workloadSummary(book).complete, false);
  book.workloadNote = 'B3 se dedica a un proyecto integrador sin temas nuevos, comprobado en programación.';
  assert.equal(workloadSummary(book).complete, true);
});

test('muestra 8,12,10 tiene media10, rango8–12 y n3, sin extrapolar al libro', () => {
  const book = demoState().books[0]; const summary = practiceSummary(book);
  assert.equal(summary.complete, true); assert.equal(summary.mean, 10); assert.equal(summary.min, 8); assert.equal(summary.max, 12);
  assert.equal(summary.size, 3); assert.equal(summary.allTopicsMean, null);
  book.practice[0].optionalCount = 999; book.practice[0].workbookCount = 999;
  assert.equal(practiceSummary(book).mean, 10);
});

test('cero verificado integra la media, desconocido mantiene la muestra pendiente', () => {
  const book = demoState().books[0];
  book.practice[0].baseCount = 0;
  assert.equal(practiceSummary(book).mean, 22 / 3); assert.equal(practiceSummary(book).min, 0);
  book.practice[0].baseCount = null;
  assert.equal(practiceSummary(book).complete, false); assert.equal(practiceSummary(book).mean, null);
});

test('N=1 y N=2 se muestrean una sola vez; índice desconocido mantiene pendiente la muestra', () => {
  assert.deepEqual(samplePositions(1), [1]); assert.deepEqual(samplePositions(2), [1, 2]); assert.deepEqual(samplePositions(null), []);
  const book = demoState().books[0];
  book.topics = book.topics.slice(0, 2); book.bimesters = [2, 0, 0, 0]; book.workloadNote = 'Sin temas nuevos en los otros bimestres.';
  book.practice = book.topics.map((topic, index) => ({ ...book.practice[0], topicId: topic.id, topicName: topic.name, position: index + 1, pages: topic.pages, baseCount: index ? 0 : 8 }));
  assert.equal(practiceSummary(book).mean, 4); assert.equal(practiceSummary(book).size, 2);
  book.topics = []; book.workloadMode = 'quick'; book.bimesters[0] = null;
  assert.equal(practiceSummary(book).complete, false);
});

test('promedio de todos los temas solo aparece con inventario completo y conserva origen declarado/verificado', () => {
  const book = demoState().books[0];
  book.practice = book.topics.map((topic, index) => ({ ...book.practice[0], topicId: topic.id, topicName: topic.name, position: index + 1, pages: topic.pages, baseCount: index, verified: false }));
  assert.equal(practiceSummary(book).allTopicsMean, 7.5); assert.equal(practiceSummary(book).allTopicsKind, 'declared');
  assert.equal(practiceSummary(book).mean, null);
  book.practice.forEach(sample => { sample.verified = true; });
  assert.equal(practiceSummary(book).allTopicsKind, 'verified');
  book.practice.pop();
  assert.equal(practiceSummary(book).allTopicsMean, null);
});

test('I10 admite equivalente autorizado y probado; ausencia, promesa y un solo perfil tienen límites distintos', () => {
  const book = demoState().books[0];
  assert.equal(book.supportKind, 'equivalent'); assert.equal(supportScoreConstraints(book).maximum, 2);
  book.studentSupport.status = 'not_offered';
  assert.equal(supportScoreConstraints(book).maximum, 1); assert.equal(supportScoreConstraints(book).required, 1);
  book.supportKind = 'none'; book.supportStatus = 'not_offered';
  assert.equal(supportScoreConstraints(book).required, 0);
  book.supportKind = 'platform'; book.supportStatus = 'declared';
  assert.equal(supportScoreConstraints(book).pending, true); assert.equal(supportScoreConstraints(book).maximum, null);
  book.supportKind = 'equivalent'; book.supportStatus = 'verified'; book.equivalentAuthorized = false;
  assert.equal(supportScoreConstraints(book).pending, true);
});

test('I10 no recibe funciones opcionales o solo portada y la ficha debe respetar la ausencia confirmada', () => {
  const state = fixture(); const book = state.books[0];
  book.teacherSupport.included = false;
  assert.equal(supportScoreConstraints(book).maximum, 1);
  book.teacherSupport.included = true; book.teacherSupport.action = 'Ingresar a la portada';
  assert.equal(supportScoreConstraints(book).pending, true);
  book.supportKind = 'none'; book.supportStatus = 'verified';
  setBookScores(state, book, 18);
  state.evaluations.filter(evaluation => evaluation.bookId === book.id).forEach(evaluation => { evaluation.scores[9] = 2; });
  assert.equal(assessBook(state, book).state, 'pending');
});

test('precio conjunto sin desglose se acepta; falta de precio unitario permanece null', () => {
  const book = defaultBook({ declaredBasePrice: 120, components: [
    { id: 't', kind: 'text', name: 'Texto', quantity: 1, unitPrice: null, optional: false },
    { id: 'w', kind: 'workbook', name: 'Cuaderno', quantity: 1, unitPrice: null, optional: false },
  ] });
  assert.equal(basePrice(book), 120); assert.equal(book.components[0].unitPrice, null);
  book.declaredBasePrice = null;
  assert.equal(basePrice(book), null);
  book.components[0].unitPrice = 0; book.components[1].unitPrice = 25;
  book.components.push({ id: 'o', kind: 'other', name: 'Opcional', quantity: 1, unitPrice: 999, optional: true });
  assert.equal(basePrice(book), 25);
});

test('una categoría con pendientes no publica; otra categoría independiente puede quedar lista', () => {
  const state = demoState();
  assert.equal(assessCategory(state, 'MAT-P1').state, 'review');
  assert.deepEqual(assessCategory(state, 'MAT-P1').finalists, []);
  assert.equal(assessCategory(state, 'COM-P1').state, 'ready');
  assert.equal(assessCategory(state, 'COM-P1').finalists.length, 3);
});

test('una oferta con un grado no apto y otro todavía pendiente mantiene bloqueada su categoría', () => {
  const state = fixture(); const offer = state.offers[0];
  const books = state.books.filter(book => book.offerId === offer.id);
  setBookScores(state, books[0], 13);
  state.evaluations.find(evaluation => evaluation.bookId === books[1].id)!.status = 'draft';
  assert.equal(assessOffer(state, offer).state, 'pending');
  assert.equal(assessCategory(state, 'MAT-P1').state, 'review');
});

test('menos de tres aptas no produce finalistas ficticios', () => {
  const state = fixture();
  setOffer(state, state.offers[2], 13); setOffer(state, state.offers[3], 12);
  assert.equal(assessCategory(state, 'MAT-P1').state, 'less_than_three');
  assert.deepEqual(assessCategory(state, 'MAT-P1').finalists, []);
});

test('dos ediciones activas de la misma serie no pueden llenar dos plazas de la terna', () => {
  const state = fixture();
  state.offers.push({ ...state.offers[0], id: 'same-series-another-edition', edition: '2028' });
  assert.equal(assessOffer(state, state.offers[0]).state, 'pending');
  assert.equal(assessCategory(state, 'MAT-P1').state, 'review');
  assert.deepEqual(assessCategory(state, 'MAT-P1').finalists, []);
});

test('I2 resuelve empate en el corte; empate entre dos incluidos no bloquea', () => {
  const state = fixture();
  setOffer(state, state.offers[2], 16, 1); setOffer(state, state.offers[3], 16, 2);
  const assessment = assessCategory(state, 'MAT-P1');
  assert.equal(assessment.state, 'ready');
  assert.equal(assessment.finalists[2], state.offers[3].id);
  setOffer(state, state.offers[0], 18); setOffer(state, state.offers[1], 18);
  setOffer(state, state.offers[2], 16); setOffer(state, state.offers[3], 15);
  assert.equal(assessCategory(state, 'MAT-P1').state, 'ready');
});

test('empate de corte irresuelto no se rompe por orden alfabético o de carga', () => {
  const state = fixture(); setOffer(state, state.offers[3], 16);
  const first = assessCategory(state, 'MAT-P1');
  assert.equal(first.state, 'tie'); assert.deepEqual(first.finalists, []);
  state.offers.reverse();
  const second = assessCategory(state, 'MAT-P1');
  assert.equal(second.state, 'tie'); assert.deepEqual(new Set(second.tied), new Set(first.tied));
});

test('revisión adicional comparable con mismos docentes resuelve solo el empate y conserva notas iniciales', () => {
  const state = fixture(); setOffer(state, state.offers[3], 16);
  const tied = state.offers.slice(2);
  additionalReview(state, tied, [16, 18]);
  const result = assessCategory(state, 'MAT-P1');
  assert.equal(result.state, 'ready'); assert.equal(result.finalists[2], tied[1].id);
  assert.equal(result.ranked.find(item => item.offerId === tied[1].id)!.score, 80);
  assert.equal(result.ranked.find(item => item.offerId === tied[1].id)!.additional, 85);
  assert.equal(result.finalists.length, 3);
});

test('revisión adicional de otros docentes, incompleta, distinta o aún empatada no resuelve el corte', () => {
  for (const scenario of ['other-teacher', 'incomplete', 'different-unit', 'still-tied']) {
    const state = fixture(); setOffer(state, state.offers[3], 16);
    additionalReview(state, state.offers.slice(2), scenario === 'still-tied' ? [18, 18] : [16, 18], scenario !== 'different-unit');
    const additional = state.assignments.filter(assignment => assignment.kind === 'additional');
    if (scenario === 'other-teacher') additional[0].teacherId = 'another-teacher';
    if (scenario === 'incomplete') state.evaluations.find(evaluation => evaluation.assignmentId === additional[0].id)!.status = 'draft';
    assert.equal(assessCategory(state, 'MAT-P1').state, 'tie', scenario);
  }
});

test('valores iniciales no inventan verificaciones; datos ficticios y jornada real están separados', () => {
  const real = emptyState(); const demo = demoState(); const book = defaultBook();
  assert.equal(real.publishers.length, 0); assert.equal(real.evaluations.length, 0);
  assert.equal(real.settings.rules.presentationSeconds, 600); assert.equal(real.settings.rules.transitionSeconds, 120);
  assert.equal(real.settings.eventAt, '2026-11-05T17:00:00-05:00');
  assert.equal(real.settings.rules.lockedAt, null);
  assert.equal(demo.publishers.length, 10);
  assert(demo.series.filter(series => series.publisherId === demo.publishers[0].id).length > 1);
  assert.equal(book.declaredBasePrice, null); assert.deepEqual(book.bimesters, [null, null, null, null]);
  assert(book.checks.every(check => check.status === 'pending'));
  book.checks[0].status = 'pass';
  assert.equal(defaultBook().checks[0].status, 'pending');
  assert.equal(defaultSupportProfile().extraCost, null);
});

test('padrón proyecta origen2026 al grado representado2027 y no deja salir del ámbito', () => {
  assert.equal(sourceToTargetGrade('Inicial 5 años'), 'PRI1');
  assert.equal(sourceToTargetGrade('INI5'), 'PRI1');
  assert.equal(sourceToTargetGrade('1.º de primaria'), 'PRI2');
  assert.equal(sourceToTargetGrade('6.º primaria'), 'SEC1');
  assert.equal(sourceToTargetGrade('SEC2'), 'SEC3');
  assert.equal(sourceToTargetGrade('3.º de secundaria'), null);
});
