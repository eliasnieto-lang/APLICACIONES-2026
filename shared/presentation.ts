import type {
  Area, Block, PresentationCategoryAssessment, PresentationEvaluation,
  PresentationPublisherAssessment, PresentationScaleMax, PresentationScore, State, Teacher,
} from './types.js';
import { AREAS, BLOCKS } from './domain.js';

export interface PresentationIndicator {
  id: string; label: string; description: string;
  variants?: Record<Area, { description: string }>;
}

export const PRESENTATION_SCALE: readonly { value: Exclude<PresentationScore, null>; label: string }[] = [
  { value: 0, label: 'Sin valoración' }, { value: 1, label: 'En inicio' },
  { value: 2, label: 'En proceso' }, { value: 3, label: 'Logrado' }, { value: 4, label: 'Destacado' },
];

export function presentationScaleLabel(score: PresentationScore): string {
  return score === null ? 'Pendiente' : PRESENTATION_SCALE.find(item => item.value === score)?.label ?? 'Valor inválido';
}

/** These observations are made during the exposition with the physical text in hand. */
export const PRESENTATION_INDICATORS: PresentationIndicator[] = [
  { id: 'I1', label: 'Correspondencia curricular e institucional', description: 'La exposición y las páginas revisadas muestran aprendizajes pertinentes para el área, el bloque y el proyecto educativo institucional (PEI) del colegio.' },
  { id: 'I2', label: 'Enfoque del área', description: 'Las actividades observadas permiten comprender, explicar y producir de acuerdo con el enfoque del área y el nivel de los estudiantes.', variants: {
    MAT: { description: 'Las situaciones del texto, apropiadas para el grado o ciclo, promueven resolver problemas y representar, explicar, comparar o justificar los procedimientos empleados.' },
    COM: { description: 'Los textos y situaciones, adecuados al grado o ciclo, tienen propósito y destinatario reconocibles y promueven interpretar con sustento, producir o revisar textos y adecuar intervenciones orales.' },
  } },
  { id: 'I3', label: 'Secuencia y viabilidad del trabajo', description: 'El índice, la explicación y las páginas revisadas muestran una secuencia articulada y progresiva de aprendizajes y una cantidad de actividades viable para el bloque.' },
  { id: 'I4', label: 'Rigor y claridad', description: 'En las páginas revisadas, la información, los ejemplos y las consignas son correctos y comprensibles, con redacción y ortografía cuidadas y fuentes identificables cuando corresponde.' },
  { id: 'I5', label: 'Calidad cognitiva y transferencia', description: 'Las actividades ayudan a comprender y practicar y ofrecen oportunidades para aplicar, explicar, argumentar o producir en situaciones diferentes.' },
  { id: 'I6', label: 'Evaluación y retroalimentación', description: 'El material observado permite reconocer qué se espera de las respuestas o productos y ofrece oportunidades de autoevaluación, coevaluación y reflexión sobre el aprendizaje, con orientaciones para verificar, corregir y mejorar.' },
  { id: 'I7', label: 'Diversidad y autonomía', description: 'La propuesta observada atiende la diversidad e inclusión, ofrece apoyos para distintas necesidades y promueve refuerzo, profundización, autonomía y participación colaborativa.' },
  { id: 'I8', label: 'Legibilidad y uso del ejemplar físico', description: 'La tipografía, distribución y organización del ejemplar facilitan la lectura para la edad; los gráficos y diagramas son legibles y cumplen una función pedagógica para comprender y trabajar el contenido.' },
  { id: 'I9', label: 'Práctica pertinente y suficiente', description: 'Las actividades revisadas ofrecen una práctica pertinente, variada y de extensión razonable para los aprendizajes, el tiempo de clase y el trabajo autónomo.' },
  { id: 'I10', label: 'Utilidad de los recursos de apoyo presentados', description: 'Los recursos de apoyo mostrados son utilizables por docentes y estudiantes para desarrollar tareas y mejorar el aprendizaje.' },
];

export function newPresentationEvaluation(scope: {
  publisherId: string; teacherId: string; area: Area; block: Block; rulesVersion?: number;
}): PresentationEvaluation {
  return {
    id: '', version: 0, publisherId: scope.publisherId, teacherId: scope.teacherId,
    area: scope.area, block: scope.block, rulesVersion: scope.rulesVersion ?? 1,
    scaleMax: 4, rubricVersion: 2, responseScore: null, questionVersion: null, scores: Array<PresentationScore>(10).fill(null), notes: Array<string>(10).fill(''),
    generalObservation: '', physicalText: '', status: 'draft', closedAt: null, updatedAt: '',
  };
}

type PresentationScoreInput = Pick<PresentationEvaluation, 'scores' | 'scaleMax' | 'rubricVersion' | 'responseScore' | 'questionVersion'>;

/** Missing metadata always means the old scale, even when every score happens to be 0–2. */
export function presentationEvaluationScaleMax(evaluation: Pick<PresentationEvaluation, 'scaleMax'>): PresentationScaleMax {
  const maximum = evaluation.scaleMax === undefined ? 2 : evaluation.scaleMax;
  if (maximum !== 2 && maximum !== 4) throw new Error('La escala de la ficha debe ser 0–2 o 0–4.');
  return maximum;
}

export function presentationUsesCurrentScale(evaluation: Pick<PresentationEvaluation, 'scaleMax'>): boolean {
  return evaluation.scaleMax === 4;
}

/** Current classification requires the eleventh answer criterion, not merely the 0–4 scale. */
export function presentationUsesCurrentRubric(evaluation: Pick<PresentationEvaluation, 'scaleMax' | 'rubricVersion'>): boolean {
  return evaluation.scaleMax === 4 && evaluation.rubricVersion === 2;
}

export function presentationMaximum(evaluation: Pick<PresentationEvaluation, 'scaleMax' | 'rubricVersion'>): number {
  return presentationUsesCurrentRubric(evaluation) ? 44 : 10 * presentationEvaluationScaleMax(evaluation);
}

/** An explicit zero contributes zero. Only unanswered indicators prevent a complete score. */
export function presentationScore(input: PresentationScore[] | PresentationScoreInput, arrayScaleMax: PresentationScaleMax = 4): number | null {
  const scores = Array.isArray(input) ? input : input.scores;
  const maximum = Array.isArray(input) ? arrayScaleMax : presentationEvaluationScaleMax(input);
  if (maximum !== 2 && maximum !== 4) throw new Error('La escala de la ficha debe ser 0–2 o 0–4.');
  if (!Array.isArray(scores) || scores.length > 10) throw new Error('La ficha de exposición debe contener diez indicadores.');
  if (Array.from(scores).some(score => score !== null && (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > maximum))) {
    throw new Error(`Cada indicador debe ser un entero entre 0 y ${maximum}, o quedar pendiente.`);
  }
  if (!Array.isArray(input) && input.rubricVersion !== undefined && input.rubricVersion !== 2) throw new Error('Versión de rúbrica inválida.');
  const response = !Array.isArray(input) && input.rubricVersion === 2;
  if (response && (maximum !== 4 || input.responseScore !== null && (typeof input.responseScore !== 'number' || !Number.isInteger(input.responseScore) || input.responseScore < 0 || input.responseScore > 4))) throw new Error('La respuesta requiere un entero de 0 a 4 o pendiente.');
  if (scores.length !== 10 || scores.some(score => score === null) || response && input.responseScore === null) return null;
  const total = (scores as number[]).reduce((sum, score) => sum + score, 0) + (response ? input.responseScore! : 0);
  return total * 100 / (response ? 44 : 10 * maximum);
}

/** Notes stay optional; eleven intentional values and the published question are required. */
export function presentationEvaluationIssues(evaluation: PresentationEvaluation): string[] {
  if (!presentationUsesCurrentScale(evaluation)) return ['Pendiente actualizar escala: vuelva a valorar los diez indicadores con la escala de 0 a 4.'];
  if (!presentationUsesCurrentRubric(evaluation)) return ['Pendiente completar la ficha con la pregunta obligatoria. Sus diez puntajes anteriores se conservan.'];
  try {
    if (presentationScore(evaluation) === null) return ['Complete los once criterios con valores de 0 a 4 antes de cerrar.'];
    return Number.isInteger(evaluation.questionVersion) && evaluation.questionVersion! > 0 ? [] : ['Falta confirmar la versión de la pregunta respondida.'];
  } catch (error) { return [error instanceof Error ? error.message : 'Puntajes inválidos.']; }
}

export function presentationTeacherInScope(teacher: Teacher, area: Area, block: Block): boolean {
  return teacher.area === area && Array.isArray(teacher.categories) && teacher.categories.includes(block);
}

/** No catalog is necessary to review a live presentation. An explicit withdrawn offer remains unavailable. */
export function presentationPublisherAvailable(state: State, publisherId: string, area: Area, block: Block): boolean {
  if (!state.publishers.some(publisher => publisher.id === publisherId)) return false;
  const seriesIds = new Set(state.series.filter(series => series.publisherId === publisherId).map(series => series.id));
  const offers = state.offers.filter(offer => seriesIds.has(offer.seriesId));
  return !offers.length || offers.some(offer => offer.status === 'offered' && offer.area === area && offer.block === block);
}

function validClosed(evaluation: PresentationEvaluation, state: State): boolean {
  const question = state.presentationQuestions?.find(item => item.publisherId === evaluation.publisherId && item.status === 'answered');
  return presentationUsesCurrentRubric(evaluation) && evaluation.status === 'closed' && presentationEvaluationIssues(evaluation).length === 0 && question?.version === evaluation.questionVersion;
}

export function presentationPublisherAssessment(state: State, publisherId: string, area: Area, block: Block): PresentationPublisherAssessment {
  const teachers = state.teachers.filter(teacher => presentationTeacherInScope(teacher, area, block));
  const available = presentationPublisherAvailable(state, publisherId, area, block);
  const forms = (state.presentationEvaluations ?? []).filter(evaluation => evaluation.publisherId === publisherId
    && evaluation.area === area && evaluation.block === block);
  const closed: PresentationEvaluation[] = [];
  let drafts = 0;
  let pendingScaleUpdate = 0;
  let pendingQuestionUpdate = 0;
  if (available) for (const teacher of teachers) {
    const own = forms.filter(evaluation => evaluation.teacherId === teacher.id);
    if (own.some(evaluation => !presentationUsesCurrentScale(evaluation))) pendingScaleUpdate += 1;
    if (own.some(evaluation => presentationUsesCurrentScale(evaluation) && !presentationUsesCurrentRubric(evaluation))) pendingQuestionUpdate += 1;
    // Duplicate imported records cannot inflate the number of evaluators or silently override a form.
    if (own.length === 1 && validClosed(own[0], state)) closed.push(own[0]);
    else if (own.some(evaluation => evaluation.status === 'draft')) drafts += 1;
  }
  const registered = available ? teachers.length : 0;
  const pending = registered - closed.length;
  const score = closed.length ? closed.reduce((sum, evaluation) => sum + presentationScore(evaluation)!, 0) / closed.length : null;
  const i2 = closed.length ? closed.reduce((sum, evaluation) => sum + evaluation.scores[1]!, 0) / closed.length : null;
  return {
    publisherId, area, block, registered, closed: closed.length, pending, drafts, pendingScaleUpdate, pendingQuestionUpdate, score, i2,
    state: registered === 0 || pending > 0 || score === null ? 'pending'
      : 'eligible',
  };
}

const sameRank = (a: PresentationPublisherAssessment, b: PresentationPublisherAssessment): boolean => a.score === b.score && a.i2 === b.i2;

export function presentationCategoryAssessment(state: State, area: Area, block: Block): PresentationCategoryAssessment {
  const categoryId = `${area}-${block}`;
  const registered = state.teachers.filter(teacher => presentationTeacherInScope(teacher, area, block)).length;
  const ranked = state.publishers.filter(publisher => presentationPublisherAvailable(state, publisher.id, area, block))
    .map(publisher => presentationPublisherAssessment(state, publisher.id, area, block))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.i2 ?? -1) - (a.i2 ?? -1)
      || a.publisherId.localeCompare(b.publisherId));
  const closed = ranked.reduce((sum, publisher) => sum + publisher.closed, 0);
  const pending = ranked.reduce((sum, publisher) => sum + publisher.pending, 0);
  const pendingScaleUpdate = ranked.reduce((sum, publisher) => sum + (publisher.pendingScaleUpdate ?? 0), 0);
  const pendingQuestionUpdate = ranked.reduce((sum, publisher) => sum + (publisher.pendingQuestionUpdate ?? 0), 0);
  const eligible = ranked.filter(publisher => publisher.state === 'eligible');
  const tied = eligible.length > 3 && sameRank(eligible[2], eligible[3])
    ? eligible.filter(publisher => sameRank(publisher, eligible[2])).map(publisher => publisher.publisherId) : [];
  const reasons: string[] = [];
  let status: PresentationCategoryAssessment['state'];
  if (!registered || !ranked.length || pending) {
    status = 'pending';
    if (!registered) reasons.push('Aún no hay docentes registrados en esta área y bloque.');
    if (!ranked.length) reasons.push('Aún no hay editoriales disponibles para esta área y bloque.');
    if (pending) reasons.push(`Faltan ${pending} fichas de los docentes registrados.`);
    if (pendingScaleUpdate) reasons.push(`${pendingScaleUpdate} ficha(s) pendientes de actualizar a la escala de 0 a 4.`);
    if (pendingQuestionUpdate) reasons.push(`${pendingQuestionUpdate} ficha(s) pendientes de completar con la pregunta obligatoria.`);
  } else if (tied.length) {
    status = 'tie'; reasons.push('Persiste un empate en el corte de tres editoriales después de comparar I2; coordinación debe resolverlo antes de publicar.');
  } else if (eligible.length < 3) {
    status = 'less_than_three';
    reasons.push(`Hay ${eligible.length} editorial(es) con todas sus fichas cerradas; se requieren tres para la votación familiar. No se exige un puntaje mínimo.`);
  } else status = 'ready';
  if (!pending && registered && !tied.length && eligible.length
    && (state.presentationShortlists ?? []).some(shortlist => shortlist.categoryId === categoryId && shortlist.status === 'published' && shortlist.snapshot.scaleMax === 4 && shortlist.snapshot.rubricVersion === 2)) status = 'published';
  return { categoryId, area, block, state: status, registered, closed, pending, pendingScaleUpdate, pendingQuestionUpdate, ranked,
    finalists: tied.length ? [] : eligible.slice(0, 3).map(publisher => publisher.publisherId), tied, reasons };
}

/** Only call on an authorized coordination snapshot; teachers receive their own forms only. */
export function presentationSummary(state: State): PresentationCategoryAssessment[] {
  return AREAS.flatMap(area => BLOCKS.map(block => presentationCategoryAssessment(state, area.id, block.id)));
}
