import type {
  Area, Block, PresentationCategoryAssessment, PresentationEvaluation,
  PresentationPublisherAssessment, Score, State, Teacher,
} from './types.js';
import { AREAS, BLOCKS, type Indicator } from './domain.js';

/** These observations are made during the exposition with the physical text in hand. */
export const PRESENTATION_INDICATORS: Indicator[] = [
  { id: 'I1', label: 'Correspondencia curricular e institucional', a: 'La exposición relaciona la propuesta con los aprendizajes del área y bloque.', b: 'En el ejemplar se reconoce una actividad pertinente para el trabajo del colegio.' },
  { id: 'I2', label: 'Enfoque del área', a: 'Se observa el enfoque del área en la explicación y en una actividad del texto.', b: 'La actividad permite comprender, explicar o producir con sentido.', variants: {
    MAT: { a: 'Presenta una situación que el estudiante debe resolver.', b: 'Invita a representar, explicar, comparar o justificar su procedimiento.' },
    COM: { a: 'Presenta un texto o situación con propósito y destinatario reconocibles.', b: 'Invita a interpretar con sustento, producir o revisar un texto, o adecuar una intervención oral.' },
  } },
  { id: 'I3', label: 'Secuencia y viabilidad del trabajo', a: 'El índice y la explicación permiten reconocer una secuencia de aprendizajes.', b: 'La cantidad y progresión del trabajo observado parecen viables para el bloque.' },
  { id: 'I4', label: 'Rigor y claridad', a: 'La información, los ejemplos y la terminología observados son correctos y comprensibles.', b: 'Las consignas y sus datos son consistentes y permiten entender la tarea.' },
  { id: 'I5', label: 'Calidad cognitiva y transferencia', a: 'Se observa una actividad que ayuda a comprender o practicar con orientación.', b: 'Se observa una oportunidad de aplicar, explicar, argumentar o producir en otra situación.' },
  { id: 'I6', label: 'Evaluación y retroalimentación', a: 'La exposición o el texto permiten reconocer qué se espera de una respuesta o producto.', b: 'Se muestra una orientación concreta para verificar, corregir o mejorar el aprendizaje.' },
  { id: 'I7', label: 'Diversidad y autonomía', a: 'La propuesta muestra apoyos para estudiantes que necesitan acompañamiento.', b: 'Se observa una oportunidad de refuerzo, profundización o trabajo autónomo apropiado.' },
  { id: 'I8', label: 'Legibilidad y uso del ejemplar físico', a: 'La tipografía, los diagramas y la distribución del ejemplar son legibles para la edad.', b: 'Su organización y características físicas facilitan localizar y utilizar el material.' },
  { id: 'I9', label: 'Práctica pertinente y suficiente', a: 'Las actividades revisadas ofrecen práctica pertinente para los aprendizajes presentados.', b: 'La variedad y extensión de la práctica observada permiten un uso razonable en clase y de forma autónoma.' },
  { id: 'I10', label: 'Utilidad de los recursos de apoyo presentados', a: 'Se muestra cómo el docente puede utilizar un recurso de apoyo de la propuesta.', b: 'Se muestra cómo el estudiante puede usar el apoyo para una tarea o para mejorar su aprendizaje.' },
];

export function newPresentationEvaluation(scope: {
  publisherId: string; teacherId: string; area: Area; block: Block; rulesVersion?: number;
}): PresentationEvaluation {
  return {
    id: '', version: 0, publisherId: scope.publisherId, teacherId: scope.teacherId,
    area: scope.area, block: scope.block, rulesVersion: scope.rulesVersion ?? 1,
    scores: Array<Score>(10).fill(null), notes: Array<string>(10).fill(''),
    generalObservation: '', physicalText: '', status: 'draft', closedAt: null, updatedAt: '',
  };
}

/** A missing observation stays pending; it is never silently scored zero. */
export function presentationScore(input: Score[] | PresentationEvaluation): number | null {
  const scores = Array.isArray(input) ? input : input.scores;
  if (!Array.isArray(scores) || scores.length > 10) throw new Error('La ficha de exposición debe contener diez indicadores.');
  if (Array.from(scores).some(score => score !== null && score !== 0 && score !== 1 && score !== 2)) {
    throw new Error('Cada indicador debe ser un entero 0, 1 o 2, o quedar pendiente.');
  }
  return scores.length !== 10 || scores.some(score => score === null)
    ? null : 5 * (scores as number[]).reduce((sum, score) => sum + score, 0);
}

/** Only the ten intentional scores are required. Notes and book identification are optional. */
export function presentationEvaluationIssues(evaluation: PresentationEvaluation): string[] {
  try {
    return presentationScore(evaluation) === null ? ['Complete los diez indicadores con 0, 1 o 2 antes de cerrar.'] : [];
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

function validClosed(evaluation: PresentationEvaluation): boolean {
  return evaluation.status === 'closed' && presentationEvaluationIssues(evaluation).length === 0;
}

export function presentationPublisherAssessment(state: State, publisherId: string, area: Area, block: Block): PresentationPublisherAssessment {
  const teachers = state.teachers.filter(teacher => presentationTeacherInScope(teacher, area, block));
  const available = presentationPublisherAvailable(state, publisherId, area, block);
  const forms = (state.presentationEvaluations ?? []).filter(evaluation => evaluation.publisherId === publisherId
    && evaluation.area === area && evaluation.block === block);
  const closed: PresentationEvaluation[] = [];
  let drafts = 0;
  if (available) for (const teacher of teachers) {
    const own = forms.filter(evaluation => evaluation.teacherId === teacher.id);
    // Duplicate imported records cannot inflate the number of evaluators or silently override a form.
    if (own.length === 1 && validClosed(own[0])) closed.push(own[0]);
    else if (own.some(evaluation => evaluation.status === 'draft')) drafts += 1;
  }
  const registered = available ? teachers.length : 0;
  const pending = registered - closed.length;
  const score = closed.length ? closed.reduce((sum, evaluation) => sum + presentationScore(evaluation)!, 0) / closed.length : null;
  const i2 = closed.length ? closed.reduce((sum, evaluation) => sum + evaluation.scores[1]!, 0) / closed.length : null;
  return {
    publisherId, area, block, registered, closed: closed.length, pending, drafts, score, i2,
    state: registered === 0 || pending > 0 || score === null ? 'pending'
      : score >= state.settings.rules.threshold ? 'eligible' : 'ineligible',
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
  } else if (tied.length) {
    status = 'tie'; reasons.push('Persiste un empate en el corte de tres editoriales después de comparar I2; coordinación debe resolverlo antes de publicar.');
  } else if (eligible.length < 3) {
    status = 'less_than_three';
    reasons.push(eligible.length ? `Solo ${eligible.length} editorial(es) alcanzan el umbral de ${state.settings.rules.threshold} puntos.`
      : `Ninguna editorial alcanza el umbral de ${state.settings.rules.threshold} puntos.`);
  } else status = 'ready';
  if (!pending && registered && !tied.length && eligible.length
    && (state.presentationShortlists ?? []).some(shortlist => shortlist.categoryId === categoryId && shortlist.status === 'published')) status = 'published';
  return { categoryId, area, block, state: status, registered, closed, pending, ranked,
    finalists: tied.length ? [] : eligible.slice(0, 3).map(publisher => publisher.publisherId), tied, reasons };
}

/** Only call on an authorized coordination snapshot; teachers receive their own forms only. */
export function presentationSummary(state: State): PresentationCategoryAssessment[] {
  return AREAS.flatMap(area => BLOCKS.map(block => presentationCategoryAssessment(state, area.id, block.id)));
}
