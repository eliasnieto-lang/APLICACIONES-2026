import type { Area, Block } from './types.js';

/** Documentary reference only. It never grades the institutional rubric or blocks a ranking. */
export const MINEDU_SOURCE = {
  title: 'Guía metodológica para facilitar la selección de textos escolares en instituciones educativas privadas',
  edition: 2013,
  path: '/referencias/guia-minedu-textos-2013.pdf',
  pageCount: 40,
  guideLevels: [0, 1, 2],
  guideMaximum: 100,
  formalShortlistReference: { points: 70, page: 14 },
  curricularCoverageReference: { percentage: 70, pages: [15, 16, 22] },
  applicationUse: 'informative',
} as const;

export interface MineduGuideIndicator {
  id: number;
  label: string;
  pages: readonly number[];
  pointsByLevel: readonly [number | null, number | null, number | null];
  disqualifyingLevels: readonly number[];
  undefinedLevels: readonly number[];
}

/** Exact values from Matrices A/B. Null needs its accompanying distinction below. */
export const MINEDU_GUIDE_INDICATORS: readonly MineduGuideIndicator[] = [
  { id: 1, label: "El texto escolar presenta información y actividades para el desarrollo de un mínimo del 70% de las capacidades y conocimientos (contenidos temáticos) que el currículo nacional vigente establece para el grado y área curricular, considerando los temas relevantes.", pages: [19, 22], pointsByLevel: [null, 2, 4], disqualifyingLevels: [0], undefinedLevels: [] },
  { id: 2, label: "Enfoque pedagógico del área: indicador 2 de Matriz B.", pages: [19, 31, 33, 34, 36], pointsByLevel: [0, 1.5, 2.5], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 3, label: "Enfoque pedagógico del área: indicador 3 de Matriz B.", pages: [19, 31, 33, 34, 36], pointsByLevel: [0, 1.5, 2.5], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 4, label: "Incluye información, actividades o imágenes que promueven valores y actitudes favorables al respeto a los derechos humanos, la valoración y respeto a la diversidad, la convivencia democrática, el cuidado del ambiente y una cultura de paz.", pages: [19, 22, 23], pointsByLevel: [null, 0, 3], disqualifyingLevels: [0], undefinedLevels: [] },
  { id: 5, label: "El texto no registra ninguna información, actividad o imagen que sugiera o aliente estereotipos y/o formas de exclusión o discriminación por género, religión, discapacidad, grupo étnico, nivel socio económico, lugar de origen, lengua, u otras.", pages: [20, 23], pointsByLevel: [null, null, 3], disqualifyingLevels: [0], undefinedLevels: [1] },
  { id: 6, label: "El texto no registra ninguna información, actividad o imagen que aliente la violencia en cualquiera de sus formas, que contravenga valores éticos y democráticos o atente contra la ley.", pages: [20, 23], pointsByLevel: [null, null, 4], disqualifyingLevels: [0], undefinedLevels: [1] },
  { id: 7, label: "Los contenidos son presentados de manera clara y precisa, con un lenguaje sencillo, comprensible para el estudiante y pertinente al grado al que pertenece.", pages: [20, 24], pointsByLevel: [0, 1.5, 3], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 8, label: "El contenido del texto está adecuadamente dosificado, jerarquizado y considera una paulatina graduación de complejidad, esclareciendo o definiendo términos complejos para facilitar su comprensión.", pages: [20, 24], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 9, label: "El lenguaje empleado guarda corrección lingüística, respetando las reglas de ortografía y gramática del idioma o lengua correspondiente.", pages: [20, 24], pointsByLevel: [null, 2, 4], disqualifyingLevels: [0], undefinedLevels: [] },
  { id: 10, label: "Indica en la página de créditos que la editorial se hace responsable por el rigor académico del contenido del texto, y su correspondencia con los principios de la Educación que establece la Ley General de Educación.", pages: [20, 25], pointsByLevel: [0, 1.5, 3], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 11, label: "El texto presenta las referencias bibliográficas, de internet u otras fuentes utilizadas para su elaboración.", pages: [20, 25], pointsByLevel: [0, null, 4], disqualifyingLevels: [], undefinedLevels: [1] },
  { id: 12, label: "Recomienda fuentes de información para ampliar o profundizar los conocimientos desarrollados en las unidades o capítulos.", pages: [20, 25], pointsByLevel: [0, 2.5, 5], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 13, label: "Incluye una tabla de contenidos detallada y comprensible que presenta como mínimo los conocimientos a desarrollar en cada unidad y las páginas donde se ubican.", pages: [20, 26], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 14, label: "El texto está estructurado en unidades, capítulos u otras formas fácilmente identificables de organización, que muestran una secuencia clara y ordenada.", pages: [20, 26], pointsByLevel: [0, 2.5, 5], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 15, label: "Al inicio de cada unidad o capítulo presenta a los estudiantes los aprendizajes que se espera que logren a lo largo de su desarrollo.", pages: [20, 26], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 16, label: "Incluye contenidos, actividades o recursos diversos que facilitan la recuperación de saberes previos, la construcción de aprendizajes, la transferencia o aplicación práctica de lo aprendido y la profundización o ampliación de los conocimientos.", pages: [20, 27], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 17, label: "Presenta actividades para ser desarrolladas de manera individual, así como grupal o en parejas, que promueven el aprendizaje autónomo de los estudiantes, así como la interacción, comunicación y colaboración.", pages: [20, 27], pointsByLevel: [0, 1.5, 3], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 18, label: "Presenta actividades que promueven la indagación, investigación o producción creativa del estudiante.", pages: [20, 27], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 19, label: "La información y actividades del texto promueven el desarrollo de actitudes reflexivas y el juicio crítico en los estudiantes, en concordancia con el nivel y grado al que pertenecen.", pages: [20, 28], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 20, label: "Incluye preguntas de reflexión, trabajos individuales y grupales u otras actividades de evaluación de diverso tipo (autoevaluación, coevaluación, heteroevaluación) que permiten al estudiante conocer en qué medida está logrando los aprendizajes esperados.", pages: [21, 28], pointsByLevel: [0, 2.5, 5], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 21, label: "El texto incluye actividades de metacognición que le permiten al estudiante reflexionar sobre su proceso de aprendizaje, y promueven el esfuerzo constante para mejorar y valorar sus logros.", pages: [21, 28, 29], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 22, label: "Presenta señalizaciones que ayudan al estudiante y docente a orientarse en el texto (íconos, colores, imágenes y otros símbolos).", pages: [21, 29], pointsByLevel: [0, null, 3], disqualifyingLevels: [], undefinedLevels: [1] },
  { id: 23, label: "El tamaño y tipo de letra empleada facilita su lectura; los contenidos principales están escritos en tamaño de letra adecuado al nivel y grado.", pages: [21, 29], pointsByLevel: [0, 1.5, 3], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 24, label: "Las imágenes y gráficos son nítidas, de alta resolución, tamaño adecuado y además cumplen una función pedagógica en relación con el texto –no solo estética– estando vinculadas a la información o actividades propuestas (motivación, organización o complemento de información, u otras).", pages: [21, 29], pointsByLevel: [0, 1.5, 3], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 25, label: "Presenta advertencias o íconos que indican explícitamente que las actividades, ejercicios o tareas se deben realizar fuera del texto y la recomendación de no escribir en él.", pages: [21, 30], pointsByLevel: [0, 2, 4], disqualifyingLevels: [], undefinedLevels: [] },
  { id: 26, label: "Cuenta con certificación de su calidad física otorgada por una institución reconocida por INDECOPI.", pages: [21, 30], pointsByLevel: [0, null, 3], disqualifyingLevels: [], undefinedLevels: [1] },
  { id: 27, label: "El contenido del texto escolar es concordante y facilita el desarrollo del proyecto educativo o curricular de la institución educativa.", pages: [21, 30], pointsByLevel: [0, 2.5, 5], disqualifyingLevels: [], undefinedLevels: [] },
];

export interface MineduCriterionReference {
  indicatorId: string;
  guideIds: readonly number[];
  pages: readonly number[];
  observation: string;
  qualification?: string;
}

/** References support one institutional observation; they do not merge official scores. */
export const MINEDU_CRITERION_REFERENCES: Readonly<Record<string, MineduCriterionReference>> = {
  I1: { indicatorId: 'I1', guideIds: [27], pages: [30], observation: 'Relacione una actividad con la propuesta educativa del colegio.', qualification: 'La cobertura curricular del indicador 1 de la guía queda pendiente de cotejo.' },
  I2: { indicatorId: 'I2', guideIds: [2, 3], pages: [31, 33, 34, 36], observation: 'Observe una actividad del área y cómo se desarrolla su enfoque pedagógico.' },
  I3: { indicatorId: 'I3', guideIds: [8, 13, 14], pages: [24, 26], observation: 'Revise el índice, la organización de una unidad y la progresión de las actividades.' },
  I4: { indicatorId: 'I4', guideIds: [7, 9, 10, 11], pages: [24, 25], observation: 'Revise claridad, lenguaje, créditos y fuentes en las páginas consultadas.', qualification: 'Registre alertas; el cotejo del texto completo queda pendiente.' },
  I5: { indicatorId: 'I5', guideIds: [16, 18, 19], pages: [27, 28], observation: 'Identifique una actividad de aplicación, indagación, producción o reflexión crítica.' },
  I6: { indicatorId: 'I6', guideIds: [20, 21], pages: [28, 29], observation: 'Observe cómo el estudiante reconoce sus logros y reflexiona sobre su aprendizaje.' },
  I7: { indicatorId: 'I7', guideIds: [4, 5, 17], pages: [22, 23, 27], observation: 'Observe inclusión y oportunidades de trabajo autónomo o colaborativo.', qualification: 'Las alertas se anotan con su página; la revisión integral queda pendiente.' },
  I8: { indicatorId: 'I8', guideIds: [22, 23, 24], pages: [29], observation: 'Revise señalizaciones, letra, nitidez y función pedagógica de las imágenes.' },
  I9: { indicatorId: 'I9', guideIds: [15, 16, 17], pages: [26, 27], observation: 'Observe los aprendizajes previstos y una práctica de aplicación o trabajo autónomo.' },
  I10: { indicatorId: 'I10', guideIds: [12, 16], pages: [25, 27], observation: 'Compruebe un recurso o fuente de apoyo y cómo amplía o aplica el aprendizaje.' },
};

export const MINEDU_PENDING_VERIFICATIONS = [
  { id: 'coverage', label: 'Cobertura curricular por texto, grado y área', detail: 'El 70 % de cobertura curricular requiere un cotejo; es distinto de 70 puntos de calificación.', pages: [15, 16, 22] },
  { id: 'registration', label: 'Inscripción y documentos del texto', detail: 'Corroborar la inscripción OBNATE y la identidad del texto, edición y grado que se revisa.', pages: [15, 19] },
  { id: 'reuse', label: 'Reutilización y calidad física', detail: 'Distinguir texto y cuaderno de trabajo y revisar la certificación física mencionada en la guía.', pages: [15, 30] },
  { id: 'integrity', label: 'Revisión del texto completo', detail: 'Completar el cotejo de inclusión, ausencia de discriminación o violencia y corrección lingüística.', pages: [15, 16] },
  { id: 'commercial', label: 'Condiciones de comercialización', detail: 'Documentar la revisión de prácticas comerciales y de posibles incentivos.', pages: [15] },
  { id: 'committee', label: 'Comité, ficha formal y actas', detail: 'Completar el registro del comité y la revisión formal por texto, edición y grado, con sus actas y firmas.', pages: [12, 13, 16, 19, 20, 21] },
] as const;

const AREA_OBSERVATIONS: Record<'PRIMARY' | 'SECONDARY', Record<Area, { page: number; observation: string }>> = {
  PRIMARY: {
    MAT: { page: 31, observation: 'Observe un problema y el paso de materiales o situaciones concretas a representaciones y procedimientos matemáticos.' },
    COM: { page: 33, observation: 'Observe un texto completo, una situación comunicativa real y una actividad de comprensión o producción.' },
  },
  SECONDARY: {
    MAT: { page: 34, observation: 'Observe un problema contextualizado, su razonamiento y una actividad de indagación o reflexión sobre el procedimiento.' },
    COM: { page: 36, observation: 'Observe estrategias de comprensión y una actividad de producción de textos con intención, coherencia y corrección.' },
  },
};

export function mineduSourceUrl(page?: number): string {
  return page === undefined ? MINEDU_SOURCE.path : `${MINEDU_SOURCE.path}#page=${page}`;
}

export function getMineduIndicatorReference(indicatorId: string, area?: Area, block?: Block): MineduCriterionReference | null {
  if (!Object.hasOwn(MINEDU_CRITERION_REFERENCES, indicatorId)) return null;
  const reference = MINEDU_CRITERION_REFERENCES[indicatorId];
  if (!reference) return null;
  if (indicatorId !== 'I2' || !area || !block) return reference;
  const match = AREA_OBSERVATIONS[block === 'S1' ? 'SECONDARY' : 'PRIMARY'][area];
  return { ...reference, pages: [match.page], observation: match.observation };
}
