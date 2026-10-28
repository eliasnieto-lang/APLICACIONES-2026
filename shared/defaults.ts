import type { AppState, Commitment, Grade, Settings, Student } from './types';
import { cohortRecordApplies } from './calculations';

export const defaultSettings: Settings = {
  year: 2027,
  version: '1.0.0 · Cartilla Círculos 2027',
  areas: [
    { id: 'matematica', name: 'Matemática', group: 'math', eligible: true, competencies: ['Resuelve problemas de cantidad', 'Resuelve problemas de regularidad, equivalencia y cambio', 'Resuelve problemas de forma, movimiento y localización', 'Resuelve problemas de gestión de datos e incertidumbre'] },
    { id: 'ciencia', name: 'Ciencia y Tecnología', group: 'science', eligible: true, competencies: ['Indaga mediante métodos científicos', 'Explica el mundo físico', 'Diseña y construye soluciones tecnológicas'] },
    { id: 'comunicacion', name: 'Comunicación', group: 'communication', eligible: true, competencies: ['Se comunica oralmente en su lengua materna', 'Lee diversos tipos de textos', 'Escribe diversos tipos de textos'] },
    { id: 'sociales', name: 'Ciencias Sociales', group: 'social', eligible: true, competencies: ['Construye interpretaciones históricas', 'Gestiona responsablemente el espacio y el ambiente', 'Gestiona responsablemente los recursos económicos'] },
    { id: 'dpcc', name: 'Desarrollo Personal, Ciudadanía y Cívica', group: 'dpcc', eligible: true, competencies: ['Construye su identidad', 'Convive y participa democráticamente'] },
  ],
  academicWeights: { general: .4, specialized: .4, progress: .2 },
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
  activityTypes: ['Concurso académico', 'Actividad institucional', 'Proyecto del Círculo'],
  familyTypes: ['Reunión de familias', 'Citación', 'Acuerdo formalizado'],
  cohortRecords: [],
  closed: false,
};

const newId = () => globalThis.crypto.randomUUID();
export function createStudent(input: Partial<Student>, settings: Settings): Student {
  const now = new Date().toISOString();
  const student: Student = {
    id: input.id ?? newId(), code: input.code ?? '', name: input.name ?? '', grade: input.grade ?? '', section: input.section ?? '',
    academic: input.academic ?? settings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(() => ['', '', '', ''] as Grade[]), validated: false })),
    attendance: input.attendance ?? { required: null, attended: null, punctual: null, exempted: null, validated: false },
    discipline: input.discipline ?? { confirmed: false, incidents: [] },
    institutional: [...(input.institutional ?? [])], family: [...(input.family ?? [])],
    validated: input.validated ?? { academic: false, performance: false, commitment: false },
    history: input.history ?? [], pdfIds: input.pdfIds ?? [], createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now,
  };
  for (const template of settings.cohortRecords ?? []) {
    if (!cohortRecordApplies(template, student)) continue;
    const records = template.kind === 'institutional' ? student.institutional : student.family;
    if (!records.some(record => record.catalogId === template.id)) records.push({ id: newId(), catalogId: template.id, name: template.name, date: template.date, required: template.required, status: 'pending', justification: '', evidence: '', validated: false });
  }
  return student;
}

export function createDemoState(): AppState {
  const settings = structuredClone(defaultSettings);
  settings.criteriaApproved = true;
  settings.disciplineTypes[0].discount = 5;
  settings.disciplineTypes[1].discount = 15;
  settings.disciplineTypes[2].discount = 30;
  settings.cohortRecords = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `demo-actividad-${i + 1}`, kind: 'institutional' as const, name: `Actividad institucional ${i + 1}`, date: `2026-${String(4 + i % 7).padStart(2, '0')}-15`, grade: '', section: '', required: true })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `demo-familia-${i + 1}`, kind: 'family' as const, name: `Reunión familiar ${i + 1}`, date: `2026-${String(4 + i % 7).padStart(2, '0')}-15`, grade: '', section: '', required: true })),
  ];
  const names = ['Valentina Mendoza Torres', 'Mateo Salazar Ríos', 'Luciana Flores Vega', 'Sebastián Quispe León', 'Camila Paredes Soto', 'Nicolás Herrera Díaz', 'Alessia Romero Cruz', 'Gabriel Castro Silva'];
  const makeRecords = (kind: 'institutional' | 'family', fulfilled: number): Commitment[] => settings.cohortRecords!.filter(template => template.kind === kind).map((template, i) => ({ id: newId(), catalogId: template.id, name: template.name, date: template.date, required: template.required, status: i < fulfilled ? 'fulfilled' : 'missed', justification: '', evidence: `Acta ficticia de demostración ${i + 1}`, validated: true }));
  const students = names.map((name, i) => {
    const s = createStudent({ code: `DEMO-${String(i + 1).padStart(3, '0')}`, name, grade: i >= 6 ? '4° secundaria' : '3° secundaria', section: 'A' }, settings);
    s.academic.forEach((area, a) => {
      area.grades = area.grades.map((_, c) => Array.from({ length: 4 }, (__, b) => i === 0 ? ((a + c + b) % 3 === 0 ? 'AD' : 'A') : i === 1 ? (b > 1 ? 'AD' : 'A') : i === 2 ? 'A' : ((a + c + i + b) % 6 === 0 ? 'B' : 'A')));
      area.validated = true;
    });
    s.attendance = { required: 200, exempted: 0, attended: 190 - i * 2, punctual: 180 - i * 3, validated: true };
    s.discipline.confirmed = true;
    s.institutional = makeRecords('institutional', i < 2 ? 5 : 4);
    s.family = makeRecords('family', i === 3 ? 3 : 4);
    s.validated = { academic: true, performance: true, commitment: true };
    if (i === 4) {
      s.academic[0].grades.forEach(row => { row[3] = ''; });
      s.academic[0].validated = false;
      s.validated.academic = false;
    }
    if (i === 5) { s.discipline.confirmed = false; s.validated.performance = false; }
    if (i === 6) { s.family[0].status = 'pending'; s.family[0].validated = false; s.validated.commitment = false; }
    if (i === 7) return createStudent({ id: s.id, code: s.code, name: s.name, grade: s.grade, section: 'B' }, settings);
    return s;
  });
  return { students, settings, pdfs: [] };
}
