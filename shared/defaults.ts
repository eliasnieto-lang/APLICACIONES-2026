import type { AppState, Grade, Settings, Student } from './types';
import { ACTIVE_BIMESTERS, normalizeCohort } from './policy';
import { ACADEMIC_CONTEST_LABEL } from './contests';
import { DEFAULT_DIMENSION_WEIGHTS } from './evaluation-policy';

export const defaultSettings: Settings = {
  year: 2027,
  version: '2.0.0 · Cartilla Círculos 2027 · I–III',
  workflowVersion: 2,
  progressionComparison: 'first_two_vs_third',
  areas: [
    { id: 'matematica', name: 'Matemática', group: 'math', eligible: true, competencies: ['Resuelve problemas de cantidad', 'Resuelve problemas de regularidad, equivalencia y cambio', 'Resuelve problemas de forma, movimiento y localización', 'Resuelve problemas de gestión de datos e incertidumbre'] },
    { id: 'ciencia', name: 'Ciencia y Tecnología', group: 'science', eligible: true, competencies: ['Indaga mediante métodos científicos', 'Explica el mundo físico', 'Diseña y construye soluciones tecnológicas'] },
    { id: 'comunicacion', name: 'Comunicación', group: 'communication', eligible: true, competencies: ['Se comunica oralmente en su lengua materna', 'Lee diversos tipos de textos', 'Escribe diversos tipos de textos'] },
    { id: 'sociales', name: 'Ciencias Sociales', group: 'social', eligible: true, competencies: ['Construye interpretaciones históricas', 'Gestiona responsablemente el espacio y el ambiente', 'Gestiona responsablemente los recursos económicos'] },
    { id: 'dpcc', name: 'Desarrollo Personal, Ciudadanía y Cívica', group: 'dpcc', eligible: true, competencies: ['Construye su identidad', 'Convive y participa democráticamente'] },
  ],
  academicWeights: { general: .4, specialized: .4, progress: .2 },
  dimensionWeights: { ...DEFAULT_DIMENSION_WEIGHTS },
  scienceWeight: .6,
  performanceWeights: { attendance: .6, discipline: .4 },
  commitmentWeights: { participation: .7, family: .3 },
  criteriaApproved: false,
  naPolicy: 'pending',
  naPolicyApproved: false,
  disciplineTypes: [
    { id: 'leve', name: 'Incidencia leve', discount: null, punctuality: false },
    { id: 'grave', name: 'Incidencia grave', discount: null, punctuality: false },
    { id: 'muy-grave', name: 'Incidencia muy grave', discount: null, punctuality: false },
    { id: 'tardanza', name: 'Tardanza (solo puntualidad)', discount: 0, punctuality: true },
  ],
  activityTypes: [ACADEMIC_CONTEST_LABEL],
  familyTypes: ['Reunión de familias', 'Citación', 'Acuerdo formalizado'],
  cohortRecords: [],
  closed: false,
};

const newId = () => globalThis.crypto.randomUUID();
export function createStudent(input: Partial<Student>, settings: Settings): Student {
  const now = new Date().toISOString();
  const cohort = normalizeCohort(input.grade ?? '', input.section ?? '');
  const student: Student = {
    id: input.id ?? newId(), code: input.code ?? '', name: input.name ?? '', grade: cohort?.grade ?? input.grade ?? '', section: cohort?.section ?? input.section ?? '',
    academic: input.academic ?? settings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(() => ACTIVE_BIMESTERS.map(() => '') as Grade[]), validated: false })),
    attendance: input.attendance ?? { required: null, attended: null, punctual: null, exempted: null, validated: false },
    discipline: input.discipline ?? { confirmed: false, incidents: [] },
    institutional: [...(input.institutional ?? [])], family: [...(input.family ?? [])],
    validated: input.validated ?? { academic: false, performance: false, commitment: false },
    commitmentEnabled: input.commitmentEnabled ?? true,
    circleStatus: input.circleStatus ?? 'pending',
    noContestParticipation: input.noContestParticipation ?? false,
    history: input.history ?? [], pdfIds: input.pdfIds ?? [], createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now,
    ...(input.reportApproval ? { reportApproval: input.reportApproval } : {}),
  };
  return student;
}

export function createDemoState(): AppState {
  const settings = structuredClone(defaultSettings);
  settings.disciplineTypes[0].discount = 5;
  settings.disciplineTypes[1].discount = 15;
  settings.disciplineTypes[2].discount = 30;
  const demoCohorts = [['2', 'A'], ['3', 'B'], ['4', 'C'], ['5', 'D']].map(([grade, section]) => normalizeCohort(grade, section)!);
  const names = ['Valentina Mendoza Torres', 'Mateo Salazar Ríos', 'Luciana Flores Vega', 'Sebastián Quispe León', 'Camila Paredes Soto', 'Nicolás Herrera Díaz', 'Alessia Romero Cruz', 'Gabriel Castro Silva'];
  const students = names.map((name, i) => {
    const cohort = demoCohorts[i % demoCohorts.length];
    const s = createStudent({ code: `DEMO-${String(i + 1).padStart(3, '0')}`, name, grade: cohort.grade, section: cohort.section }, settings);
    s.academic.forEach((area, a) => {
      area.grades = area.grades.map((_, c) => ACTIVE_BIMESTERS.map((__, b) => i === 0 ? ((a + c + b) % 3 === 0 ? 'AD' : 'A') : i === 1 ? (b > 1 ? 'AD' : 'A') : i === 2 ? 'A' : ((a + c + i + b) % 6 === 0 ? 'B' : 'A')));
    });
    if (i === 4) {
      s.academic[0].grades.forEach(row => { row[2] = ''; });
    }
    if (i === 7) return createStudent({ id: s.id, code: s.code, name: s.name, grade: s.grade, section: s.section }, settings);
    return s;
  });
  return { students, settings, pdfs: [] };
}
