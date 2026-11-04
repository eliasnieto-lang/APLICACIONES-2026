import type {
  Area, Block, Book, BookAssessment, CategoryAssessment, Evaluation, GradeId,
  Offer, OfferAssessment, PracticeSample, Score, State, SupportProfile, Topic,
} from './types.js';

export const AREAS: { id: Area; label: string }[] = [
  { id: 'MAT', label: 'Matemática' }, { id: 'COM', label: 'Comunicación' },
];
export const GRADES: { id: GradeId; label: string; level: string; number: number; block: Block }[] = [
  { id: 'PRI1', label: '1.º de primaria', level: 'Primaria', number: 1, block: 'P1' },
  { id: 'PRI2', label: '2.º de primaria', level: 'Primaria', number: 2, block: 'P1' },
  { id: 'PRI3', label: '3.º de primaria', level: 'Primaria', number: 3, block: 'P2' },
  { id: 'PRI4', label: '4.º de primaria', level: 'Primaria', number: 4, block: 'P2' },
  { id: 'PRI5', label: '5.º de primaria', level: 'Primaria', number: 5, block: 'P2' },
  { id: 'PRI6', label: '6.º de primaria', level: 'Primaria', number: 6, block: 'P2' },
  { id: 'SEC1', label: '1.º de secundaria', level: 'Secundaria', number: 1, block: 'S1' },
  { id: 'SEC2', label: '2.º de secundaria', level: 'Secundaria', number: 2, block: 'S1' },
  { id: 'SEC3', label: '3.º de secundaria', level: 'Secundaria', number: 3, block: 'S1' },
];
export const BLOCKS: { id: Block; label: string; gradeIds: GradeId[] }[] = [
  { id: 'P1', label: 'P1 · 1.º–2.º de primaria', gradeIds: ['PRI1', 'PRI2'] },
  { id: 'P2', label: 'P2 · 3.º–6.º de primaria', gradeIds: ['PRI3', 'PRI4', 'PRI5', 'PRI6'] },
  { id: 'S1', label: 'S1 · 1.º–3.º de secundaria', gradeIds: ['SEC1', 'SEC2', 'SEC3'] },
];

export interface Indicator {
  id: string; label: string; a: string; b: string;
  variants?: Record<Area, { a: string; b: string }>;
}
export const INDICATORS: Indicator[] = [
  { id: 'I1', label: 'Correspondencia curricular e institucional', a: 'Reconoce un aprendizaje del grado y del área.', b: 'Una tarea verificable lo desarrolla de acuerdo con la programación del colegio.' },
  { id: 'I2', label: 'Enfoque del área', a: 'Aplicar la señal A del área y ajustar la expectativa al grado.', b: 'Aplicar la señal B del área y ajustar la expectativa al grado.', variants: {
    MAT: { a: 'Presenta una situación que el estudiante debe resolver.', b: 'Solicita representar, explicar, comparar o justificar su procedimiento.' },
    COM: { a: 'Ofrece un texto o situación con propósito y destinatario reconocibles.', b: 'Exige interpretar con sustento, producir/revisar un texto o adecuar una intervención oral.' },
  } },
  { id: 'I3', label: 'Programación anual y carga por bimestre/capítulo', a: 'Índice, número de temas por capítulo y distribución en cuatro bimestres contrastables, con origen del mapeo identificado.', b: 'Secuencia y cantidad de temas viables en el tiempo previsto para el grado; el volumen no otorga puntos automáticamente.' },
  { id: 'I4', label: 'Rigor y claridad', a: 'Información, ejemplos y terminología correctos y comprensibles.', b: 'Consignas, datos y respuestas esperadas consistentes, con fuentes donde corresponde.' },
  { id: 'I5', label: 'Calidad cognitiva y transferencia', a: 'Hay trabajo de comprensión o práctica guiada.', b: 'Otra actividad pide aplicar, explicar, argumentar o producir ante una situación distinta.' },
  { id: 'I6', label: 'Evaluación y retroalimentación', a: 'El estudiante puede reconocer qué se espera de su respuesta o producto.', b: 'Dispone de una vía para verificar, corregir o mejorar a partir de orientaciones concretas.' },
  { id: 'I7', label: 'Diversidad y autonomía', a: 'Hay apoyos útiles para quienes necesitan acompañamiento.', b: 'Hay una vía de refuerzo/profundización o una tarea autónoma ajustada al grado.' },
  { id: 'I8', label: 'Legibilidad y diseño físico', a: 'Tipografía, diagramas y distribución legibles para la edad.', b: 'Organización y características del ejemplar permiten localizar y usar el material de forma sostenida.' },
  { id: 'I9', label: 'Cantidad y suficiencia de práctica por tema', a: 'El recuento comprobado ofrece práctica suficiente según la pauta previa del grado/área.', b: 'La práctica se distribuye de forma útil entre los temas muestreados y es realizable en el tiempo de clase y trabajo autónomo. Una producción extensa se distingue de varios ejercicios breves.' },
  { id: 'I10', label: 'Acceso y utilidad de los recursos de apoyo', a: 'El docente puede acceder y efectuar una acción pedagógica concreta con lo incluido.', b: 'El estudiante puede acceder y realizar autónomamente una tarea apropiada. Se valoran las condiciones reales de la plataforma o del equivalente autorizado.' },
];
export const CHECKS: { id: string; label: string }[] = [
  { id: 'incentives', label: 'Ausencia de incentivos' },
  { id: 'obnate', label: 'Registro OBNATE' },
  { id: 'reuse', label: 'Reutilización del texto' },
  { id: 'curriculum', label: 'Cobertura curricular mínima de la guía ministerial' },
  { id: 'rights', label: 'Respeto a derechos, diversidad y convivencia' },
  { id: 'stereotypes', label: 'Ausencia de estereotipos y exclusión' },
  { id: 'law', label: 'Ausencia de promoción de violencia o contenidos contrarios a la ley' },
  { id: 'language', label: 'Corrección lingüística' },
];

const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** A missing response is never converted into a zero, including old eight-indicator records. */
export function scoreEvaluation(input: Score[] | Evaluation): number | null {
  const scores = Array.isArray(input) ? input : input.scores;
  if (!Array.isArray(scores) || scores.length > 10) throw new Error('La ficha debe contener diez indicadores.');
  if (Array.from(scores).some(value => value !== null && value !== 0 && value !== 1 && value !== 2)) {
    throw new Error('Cada indicador debe ser un entero 0, 1 o 2, o quedar pendiente (null).');
  }
  if ((!Array.isArray(input) && input.legacyIndicatorCount !== undefined && input.legacyIndicatorCount < 10)
    || scores.length !== 10 || scores.some(value => value === null)) return null;
  return 5 * (scores as number[]).reduce((sum, value) => sum + value, 0);
}

export function samplePositions(total: number | null): number[] {
  if (!count(total) || total === 0) return [];
  return total < 3 ? Array.from({ length: total }, (_, index) => index + 1) : [1, Math.floor((total + 1) / 2), total];
}

export interface WorkloadSummary {
  source: 'quick' | 'detailed'; bimesters: (number | null)[]; total: number | null;
  chapters: { name: string; count: number | null }[]; uniqueTopics: Topic[];
  samplePositions: number[]; complete: boolean; discrepancies: string[]; reasons: string[];
}
export function workloadSummary(book: Book): WorkloadSummary {
  const reasons: string[] = [];
  const discrepancies: string[] = [];
  const detailed = book.topics.length > 0 || book.workloadMode === 'detailed';
  let bimesters: (number | null)[];
  let total: number | null;
  let chapters: { name: string; count: number | null }[];
  const uniqueTopics: Topic[] = [];
  if (detailed) {
    const keys = new Set<string>();
    const orders = new Set<number>();
    for (const topic of [...book.topics].sort((a, b) => a.order - b.order)) {
      const key = topic.code || topic.id;
      if (!present(key) || keys.has(key)) { reasons.push(`Identificador de tema duplicado o vacío: ${key || '(vacío)'}.`); continue; }
      keys.add(key);
      if (topic.revisitOf && !topic.distinctLesson) {
        if (!book.topics.some(original => (original.id === topic.revisitOf || original.code === topic.revisitOf) && original !== topic && !original.revisitOf)) {
          reasons.push(`El tema retomado ${key} no identifica su tema original.`);
        }
        continue;
      }
      if (!Number.isSafeInteger(topic.order) || topic.order < 1 || orders.has(topic.order)) reasons.push(`Orden anual inválido o repetido en ${key}.`);
      orders.add(topic.order);
      if (!present(topic.name) || !present(topic.chapter) || !present(topic.pages)) reasons.push(`Falta nombre, capítulo o páginas en ${key}.`);
      uniqueTopics.push(topic);
    }
    total = book.topics.length > 0 ? uniqueTopics.length : null;
    const hasUnmapped = uniqueTopics.some(topic => topic.bimester === null || ![1, 2, 3, 4].includes(topic.bimester));
    if (hasUnmapped) reasons.push('La distribución de temas en los cuatro bimestres está pendiente.');
    bimesters = total === null || hasUnmapped ? [null, null, null, null] : [1, 2, 3, 4].map(bimester => uniqueTopics.filter(topic => topic.bimester === bimester).length);
    const chapterNames = [...new Set(uniqueTopics.map(topic => topic.chapter))];
    chapters = chapterNames.map(name => ({ name, count: uniqueTopics.filter(topic => topic.chapter === name).length }));
    if (total === null) reasons.push('Falta el índice detallado de temas.');
    book.bimesters.slice(0, 4).forEach((declared, index) => {
      if (count(declared) && bimesters[index] !== null && declared !== bimesters[index]) {
        discrepancies.push(`B${index + 1}: declaración ${declared}; detalle ${bimesters[index]}.`);
      }
    });
    for (const declared of book.chapters) {
      const actual = chapters.find(chapter => chapter.name === declared.name);
      if (count(declared.topicCount) && declared.topicCount !== (actual?.count ?? 0)) {
        discrepancies.push(`Capítulo ${declared.name}: declaración ${declared.topicCount}; detalle ${actual?.count ?? 0}.`);
      }
    }
  } else {
    bimesters = Array.from({ length: 4 }, (_, index) => count(book.bimesters[index]) ? book.bimesters[index] : null);
    total = bimesters.some(value => value === null) ? null : (bimesters as number[]).reduce((sum, value) => sum + value, 0);
    chapters = book.chapters.map(chapter => ({ name: chapter.name, count: count(chapter.topicCount) ? chapter.topicCount : null }));
    if (total === null) reasons.push('Falta comprobar uno o más totales por bimestre.');
    if (!chapters.length || chapters.some(chapter => chapter.count === null || !present(chapter.name))) reasons.push('Falta el índice por capítulo con sus totales.');
    if (book.chapters.some(chapter => !present(chapter.source))) reasons.push('Falta la fuente del índice por capítulo.');
    if (total !== null && chapters.length && chapters.every(chapter => chapter.count !== null)) {
      const chapterTotal = chapters.reduce((sum, chapter) => sum + chapter.count!, 0);
      if (chapterTotal !== total) discrepancies.push(`Bimestres: ${total}; capítulos: ${chapterTotal}. No se suman ambos desgloses.`);
    }
  }
  if (!present(book.workloadSource)) reasons.push('Falta la fuente de la carga anual.');
  if (bimesters.some(value => value === 0) && !present(book.workloadNote)) reasons.push('Un bimestre comprobado sin temas requiere una observación.');
  if (discrepancies.length && !present(book.workloadNote)) reasons.push('Las discrepancias requieren corrección documentada.');
  return { source: detailed ? 'detailed' : 'quick', bimesters, total, chapters, uniqueTopics, samplePositions: samplePositions(total), complete: reasons.length === 0 && total !== null, discrepancies, reasons };
}

export interface PracticeSummary {
  positions: number[]; samples: PracticeSample[]; complete: boolean; size: number;
  mean: number | null; min: number | null; max: number | null;
  allTopicsMean: number | null; allTopicsKind: 'verified' | 'declared' | null; reasons: string[];
}
export function practiceSummary(book: Book): PracticeSummary {
  const workload = workloadSummary(book);
  const indexKnown = workload.source === 'quick' ? workload.total !== null
    : workload.uniqueTopics.length > 0 && !workload.reasons.some(reason => /Identificador de tema|Orden anual|tema original/.test(reason));
  const positions = indexKnown ? workload.samplePositions : [];
  const reasons: string[] = [];
  const samples: PracticeSample[] = [];
  const findSample = (position: number): PracticeSample | undefined => {
    const topic = workload.uniqueTopics[position - 1];
    const matches = book.practice.filter(sample => topic
      ? (sample.topicId === topic.id || sample.topicId === topic.code)
      : sample.position === position);
    return matches.length === 1 && matches[0].position === position ? matches[0] : undefined;
  };
  const validSample = (sample: PracticeSample): boolean => count(sample.baseCount) && sample.verified
    && present(sample.evidence) && present(sample.topicName) && present(sample.pages);
  if (!positions.length) reasons.push('La muestra está pendiente: falta un índice de orden conocido con temas.');
  for (const position of positions) {
    const sample = findSample(position);
    if (sample) samples.push(sample);
    if (!sample || !validSample(sample)) reasons.push(`Falta el recuento base verificado con evidencia del tema en posición ${position}.`);
  }
  const size = samples.filter(validSample).length;
  const complete = positions.length > 0 && reasons.length === 0;
  const values = complete ? samples.map(sample => sample.baseCount!) : [];
  const all = indexKnown && workload.total !== null && workload.total > 0
    ? Array.from({ length: workload.total }, (_, index) => findSample(index + 1)) : [];
  const allKnown = all.length > 0 && all.every(sample => sample && count(sample.baseCount) && present(sample.topicName) && present(sample.pages));
  const allVerified = allKnown && all.every(sample => sample && validSample(sample));
  return {
    positions, samples, complete, size, mean: complete ? mean(values) : null,
    min: complete ? Math.min(...values) : null, max: complete ? Math.max(...values) : null,
    allTopicsMean: allKnown ? mean(all.map(sample => sample!.baseCount!)) : null,
    allTopicsKind: allKnown ? (allVerified ? 'verified' : 'declared') : null, reasons,
  };
}

export interface SupportScoreConstraints {
  pending: boolean; maximum: 0 | 1 | 2 | null; required: 0 | 1 | null;
  teacher: boolean | null; student: boolean | null; reasons: string[];
}
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function profileFunctional(profile: SupportProfile, label: string, reasons: string[]): boolean | null {
  if (profile.status === 'not_offered' || (profile.status === 'verified' && !profile.included)) return false;
  if (profile.status !== 'verified') { reasons.push(`El apoyo para ${label} sigue pendiente de comprobar.`); return null; }
  if (![profile.access, profile.devices, profile.connection, profile.mobile, profile.offline,
    profile.validity, profile.renewal, profile.support, profile.action, profile.evidence, profile.testedAt].every(present)) {
    reasons.push(`Faltan condiciones de acceso, acción pedagógica, evidencia o fecha de la prueba para ${label}; indique también qué no aplica y por qué.`); return null;
  }
  const action = normalize(profile.action);
  const concreteAction = /(guia|planific|practic|asign|tarea|actividad|resultado|retroaliment|resolv|realiz|correg|leer|produc|unidad|ejercicio|consigna|lectura|aprendiz|sesion de clase)/.test(action);
  const onlyAccess = !concreteAction && /(acceso|ingres|acced|abrir|inicio|login|portada|pagina promocional)/.test(action);
  if (onlyAccess) { reasons.push(`El acceso a una portada no acredita una acción pedagógica para ${label}.`); return null; }
  return true;
}
export function supportScoreConstraints(book: Book): SupportScoreConstraints {
  const reasons: string[] = [];
  if (book.supportKind === 'none' && ['verified', 'not_offered'].includes(book.supportStatus)) {
    return { pending: false, maximum: 0, required: 0, teacher: false, student: false, reasons: ['Ausencia de apoyo complementario confirmada: I10 = 0.'] };
  }
  if (book.supportStatus !== 'verified' || book.supportKind === 'none' || (book.supportKind === 'equivalent' && !book.equivalentAuthorized)) {
    return { pending: true, maximum: null, required: null, teacher: null, student: null,
      reasons: [book.supportKind === 'equivalent' && !book.equivalentAuthorized ? 'El equivalente requiere autorización previa del colegio.' : 'La prestación ofrecida sigue pendiente de verificar.'] };
  }
  const teacher = profileFunctional(book.teacherSupport, 'docente', reasons);
  const student = profileFunctional(book.studentSupport, 'estudiante', reasons);
  const pending = teacher === null || student === null;
  const maximum = pending ? null : (Number(teacher) + Number(student)) as 0 | 1 | 2;
  return { pending, maximum, required: maximum === 0 ? 0 : maximum === 1 ? 1 : null, teacher, student, reasons };
}

export function basePrice(book: Book): number | null {
  if (typeof book.declaredBasePrice === 'number' && Number.isFinite(book.declaredBasePrice) && book.declaredBasePrice >= 0) return book.declaredBasePrice;
  const base = book.components.filter(component => !component.optional);
  if (!base.length || base.some(component => !count(component.quantity) || component.quantity < 1
    || component.unitPrice === null || !Number.isFinite(component.unitPrice) || component.unitPrice < 0)) return null;
  return base.reduce((sum, component) => sum + component.quantity * component.unitPrice!, 0);
}

export function sourceToTargetGrade(source: string): GradeId | null {
  const value = normalize(source).replace(/[.º°ª]/g, '').replace(/\s+/g, ' ');
  if (/^(ini5|inicial ?5(?: anos)?|5 ?anos|5 de inicial|inicial de 5 anos)$/.test(value)) return 'PRI1';
  const coded = /^(pri|sec)([1-6])$/.exec(value);
  const word = /([1-6])(?:ro|do|to|er)?\s*(?:de\s*)?(primaria|secundaria)/.exec(value)
    ?? /(primaria|secundaria)\s*([1-6])/.exec(value);
  let level: string | undefined;
  let grade: number | undefined;
  if (coded) { level = coded[1] === 'pri' ? 'primaria' : 'secundaria'; grade = Number(coded[2]); }
  else if (word) {
    if (/^\d$/.test(word[1])) { grade = Number(word[1]); level = word[2]; }
    else { level = word[1]; grade = Number(word[2]); }
  }
  if (level === 'primaria' && grade !== undefined) return grade === 6 ? 'SEC1' : `PRI${grade + 1}` as GradeId;
  if (level === 'secundaria' && grade !== undefined && grade < 3) return `SEC${grade + 1}` as GradeId;
  return null;
}

function initialEvaluations(state: State, book: Book): { evaluations: Evaluation[]; reasons: string[] } {
  const assignments = state.assignments.filter(assignment => assignment.bookId === book.id && assignment.kind === 'initial');
  const reasons: string[] = [];
  if (assignments.length !== 2 || new Set(assignments.map(assignment => assignment.teacherId)).size !== 2) {
    reasons.push('Se requieren dos asignaciones iniciales de docentes distintos.');
  }
  const evaluations: Evaluation[] = [];
  for (const assignment of assignments) {
    const matches = state.evaluations.filter(evaluation => evaluation.assignmentId === assignment.id);
    const evaluation = matches.length === 1 ? matches[0] : undefined;
    if (!evaluation || evaluation.bookId !== book.id || evaluation.teacherId !== assignment.teacherId || evaluation.status !== 'closed') {
      reasons.push(`Falta una ficha cerrada de la asignación ${assignment.id}.`); continue;
    }
    const invalid = evaluationReasons(state, book, evaluation);
    if (invalid.length) reasons.push(...invalid); else evaluations.push(evaluation);
  }
  return { evaluations, reasons };
}
function evaluationReasons(state: State, book: Book, evaluation: Evaluation): string[] {
  const reasons: string[] = [];
  if (evaluation.bookVersion !== book.version) reasons.push('La ficha corresponde a otra versión del título o edición.');
  if (evaluation.rulesVersion !== state.settings.rules.version) reasons.push('La ficha corresponde a otra versión de las reglas.');
  try { if (scoreEvaluation(evaluation) === null) reasons.push('La ficha tiene indicadores pendientes, incluidos los de versiones históricas.'); }
  catch { reasons.push('La ficha contiene puntajes inválidos.'); }
  if (evaluation.evidence.length !== 10 || evaluation.evidence.some(value => !present(value))) reasons.push('Falta la referencia de evidencia de uno o más indicadores.');
  if (evaluation.objection && !present(evaluation.objectionDetail)) reasons.push('La objeción de la ficha requiere detalle.');
  const support = supportScoreConstraints(book);
  if (support.pending) reasons.push('I10 requiere cerrar la verificación del apoyo.');
  else if (evaluation.scores[9] !== null && (evaluation.scores[9]! > support.maximum!
    || (support.required !== null && evaluation.scores[9] !== support.required))) reasons.push('I10 no coincide con los perfiles de apoyo acreditados.');
  return reasons;
}

export function assessBook(state: State, bookOrId: Book | string): BookAssessment {
  const book = typeof bookOrId === 'string' ? state.books.find(item => item.id === bookOrId) : bookOrId;
  const result: BookAssessment = { bookId: typeof bookOrId === 'string' ? bookOrId : bookOrId.id, state: 'pending', score: null, i2: null, reasons: [] };
  if (!book || !book.active) return { ...result, state: 'not_offered', reasons: ['Sin oferta para el grado.'] };
  const offer = state.offers.find(item => item.id === book.offerId);
  if (!offer || offer.status === 'withdrawn') return { ...result, state: 'not_offered', reasons: ['La oferta fue retirada o no está registrada.'] };
  const reasons = result.reasons;
  if (!GRADES.some(grade => grade.id === book.gradeId && grade.block === offer.block)) reasons.push('El grado no pertenece al bloque de la oferta.');
  if (!present(book.title) || !present(book.edition) || book.edition !== offer.edition) reasons.push('Título o edición pendiente o distinto de la oferta.');
  let failed = false;
  CHECKS.forEach((check, index) => {
    const verification = book.checks[index];
    if (verification?.status === 'fail') { failed = true; reasons.push(`Incumplimiento: ${check.label}.`); }
    else if (verification?.status !== 'pass' || !present(verification.evidence)) reasons.push(`Filtro pendiente: ${check.label}.`);
  });
  if (book.checks.length !== CHECKS.length) reasons.push('Se requieren las ocho comprobaciones ministeriales.');
  if (!present(book.ministerialReference)) reasons.push('Falta identificar la ficha ministerial aplicable.');
  if (!present(book.obnate) || !present(book.obnateSource)) reasons.push('Falta registro OBNATE o referencia de comprobación.');
  if (!book.dossierClosed || !present(book.dossierReference)) reasons.push('El expediente común no está cerrado con referencia.');
  if (book.priceStatus !== 'verified' || basePrice(book) === null || !present(book.priceSource) || !present(book.priceValidity)) reasons.push('Falta verificar precio base, fuente o vigencia.');
  const workload = workloadSummary(book);
  if (book.workloadStatus !== 'verified' || !workload.complete) reasons.push('Falta cerrar la carga anual.', ...workload.reasons);
  const practice = practiceSummary(book);
  if (book.practiceStatus !== 'verified' || !practice.complete) reasons.push('Falta cerrar la muestra de práctica.', ...practice.reasons);
  if (!present(state.settings.rules.practiceGuidelines[`${offer.area}-${book.gradeId}`])) reasons.push('Falta la pauta previa de práctica suficiente del grado y área.');
  const support = supportScoreConstraints(book);
  if (support.pending) reasons.push(...support.reasons);
  const initial = initialEvaluations(state, book);
  reasons.push(...initial.reasons);
  if (initial.evaluations.length === 2 && initial.reasons.length === 0) {
    result.score = mean(initial.evaluations.map(evaluation => scoreEvaluation(evaluation)!));
    result.i2 = mean(initial.evaluations.map(evaluation => evaluation.scores[1]!));
    if (result.score < state.settings.rules.threshold) { failed = true; reasons.push(`Nota ${result.score}/100 inferior al corte ${state.settings.rules.threshold}/100.`); }
  }
  result.state = failed ? 'ineligible' : reasons.length ? 'pending' : 'eligible';
  return result;
}

function additionalForReview(state: State, offer: Offer, reviewId: string, grades: BookAssessment[]): number | null {
  const values: number[] = [];
  for (const grade of grades) {
    if (grade.score === null || grade.state !== 'eligible') return null;
    const book = state.books.find(item => item.id === grade.bookId)!;
    const initial = state.assignments.filter(assignment => assignment.bookId === book.id && assignment.kind === 'initial');
    const assignments = state.assignments.filter(assignment => assignment.bookId === book.id && assignment.kind === 'additional' && assignment.reviewId === reviewId);
    if (assignments.length !== 2 || new Set(assignments.map(assignment => assignment.teacherId)).size !== 2
      || assignments.some(assignment => !initial.some(original => original.teacherId === assignment.teacherId))) return null;
    const scores: number[] = [];
    for (const assignment of assignments) {
      const matches = state.evaluations.filter(evaluation => evaluation.assignmentId === assignment.id && evaluation.status === 'closed'
        && evaluation.bookId === book.id && evaluation.teacherId === assignment.teacherId);
      if (matches.length !== 1 || evaluationReasons(state, book, matches[0]).length) return null;
      scores.push(scoreEvaluation(matches[0])!);
    }
    values.push((grade.score + mean(scores)) / 2);
  }
  return values.length === BLOCKS.find(block => block.id === offer.block)?.gradeIds.length ? mean(values) : null;
}
export function assessOffer(state: State, offerOrId: Offer | string): OfferAssessment {
  const offer = typeof offerOrId === 'string' ? state.offers.find(item => item.id === offerOrId) : offerOrId;
  const result: OfferAssessment = { offerId: typeof offerOrId === 'string' ? offerOrId : offerOrId.id,
    state: 'pending', score: null, i2: null, additional: null, reasons: [], grades: [] };
  if (!offer) return { ...result, reasons: ['La oferta no existe.'] };
  if (offer.status === 'withdrawn') return { ...result, state: 'withdrawn', reasons: [`Oferta retirada: ${offer.withdrawalReason || 'motivo pendiente'}.`] };
  if (state.offers.some(other => other.id !== offer.id && other.status === 'offered' && other.seriesId === offer.seriesId
    && other.area === offer.area && other.block === offer.block)) {
    return { ...result, reasons: ['Hay más de una oferta activa de la misma serie en esta categoría. Retire la edición sustituida antes de clasificar.'] };
  }
  const block = BLOCKS.find(item => item.id === offer.block);
  if (!block) return { ...result, reasons: ['Bloque inválido.'] };
  for (const gradeId of block.gradeIds) {
    const books = state.books.filter(book => book.offerId === offer.id && book.gradeId === gradeId && book.active);
    const assessment = books.length === 1 ? assessBook(state, books[0]) : {
      bookId: '', state: books.length ? 'pending' as const : 'not_offered' as const,
      score: null, i2: null, reasons: [books.length ? 'Hay más de un título activo para el grado.' : 'Sin oferta para el grado.'],
    };
    result.grades.push(assessment);
    const label = GRADES.find(grade => grade.id === gradeId)!.label;
    result.reasons.push(...assessment.reasons.map(reason => `${label}: ${reason}`));
  }
  if (result.grades.every(grade => grade.score !== null)) {
    result.score = mean(result.grades.map(grade => grade.score!));
    result.i2 = mean(result.grades.map(grade => grade.i2!));
  }
  result.state = result.grades.some(grade => grade.state === 'pending') ? 'pending'
    : result.grades.some(grade => grade.state === 'ineligible') ? 'ineligible'
      : result.grades.some(grade => grade.state === 'not_offered') ? 'ineligible' : 'eligible';
  const reviews = state.reviews.filter(review => review.categoryId === `${offer.area}-${offer.block}` && review.offerIds.includes(offer.id) && present(review.unitReference) && present(review.reason));
  const review = reviews.at(-1);
  if (review) result.additional = additionalForReview(state, offer, review.id, result.grades);
  return result;
}

export function assessCategory(state: State, categoryId: string): CategoryAssessment {
  const [area, block] = categoryId.split('-');
  const ranked = state.offers.filter(offer => offer.area === area && offer.block === block).map(offer => assessOffer(state, offer));
  const result: CategoryAssessment = { categoryId, state: 'review', ranked, finalists: [], tied: [], reasons: [] };
  if (!AREAS.some(item => item.id === area) || !BLOCKS.some(item => item.id === block)) return { ...result, reasons: ['Categoría inválida.'] };
  const eligible = ranked.filter(offer => offer.state === 'eligible');
  const compare = (a: OfferAssessment, b: OfferAssessment) => b.score! - a.score! || b.i2! - a.i2!;
  eligible.sort(compare);
  const others = ranked.filter(offer => offer.state !== 'eligible');
  result.ranked = [...eligible, ...others];
  if (ranked.some(offer => offer.state === 'pending')) return { ...result, reasons: ['Hay ofertas pendientes en esta categoría. Complete sus verificaciones y fichas antes de publicar.'] };
  if (eligible.length < 3) return { ...result, state: 'less_than_three', reasons: [`Solo hay ${eligible.length} opciones comunes aptas. Examine alternativas por grado e incidencias documentadas.`] };
  if (eligible.length > 3 && compare(eligible[2], eligible[3]) === 0) {
    const boundary = eligible.filter(offer => compare(offer, eligible[2]) === 0);
    const ids = boundary.map(offer => offer.offerId);
    const sharedReview = state.reviews.filter(review => review.categoryId === categoryId && ids.every(id => review.offerIds.includes(id))
      && present(review.unitReference) && present(review.reason)).at(-1);
    if (sharedReview) {
      const reviewed = new Map(ids.map(id => {
        const offer = state.offers.find(item => item.id === id)!;
        const assessment = boundary.find(item => item.offerId === id)!;
        return [id, additionalForReview(state, offer, sharedReview.id, assessment.grades)] as const;
      }));
      if ([...reviewed.values()].every(value => value !== null)) {
        eligible.sort((a, b) => compare(a, b) || (reviewed.has(a.offerId) && reviewed.has(b.offerId) ? reviewed.get(b.offerId)! - reviewed.get(a.offerId)! : 0));
        result.ranked = [...eligible, ...others];
        for (const item of boundary) item.additional = reviewed.get(item.offerId)!;
        if (reviewed.get(eligible[2].offerId) !== reviewed.get(eligible[3].offerId)) {
          result.state = 'ready'; result.finalists = eligible.slice(0, 3).map(offer => offer.offerId);
        } else result.tied = boundary.filter(offer => reviewed.get(offer.offerId) === reviewed.get(eligible[2].offerId)).map(offer => offer.offerId);
      }
    }
    if (result.state !== 'ready') return { ...result, state: 'tie', tied: result.tied.length ? result.tied : ids,
      reasons: ['Empate en la última plaza tras comparar I2. Se requiere revisión adicional comparable por los mismos docentes; el empate irresuelto impide publicar.'] };
  } else { result.state = 'ready'; result.finalists = eligible.slice(0, 3).map(offer => offer.offerId); }
  const published = state.shortlists.filter(shortlist => shortlist.categoryId === categoryId && shortlist.scope === 'block' && shortlist.status === 'published').at(-1);
  if (published) { result.state = 'published'; result.finalists = [...published.offerIds]; }
  return result;
}
