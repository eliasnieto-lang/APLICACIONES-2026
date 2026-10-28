import type { CohortRecord, Commitment, Settings, Student } from './types';
import { ACTIVE_BIMESTERS, cohortKey, isReportApproved, normalizeCohort } from './policy';
import { ACADEMIC_CONTEST_LABEL, contestPoints, contestRequiredFields, isAcademicContest } from './contests';

export interface StudentResult {
  a: number | null; b: number | null; c: number | null; total: number | null;
  g: number | null; r: number | null; p: number | null;
  science: number | null; letters: number | null; s1: number | null; s2: number | null; delta: number | null;
  attendance: number | null; punctuality: number | null; ap: number | null; discipline: number | null;
  participation: number | null; family: number | null; participationNA: boolean; familyNA: boolean;
  pa: number; pb: number; pc: number; progress: number;
  academicComplete: boolean; performanceComplete: boolean; commitmentComplete: boolean;
  eligible: boolean; status: string; pending: string[]; areaAverages: Record<string, number | null>;
}
export interface RankedStudent { student: Student; result: StudentResult; position: number; cohort: string }
const levels: Record<string, number> = { AD: 4, A: 3, B: 2, C: 1 };
const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const present = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => present(value) && Number.isInteger(value) && value >= 0;
const percent = (part: number, total: number) => total > 0 ? 100 * part / total : 0;
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const cohortRecordApplies = (record: CohortRecord, student: Pick<Student, 'grade' | 'section'>): boolean => {
  const grade = record.grade.trim();
  const section = record.section.trim().toUpperCase();
  const studentCohort = normalizeCohort(student.grade, student.section);
  const recordCohort = normalizeCohort(grade, section || 'F');
  const gradeMatches = !grade || (studentCohort && recordCohort ? studentCohort.grade === recordCohort.grade : grade === student.grade.trim());
  return Boolean(gradeMatches && (!section || section === student.section.trim().toUpperCase()));
};
export const fmt = (value: number | null): string => value === null || !Number.isFinite(value) ? 'Pendiente' : value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const calculateProgression = (s1: number, s2: number): number => 25 * Math.min(4, Math.max(1, s2 + .5 * (s2 - s1)));
export const calculateTotal = (a: number | null, b: number | null, c: number | null): number | null => a !== null && b !== null && c !== null ? (a + b + c) / 3 : null;

export function validateSettings(settings: Settings): string[] {
  const errors: string[] = [];
  const weights = (name: string, values: number[]) => {
    if (values.some(v => !present(v) || v < 0 || v > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-9) errors.push(`${name}: los pesos deben sumar 100 % y estar entre 0 y 100 %.`);
  };
  weights('Académico', Object.values(settings.academicWeights));
  weights('Desempeño', Object.values(settings.performanceWeights));
  weights('Compromiso', Object.values(settings.commitmentWeights));
  if (!present(settings.scienceWeight) || settings.scienceWeight < 0 || settings.scienceWeight > 1) errors.push('El peso de Ciencias debe estar entre 0 y 100 %.');
  if (!Number.isInteger(settings.year) || settings.year < 2020 || settings.year > 2100) errors.push('El año de evaluación no es válido.');
  if (!settings.version?.trim()) errors.push('La versión del cálculo es obligatoria.');
  if (!settings.areas.length) errors.push('Debe existir al menos un área elegible.');
  if (new Set(settings.areas.map(a => a.id)).size !== settings.areas.length) errors.push('Los identificadores de áreas deben ser únicos.');
  if (settings.areas.some(a => !a.id || !a.name.trim() || !a.competencies.length || a.competencies.some(c => !c.trim()))) errors.push('Cada área debe tener nombre y competencias no vacías.');
  for (const group of ['math', 'science', 'communication', 'social', 'dpcc']) {
    if (settings.areas.filter(a => a.group === group && a.eligible).length !== 1) errors.push(`Se requiere exactamente un área elegible para ${group}.`);
  }
  if (new Set(settings.disciplineTypes.map(t => t.id)).size !== settings.disciplineTypes.length) errors.push('Las categorías disciplinarias deben tener identificadores únicos.');
  if (settings.disciplineTypes.some(t => !t.id || !t.name.trim() || (t.discount !== null && (!present(t.discount) || t.discount < 0 || t.discount > 100)))) errors.push('Cada descuento disciplinario debe estar entre 0 y 100 o quedar sin aprobar.');
  if (!['pending', 'other_component'].includes(settings.naPolicy)) errors.push('La regla de No aplica no es válida.');
  const cohortRecords = settings.cohortRecords ?? [];
  if (new Set(cohortRecords.map(record => record.id)).size !== cohortRecords.length) errors.push('Las convocatorias comunes deben tener identificadores únicos.');
  if (cohortRecords.some(record => !record.id.trim() || !record.name.trim() || !validDate(record.date) || !['institutional', 'family'].includes(record.kind) || typeof record.required !== 'boolean')) errors.push('Cada convocatoria común necesita identificador, nombre, fecha válida, ámbito y condición exigible.');
  return errors;
}

function commitmentResult(records: Commitment[], label: string, pending: string[], templates: CohortRecord[]) {
  if (!records.length && !templates.length) {
    pending.push(`Definir registros de ${label.toLowerCase()} o confirmar explícitamente No aplica.`);
    return { value: null, na: false, complete: false, validated: 0, expected: 1 };
  }
  let valid = 0;
  let complete = true;
  let missing = 0;
  for (const template of templates) {
    if (!records.some(record => record.catalogId === template.id)) {
      missing++;
      complete = false;
      pending.push(`${label}: falta convocatoria común ${template.name} (${template.date}).`);
    }
  }
  for (const record of records) {
    const template = record.catalogId ? templates.find(template => template.id === record.catalogId) : undefined;
    const catalogValid = !record.catalogId || Boolean(template && records.filter(r => r.catalogId === record.catalogId).length === 1 && template.name.trim() === record.name.trim() && template.date === record.date && template.required === record.required);
    if (!catalogValid) pending.push(`${label}: revisar vinculación y datos de convocatoria común ${record.name || record.catalogId}.`);
    const needsJustification = !record.required || ['missed', 'justified', 'na'].includes(record.status);
    const hasEvidence = Boolean(record.evidence?.trim());
    const dataValid = Boolean(catalogValid && record.name.trim() && validDate(record.date) && ['fulfilled', 'missed', 'justified', 'na'].includes(record.status) && hasEvidence && (!needsJustification || record.justification.trim()));
    if (!dataValid) {
      complete = false;
      const details = [needsJustification && !record.justification.trim() ? 'falta justificación' : '', !hasEvidence ? 'falta evidencia' : ''].filter(Boolean);
      pending.push(`${label}: completar ${record.name || 'registro sin nombre'}${details.length ? ` (${details.join('; ')})` : ''}.`);
    } else if (!record.validated) pending.push(`${label}: validar ${record.name}.`);
    if (dataValid && record.validated) valid++;
  }
  const required = records.filter(r => r.required && r.status !== 'justified' && r.status !== 'na');
  const na = complete && required.length === 0;
  return { value: complete && !na ? percent(required.filter(r => r.status === 'fulfilled').length, required.length) : null, na, complete, validated: valid, expected: records.length + missing };
}

function institutionalResult(records: Commitment[], pending: string[], templates: CohortRecord[]) {
  const contests = records.filter(isAcademicContest);
  if (!contests.length) return commitmentResult(records, 'Participación institucional', pending, templates);

  const historical = records.filter(record => !isAcademicContest(record));
  let complete = true;
  let validated = 0;
  for (const record of contests) {
    const missing = contestRequiredFields(record);
    const label = record.name.trim() || ACADEMIC_CONTEST_LABEL;
    if (missing.length) {
      complete = false;
      pending.push(`Participación institucional: completar ${label} (${missing.join('; ')}).`);
    } else if (!record.validated) pending.push(`Participación institucional: validar ${label}.`);
    if (!missing.length && record.validated) validated++;
  }
  if (historical.length) {
    const legacy = commitmentResult(historical, 'Participación institucional', pending, templates.filter(template => historical.some(record => record.catalogId === template.id)));
    pending.push('Participación institucional: clasificar expresamente los registros históricos como concursos académicos antes de combinarlos con la escala local, regional y nacional.');
    return { value: null, na: false, complete: false, validated: validated + legacy.validated, expected: contests.length + legacy.expected };
  }

  // Explicit missed entries score zero; justified and N/A entries keep the common N/A policy.
  // Other optional status values do not add a fourth required field to a contest.
  const counted = contests.filter(record => !['justified', 'na'].includes(record.status));
  const na = complete && counted.length === 0;
  const value = complete && !na ? Math.max(...counted.map(record => record.status === 'missed' ? 0 : contestPoints(record)!)) : null;
  return { value, na, complete, validated, expected: contests.length };
}

export function calculateStudent(student: Student, settings: Settings): StudentResult {
  const pending: string[] = [];
  const configErrors = validateSettings(settings);
  pending.push(...configErrors);
  const reportApproved = isReportApproved(student);
  if (!reportApproved) {
    const noData = student.academic.every(area => area.grades.every(row => row.every(value => !value))) && Object.values(student.attendance).every(value => value === null || value === false) && !student.discipline.confirmed && !student.discipline.incidents.length && !student.institutional.length && !student.family.length;
    pending.push('Confirmar la identidad y la lectura de una libreta PDF antes de evaluar Académico, Desempeño y Compromiso.');
    return {
      a: null, b: null, c: null, total: null, g: null, r: null, p: null,
      science: null, letters: null, s1: null, s2: null, delta: null,
      attendance: null, punctuality: null, ap: null, discipline: null,
      participation: null, family: null, participationNA: false, familyNA: false,
      pa: 0, pb: 0, pc: 0, progress: 0,
      academicComplete: false, performanceComplete: false, commitmentComplete: false,
      eligible: false, status: noData ? 'SIN INICIAR' : 'PENDIENTE DE LIBRETA', pending,
      areaAverages: Object.fromEntries(settings.areas.filter(area => area.eligible).map(area => [area.id, null])),
    };
  }
  const eligibleAreas = settings.areas.filter(a => a.eligible);
  const areaAverages: Record<string, number | null> = {};
  const bimestersByArea: Record<string, (number | null)[]> = {};
  let expectedGrades = 0;
  let validatedGrades = 0;
  let enteredGrades = 0;
  const missingByBimester = ACTIVE_BIMESTERS.map(() => 0);
  for (const area of eligibleAreas) {
    const input = student.academic.find(a => a.areaId === area.id);
    const bimesters: (number | null)[] = [];
    for (let b = 0; b < ACTIVE_BIMESTERS.length; b++) {
      const values: number[] = [];
      for (let c = 0; c < area.competencies.length; c++) {
        expectedGrades++;
        const value = levels[input?.grades[c]?.[b] ?? ''];
        if (value) {
          enteredGrades++;
          values.push(value);
          if (input?.validated) validatedGrades++;
        } else missingByBimester[b]++;
      }
      bimesters.push(values.length === area.competencies.length ? mean(values) : null);
    }
    bimestersByArea[area.id] = bimesters;
    areaAverages[area.id] = bimesters.every(present) ? mean(bimesters as number[]) : null;
    if (!input?.validated) pending.push(`Validar área: ${area.name}.`);
  }
  ACTIVE_BIMESTERS.forEach((label, b) => {
    if (missingByBimester[b]) pending.push(`Faltan ${missingByBimester[b]} notas del ${label} bimestre.`);
  });
  const academicComplete = expectedGrades > 0 && enteredGrades === expectedGrades;
  const allAreaValues = eligibleAreas.map(a => areaAverages[a.id]);
  const g = allAreaValues.length && allAreaValues.every(present) ? 25 * mean(allAreaValues as number[])! : null;
  const grouped = (groups: string[]) => {
    const values = groups.map(group => {
      const area = eligibleAreas.find(a => a.group === group);
      return area ? areaAverages[area.id] : null;
    });
    return values.every(present) ? mean(values as number[]) : null;
  };
  const science = grouped(['math', 'science']);
  const letters = grouped(['communication', 'social', 'dpcc']);
  const r = science !== null && letters !== null ? 25 * (settings.scienceWeight * science + (1 - settings.scienceWeight) * letters) : null;
  const semester = (indices: number[]) => {
    const values = eligibleAreas.map(area => {
      const b = indices.map(i => bimestersByArea[area.id][i]);
      return b.every(present) ? mean(b as number[]) : null;
    });
    return values.length && values.every(present) ? mean(values as number[]) : null;
  };
  const s1 = semester([0, 1]);
  const s2 = semester([2]);
  const delta = s1 !== null && s2 !== null ? s2 - s1 : null;
  const p = s1 !== null && s2 !== null ? calculateProgression(s1, s2) : null;
  const a = academicComplete && g !== null && r !== null && p !== null ? settings.academicWeights.general * g + settings.academicWeights.specialized * r + settings.academicWeights.progress * p : null;

  const at = student.attendance;
  const attendanceFields = [at.required, at.exempted, at.attended, at.punctual];
  const days = count(at.required) && count(at.exempted) ? at.required - at.exempted : null;
  const attendanceValid = attendanceFields.every(count) && days !== null && days > 0 && at.attended! <= days && at.attended! > 0 && at.punctual! <= at.attended!;
  const attendance = attendanceValid ? percent(at.attended!, days!) : null;
  const punctuality = attendanceValid ? percent(at.punctual!, at.attended!) : null;
  const ap = attendance !== null && punctuality !== null ? (attendance + punctuality) / 2 : null;
  const attendanceLabels = ['Días lectivos', 'Días eximidos', 'Días asistidos', 'Ingresos puntuales'];
  attendanceFields.forEach((value, i) => { if (!count(value)) pending.push(`${attendanceLabels[i]}: completar un entero no negativo.`); });
  const attendanceInvalid = attendanceFields.some(v => v !== null && !count(v)) || attendanceFields.every(count) && !attendanceValid;
  if (attendanceInvalid) pending.push('Revisar asistencia: exigibles = lectivos − eximidos, con 0 < asistidos ≤ exigibles y 0 ≤ puntuales ≤ asistidos. Cero días asistidos requiere resolver la excepción, no asignar puntualidad automáticamente.');
  if (!at.validated) pending.push('Asistencia sin validar.');
  let disciplineValid = student.discipline.confirmed;
  let deductions = 0;
  if (!student.discipline.confirmed) pending.push('Disciplina sin validar: confirmar Sin incidencias o revisar el registro.');
  for (const incident of student.discipline.incidents) {
    const type = settings.disciplineTypes.find(t => t.id === incident.typeId);
    if (!type || !incident.verified || !incident.date || !incident.description.trim() || !incident.measure?.trim() || !incident.evidence.trim()) {
      disciplineValid = false;
      pending.push(`Revisar incidencia ${type?.name || 'sin categoría'}: faltan verificación, fecha, descripción, medida o evidencia.`);
    }
    if (type && !type.punctuality) {
      if (type.discount === null || !present(type.discount) || type.discount < 0 || type.discount > 100) {
        disciplineValid = false;
        pending.push(`Definir descuento aprobado para ${type.name}.`);
      } else deductions += type.discount;
    }
  }
  const discipline = disciplineValid ? Math.max(0, 100 - deductions) : null;
  const performanceComplete = attendanceValid && disciplineValid;
  const b = ap !== null && discipline !== null ? settings.performanceWeights.attendance * ap + settings.performanceWeights.discipline * discipline : null;

  const cohortRecords = (settings.cohortRecords ?? []).filter(record => cohortRecordApplies(record, student));
  const pi = institutionalResult(student.institutional, pending, cohortRecords.filter(record => record.kind === 'institutional' && student.institutional.some(input => input.catalogId === record.id)));
  const cf = commitmentResult(student.family, 'Compromiso familiar', pending, cohortRecords.filter(record => record.kind === 'family' && student.family.some(input => input.catalogId === record.id)));
  let c: number | null = pi.value !== null && cf.value !== null ? settings.commitmentWeights.participation * pi.value + settings.commitmentWeights.family * cf.value : null;
  if ((pi.na || cf.na) && pi.complete && cf.complete) {
    if (settings.naPolicy === 'other_component' && settings.naPolicyApproved && !(pi.na && cf.na)) c = pi.na ? cf.value : pi.value;
    else pending.push(pi.na && cf.na ? 'Ambos componentes de Compromiso son No aplica: se requiere resolución institucional; no hay puntaje C.' : 'Resolver y aprobar regla común de No aplica antes de calcular C.');
  }
  const commitmentComplete = pi.complete && cf.complete && c !== null;
  const pa = percent(validatedGrades, expectedGrades);
  const pb = (attendanceValid && at.validated ? 80 : 0) + (disciplineValid ? 20 : 0);
  const pc = percent(pi.validated + cf.validated, pi.expected + cf.expected);
  const progress = (pa + pb + pc) / 3;
  const unresolvedIdentity = (value: string) => !value.trim() || /^(?:por revisar|por definir|sin grado|sin secci[oó]n|desconocido|[-—–])$/i.test(value.trim());
  const identityValid = ![student.code, student.name, student.grade, student.section].some(unresolvedIdentity);
  if (!identityValid) pending.push('Completar código, nombre, grado y sección del estudiante.');
  const cohortValid = Boolean(normalizeCohort(student.grade, student.section));
  if (!cohortValid) pending.push('El grado y sección deben corresponder a 2.º F, 3.º F o 4.º F de secundaria.');
  if (!student.validated.academic) pending.push('Confirmar validación final de Académico.');
  if (!student.validated.performance) pending.push('Confirmar validación final de Desempeño.');
  if (!student.validated.commitment) pending.push('Confirmar validación final de Compromiso.');
  if (!settings.criteriaApproved) pending.push('Confirmar aprobación institucional de los criterios y ponderaciones.');
  const total = calculateTotal(a, b, c);
  const eligible = total !== null && academicComplete && performanceComplete && commitmentComplete && progress === 100 && Object.values(student.validated).every(Boolean) && settings.criteriaApproved && configErrors.length === 0 && identityValid && cohortValid;
  const untouchedCommitments = [...student.institutional, ...student.family].every(record => record.status === 'pending' && !record.validated && !record.justification && !record.evidence);
  const noData = enteredGrades === 0 && attendanceFields.every(v => v === null) && !student.discipline.confirmed && !student.discipline.incidents.length && untouchedCommitments;
  const status = eligible ? 'VALIDADO' : noData ? 'SIN INICIAR' : configErrors.length || attendanceInvalid ? 'CON OBSERVACIONES' : total !== null && progress === 100 ? 'COMPLETO SIN VALIDAR' : 'EN PROCESO';
  return { a, b, c, total, g, r, p, science, letters, s1, s2, delta, attendance, punctuality, ap, discipline, participation: pi.value, family: cf.value, participationNA: pi.na, familyNA: cf.na, pa, pb, pc, progress, academicComplete, performanceComplete, commitmentComplete, eligible, status, pending, areaAverages };
}

/** Competition ranking inside each comparable grade/section; ties use displayed precision. */
export function rankStudents(students: Student[], settings: Settings): RankedStudent[] {
  const rounded = (value: number) => Number(value.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const rows = students.filter(student => normalizeCohort(student.grade, student.section)).map(student => ({ student, result: calculateStudent(student, settings), position: 0, cohort: cohortKey(student.grade, student.section) })).filter(row => row.result.eligible);
  rows.sort((a, b) => a.cohort.localeCompare(b.cohort, 'es', { numeric: true }) || rounded(b.result.total!) - rounded(a.result.total!));
  let cohort = '';
  let previous: number | null = null;
  let index = 0;
  let position = 0;
  for (const row of rows) {
    if (row.cohort !== cohort) { cohort = row.cohort; previous = null; index = 0; }
    index++;
    const score = rounded(row.result.total!);
    if (score !== previous) position = index;
    row.position = position;
    previous = score;
  }
  return rows;
}
