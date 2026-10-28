import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgression, calculateStudent, calculateTotal, cohortRecordApplies, fmt, rankStudents, validateSettings } from '../shared/calculations';
import { createDemoState, createStudent, defaultSettings } from '../shared/defaults';
import type { AppState, CohortRecord, Commitment, PdfRecord, Settings, Student } from '../shared/types';
import { ACTIVE_BIMESTERS, ALLOWED_COHORTS, cohortKey, isReportApproved, normalizeCohort } from '../shared/policy';
import { migrateState } from '../shared/migrations';

const approved = (): Settings => {
  const settings = structuredClone(defaultSettings);
  settings.criteriaApproved = true;
  settings.disciplineTypes.find(t => t.id === 'grave')!.discount = 15;
  return settings;
};
const records = (name: string, n: number, fulfilled: number): Commitment[] => Array.from({ length: n }, (_, i) => ({ id: `${name}-${i}`, name: `${name} ${i}`, date: '2026-06-12', required: true, status: i < fulfilled ? 'fulfilled' : 'missed', justification: i < fulfilled ? '' : 'Incumplimiento documentado en acta', evidence: 'Acta de prueba', validated: true }));
const complete = (settings = approved()): Student => {
  const student = createStudent({ code: '001', name: 'Estudiante de prueba', grade: '3', section: 'F' }, settings);
  student.academic.forEach(a => { a.grades = a.grades.map(() => ['A', 'A', 'A']); a.validated = true; });
  student.attendance = { required: 200, exempted: 0, attended: 190, punctual: 171, validated: true };
  student.discipline = { confirmed: true, incidents: [{ id: 'inc-1', typeId: 'grave', date: '2026-06-12', description: 'Incidencia verificada de prueba', measure: 'Acuerdo formativo registrado en acta', evidence: 'Acta de prueba', verified: true }] };
  student.institutional = records('Actividad', 10, 8);
  student.family = records('Familia', 10, 9);
  student.validated = { academic: true, performance: true, commitment: true };
  student.pdfIds = ['libreta-prueba'];
  student.reportApproval = { pdfId: 'libreta-prueba', approvedAt: '2026-08-12T12:00:00.000Z' };
  return student;
};

test('Una identidad o cohorte por revisar no entra en el ranking aunque tenga puntajes completos', () => {
  for (const value of ['Por revisar', 'Por definir', '—']) {
    const student = complete();
    student.grade = value;
    const result = calculateStudent(student, approved());
    assert.equal(result.eligible, false);
    assert.ok(result.pending.some(message => message.includes('grado y sección')));
  }
});

test('Cartilla: todos los niveles A producen G=R=P=A=75 sin redondeos intermedios', () => {
  const result = calculateStudent(complete(), approved());
  assert.equal(result.g, 75);
  assert.equal(result.r, 75);
  assert.equal(result.p, 75);
  assert.equal(result.a, 75);
  assert.equal(result.science, 3);
  assert.equal(result.letters, 3);
});
test('Cartilla: S1=3 y S2=3,2 produce P=82,50 y estabilidad AD produce 100', () => {
  assert.ok(Math.abs(calculateProgression(3, 3.2) - 82.5) < 1e-12);
  assert.equal(calculateProgression(4, 4), 100);
  assert.equal(calculateProgression(1, 1), 25);
  assert.equal(calculateProgression(4, 1), 25);
  assert.equal(calculateProgression(1, 4), 100);
});
test('Cartilla: asistencia95, puntualidad90, disciplina85 produce B=89,50', () => {
  const result = calculateStudent(complete(), approved());
  assert.equal(result.attendance, 95);
  assert.equal(result.punctuality, 90);
  assert.equal(result.ap, 92.5);
  assert.equal(result.discipline, 85);
  assert.equal(result.b, 89.5);
});
test('Cartilla: participación80 y familia90 produce C=83', () => {
  const result = calculateStudent(complete(), approved());
  assert.equal(result.participation, 80);
  assert.equal(result.family, 90);
  assert.equal(result.c, 83);
});
test('Cartilla: promedio simple 78,76,89,50,83 = 83,75 a precisión de presentación', () => {
  const total = calculateTotal(78.76, 89.5, 83)!;
  assert.ok(Math.abs(total - 83.75333333333333) < 1e-12);
  assert.equal(fmt(total), (83.75).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  assert.equal(calculateTotal(75, 80, null), null);
});
test('Cartilla: falta III bimestre, avance menor100, total pendiente y fuera de ranking', () => {
  const settings = approved();
  const student = complete(settings);
  student.academic.forEach(a => a.grades.forEach(g => { g[2] = ''; }));
  const result = calculateStudent(student, settings);
  assert.equal(result.a, null);
  assert.equal(result.total, null);
  assert.ok(result.pa < 100);
  assert.ok(result.progress < 100);
  assert.ok(result.pending.some(p => /III bimestre/.test(p)));
  assert.equal(rankStudents([student], settings).length, 0);
});
test('Área con más competencias no pesa más; Ciencias y Letras mantienen grupos definidos', () => {
  const settings = approved();
  const student = complete(settings);
  student.academic.find(a => a.areaId === 'matematica')!.grades.forEach(r => r.fill('AD'));
  const result = calculateStudent(student, settings);
  assert.equal(result.g, 80);
  assert.equal(result.science, 3.5);
  assert.equal(result.letters, 3);
  assert.equal(result.r, 82.5);
  assert.ok(Math.abs(result.a! - (80 * .4 + 82.5 * .4 + 80 * .2)) < 1e-12);
});
test('Datos completos sin confirmación final no participan en ranking', () => {
  const settings = approved();
  const student = complete(settings);
  assert.equal(calculateStudent(student, settings).progress, 100);
  assert.equal(calculateStudent(student, settings).eligible, true);
  student.validated.academic = false;
  const result = calculateStudent(student, settings);
  assert.equal(result.progress, 100);
  assert.equal(result.status, 'COMPLETO SIN VALIDAR');
  assert.equal(result.eligible, false);
  assert.equal(rankStudents([student], settings).length, 0);
});
test('Criterios institucionales propuestos no aprobados bloquean ranking pero permiten cálculo provisional', () => {
  const settings = approved(); settings.criteriaApproved = false;
  const result = calculateStudent(complete(settings), settings);
  assert.equal(result.a, 75);
  assert.ok(result.total !== null);
  assert.equal(result.eligible, false);
});
test('Eximidos se excluyen del denominador y tardanzas no se descuentan dos veces', () => {
  const settings = approved();
  const student = complete(settings);
  student.attendance = { required: 210, exempted: 10, attended: 190, punctual: 171, validated: true };
  student.discipline.incidents.push({ id: 'tardanza', typeId: 'tardanza', date: '2026-06-13', description: 'Registro de impuntualidad', measure: 'Registro en control de asistencia, sin descuento adicional', evidence: 'Asistencia', verified: true });
  assert.equal(calculateStudent(student, settings).attendance, 95);
  assert.equal(calculateStudent(student, settings).discipline, 85);
});
test('Asistencia inválida o sin asistencias no inventa puntaje de puntualidad', () => {
  const settings = approved();
  for (const attendance of [
    { required: 100, exempted: 0, attended: 101, punctual: 90, validated: true },
    { required: 100, exempted: 0, attended: 0, punctual: 0, validated: true },
    { required: 100, exempted: 110, attended: 0, punctual: 0, validated: true },
    { required: 100, exempted: 0, attended: 90, punctual: 91, validated: true },
    { required: 100, exempted: 0, attended: -1, punctual: 0, validated: true },
  ]) {
    const student = complete(settings); student.attendance = attendance;
    const result = calculateStudent(student, settings);
    assert.equal(result.b, null);
    assert.equal(result.total, null);
    assert.equal(result.eligible, false);
    assert.equal(result.status, 'CON OBSERVACIONES');
  }
});
test('Disciplina sin confirmar, no verificada o con sanción no aprobada no equivale a100', () => {
  const settings = approved();
  const student = complete(settings);
  student.discipline.confirmed = false;
  assert.equal(calculateStudent(student, settings).discipline, null);
  student.discipline.confirmed = true;
  student.discipline.incidents[0].verified = false;
  assert.equal(calculateStudent(student, settings).discipline, null);
  student.discipline.incidents[0].verified = true;
  settings.disciplineTypes.find(t => t.id === 'grave')!.discount = null;
  assert.equal(calculateStudent(student, settings).discipline, null);
  student.discipline.incidents = [];
  assert.equal(calculateStudent(student, settings).discipline, 100);
});
test('Disciplina nunca baja de0', () => {
  const settings = approved();
  const student = complete(settings);
  student.discipline.incidents = Array.from({ length: 10 }, (_, i) => ({ ...student.discipline.incidents[0], id: String(i) }));
  assert.equal(calculateStudent(student, settings).discipline, 0);
});
test('Incidencia verificada sin medida documentada sigue pendiente', () => {
  const settings = approved();
  const student = complete(settings);
  student.discipline.incidents[0].measure = '';
  const result = calculateStudent(student, settings);
  assert.equal(result.discipline, null);
  assert.equal(result.b, null);
  assert.equal(result.eligible, false);
  assert.ok(result.pending.some(p => p.includes('medida')));
  student.discipline.incidents[0].measure = 'Acuerdo formativo documentado';
  assert.equal(calculateStudent(student, settings).discipline, 85);
});
test('Justificados y no exigibles se excluyen sin asignar0/100 a un componente N/A', () => {
  const settings = approved();
  const student = complete(settings);
  student.institutional = [
    { ...records('Actividad', 1, 1)[0], status: 'justified', justification: 'Eximido por acta' },
    { ...records('Actividad', 1, 1)[0], id: 'otra', required: false, justification: 'No exigible según acta de cohorte' },
  ];
  let result = calculateStudent(student, settings);
  assert.equal(result.participation, null);
  assert.equal(result.participationNA, true);
  assert.equal(result.c, null);
  settings.naPolicy = 'other_component';
  result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  settings.naPolicyApproved = true;
  result = calculateStudent(student, settings);
  assert.equal(result.c, 90);
  assert.equal(result.eligible, true);
  student.family = [{ ...student.institutional[0], id: 'familia' }];
  result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.equal(result.eligible, false);
});
test('Sin registros no significa No aplica; una fila No aplica necesita justificación y validación', () => {
  const settings = approved(); settings.naPolicy = 'other_component'; settings.naPolicyApproved = true;
  const student = complete(settings); student.institutional = [];
  assert.equal(calculateStudent(student, settings).c, null);
  assert.equal(calculateStudent(student, settings).participationNA, false);
  student.institutional = [{ ...records('Acta de no aplicabilidad', 1, 1)[0], status: 'na', justification: '' }];
  assert.equal(calculateStudent(student, settings).c, null);
  student.institutional[0].justification = 'No aplica según acta de cohorte';
  student.institutional[0].validated = false;
  const result = calculateStudent(student, settings);
  assert.equal(result.c, 90);
  assert.ok(result.pc < 100);
  assert.equal(result.eligible, false);
});
test('Ranking descendente agrupado por cohorte, empates compartidos a dos decimales', () => {
  const settings = approved();
  const first = complete(settings); first.name = 'Primero';
  const second = complete(settings); second.id = 'segundo'; second.name = 'Segundo';
  second.attendance = { required: 1000000, exempted: 0, attended: 950000, punctual: 855001, validated: true };
  const third = complete(settings); third.id = 'tercero'; third.attendance.punctual = 160;
  const other = complete(settings); other.id = 'otro'; other.grade = '4';
  const rows = rankStudents([first, second, third, other], settings);
  assert.deepEqual(rows.map(r => r.position), [1, 1, 3, 1]);
  assert.equal(rows[0].cohort, '3.º F');
  assert.equal(rows[3].cohort, '4.º F');
  assert.ok(rows[0].result.total! >= rows[2].result.total!);
});
test('Configuración inválida impide ranking y configuración de base exige aprobación explícita', () => {
  const settings = approved();
  assert.deepEqual(validateSettings(defaultSettings), []);
  assert.equal(defaultSettings.criteriaApproved, false);
  settings.academicWeights.general = .9;
  assert.ok(validateSettings(settings).some(e => /sumar/.test(e)));
  assert.equal(calculateStudent(complete(settings), settings).eligible, false);
  settings.academicWeights.general = .4;
  settings.areas = settings.areas.filter(a => a.group !== 'math');
  assert.ok(validateSettings(settings).some(e => /math/.test(e)));
});
test('Un estudiante nuevo no contiene datos ni valores sustitutos y demo es independiente', () => {
  const student = createStudent({}, defaultSettings);
  const result = calculateStudent(student, defaultSettings);
  assert.equal(result.a, null);
  assert.equal(result.b, null);
  assert.equal(result.c, null);
  assert.equal(result.total, null);
  assert.equal(result.progress, 0);
  assert.equal(result.status, 'SIN INICIAR');
  const demo = createDemoState();
  assert.ok(demo.students.every(s => !calculateStudent(s, demo.settings).eligible));
  assert.ok(demo.students.every(s => !isReportApproved(s) && !s.pdfIds.length));
  assert.ok(demo.students.every(s => !s.institutional.length && !s.family.length));
  assert.deepEqual(new Set(demo.students.map(s => cohortKey(s.grade, s.section))), new Set(ALLOWED_COHORTS.map(c => c.label)));
  assert.ok(demo.students.every(s => s.code.startsWith('DEMO-')));
  assert.equal(defaultSettings.criteriaApproved, false);
});

const commonEvent = (input: Partial<CohortRecord> = {}): CohortRecord => ({ id: 'evento-comun', kind: 'institutional', name: 'Concurso de Ciencias', date: '2026-08-10', grade: '3', section: 'F', required: true, ...input });
const answeredEvent = (event: CohortRecord): Commitment => ({ id: `respuesta-${event.id}`, catalogId: event.id, name: event.name, date: event.date, required: event.required, status: 'fulfilled', justification: '', evidence: 'Acta de participación', validated: true });

test('Convocatorias comunes: grado/sección vacíos aplican a todos y filtros específicos se respetan', () => {
  const student = { grade: '3', section: 'F' };
  assert.equal(cohortRecordApplies(commonEvent(), student), true);
  assert.equal(cohortRecordApplies(commonEvent({ grade: '', section: '' }), student), true);
  assert.equal(cohortRecordApplies(commonEvent({ grade: '4' }), student), false);
  assert.equal(cohortRecordApplies(commonEvent({ section: 'B' }), student), false);
  assert.equal(cohortRecordApplies(commonEvent({ grade: ' 3 ', section: ' F ' }), student), true);
});
test('createStudent deja B y C vacíos aunque existan convocatorias comunes y conserva registros explícitos', () => {
  const settings = approved();
  settings.cohortRecords = [commonEvent(), commonEvent({ id: 'global', kind: 'family', grade: '', section: '' }), commonEvent({ id: 'otro-grado', grade: '4' })];
  const student = createStudent({ code: '002', name: 'Alumno', grade: '3', section: 'F' }, settings);
  assert.deepEqual(student.institutional, []);
  assert.deepEqual(student.family, []);
  assert.deepEqual(student.attendance, { required: null, exempted: null, attended: null, punctual: null, validated: false });
  assert.deepEqual(student.discipline, { confirmed: false, incidents: [] });
  assert.ok(student.academic.every(area => area.grades.every(row => row.length === 3 && row.every(value => value === ''))));
  const manualInstitutional = records('Registro manual', 1, 1);
  const manualFamily = records('Reunión manual', 1, 1);
  const copied = createStudent({ ...student, institutional: manualInstitutional, family: manualFamily }, settings);
  assert.deepEqual(copied.institutional, manualInstitutional);
  assert.deepEqual(copied.family, manualFamily);
});
test('La pauta de referencia solo se exige al vincular manualmente un registro', () => {
  const settings = approved();
  const student = complete(settings);
  settings.cohortRecords = [commonEvent()];
  const result = calculateStudent(student, settings);
  assert.equal(result.c, 83);
  assert.ok(result.total !== null);
  assert.equal(result.pc, 100);
  assert.equal(result.eligible, true);
  assert.ok(result.pending.every(p => !p.includes('falta convocatoria común')));
  student.institutional.push(answeredEvent(settings.cohortRecords[0]));
  const resolved = calculateStudent(student, settings);
  assert.ok(resolved.c !== null);
  assert.equal(resolved.pc, 100);
  assert.equal(resolved.eligible, true);
  student.institutional = []; student.family = [];
  const blank = calculateStudent(student, settings);
  assert.equal(blank.c, null);
  assert.equal(blank.pc, 0);
  assert.ok(blank.pending.every(p => !p.includes('falta convocatoria común')));
});
test('Cambiar nombre, fecha o exigibilidad de un evento común en una ficha no elude la pauta', () => {
  const settings = approved();
  const event = commonEvent();
  settings.cohortRecords = [event];
  for (const patch of [{ name: 'Otro concurso' }, { date: '2026-08-11' }, { required: false }]) {
    const student = complete(settings);
    student.institutional.push({ ...answeredEvent(event), ...patch });
    const result = calculateStudent(student, settings);
    assert.equal(result.c, null);
    assert.ok(result.pc < 100);
    assert.equal(result.eligible, false);
    assert.ok(result.pending.some(p => p.includes('vinculación y datos de convocatoria común')));
  }
});
test('Evento común duplicado o vinculado al ámbito incorrecto no se cuenta dos veces', () => {
  const settings = approved(); const event = commonEvent(); settings.cohortRecords = [event];
  const student = complete(settings);
  student.institutional.push(answeredEvent(event), { ...answeredEvent(event), id: 'duplicado' });
  assert.equal(calculateStudent(student, settings).c, null);
  student.institutional = student.institutional.filter(r => !r.catalogId);
  student.family.push(answeredEvent(event));
  const result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.ok(result.pc < 100);
  assert.equal(result.eligible, false);
});
test('Los eventos comunes no aplicables no se exigen; omitidos o [] conservan compatibilidad', () => {
  const settings = approved();
  const student = complete(settings);
  settings.cohortRecords = [commonEvent({ grade: '4' })];
  assert.equal(calculateStudent(student, settings).c, 83);
  assert.equal(calculateStudent(student, settings).eligible, true);
  settings.cohortRecords = [];
  assert.equal(calculateStudent(student, settings).c, 83);
  delete settings.cohortRecords;
  assert.equal(calculateStudent(student, settings).c, 83);
});
test('Convocatoria común N/A sigue exigiendo su fila, justificación y validación', () => {
  const settings = approved();
  settings.cohortRecords = [commonEvent({ required: false })];
  const student = complete(settings);
  const event = { ...answeredEvent(settings.cohortRecords[0]), status: 'na' as const, justification: 'No exigible según criterio de la cohorte' };
  student.institutional.push(event);
  assert.equal(calculateStudent(student, settings).eligible, true);
  event.validated = false;
  assert.equal(calculateStudent(student, settings).eligible, false);
  assert.ok(calculateStudent(student, settings).pc < 100);
  event.validated = true;
  event.justification = '';
  assert.equal(calculateStudent(student, settings).c, null);
});
test('Pauta común valida ids únicos, nombre y fechas reales', () => {
  const settings = approved(); settings.cohortRecords = [commonEvent()];
  assert.deepEqual(validateSettings(settings), []);
  settings.cohortRecords.push(commonEvent());
  assert.ok(validateSettings(settings).some(e => e.includes('identificadores únicos')));
  for (const event of [commonEvent({ name: '' }), commonEvent({ date: '2026-02-30' }), commonEvent({ date: '' })]) {
    settings.cohortRecords = [event];
    assert.ok(validateSettings(settings).some(e => e.includes('fecha válida')));
  }
});
test('Cumplimiento sin evidencia documentada no produce C ni PC100 ni ranking', () => {
  const settings = approved();
  for (const kind of ['institutional', 'family'] as const) {
    const student = complete(settings);
    student[kind][0].evidence = '   ';
    const result = calculateStudent(student, settings);
    assert.equal(result.c, null);
    assert.equal(result.total, null);
    assert.ok(result.pc < 100);
    assert.ok(result.progress < 100);
    assert.equal(result.eligible, false);
    assert.ok(result.pending.some(p => p.includes('falta evidencia')));
    student[kind][0].evidence = 'Acta de asistencia y cumplimiento';
    assert.equal(calculateStudent(student, settings).eligible, true);
  }
});
test('Un registro no exigible necesita justificación y evidencia para su validación', () => {
  const settings = approved();
  const student = complete(settings);
  student.institutional[0].required = false;
  let result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.ok(result.pc < 100);
  assert.ok(result.pending.some(p => p.includes('falta justificación')));
  student.institutional[0].justification = 'Dispensa aprobada de convocatoria';
  result = calculateStudent(student, settings);
  assert.ok(result.c !== null);
  assert.equal(result.eligible, true);
  student.institutional[0].evidence = '';
  result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.ok(result.pc < 100);
});

test('Un incumplimiento sin observación ni evidencia queda pendiente de evaluación', () => {
  const settings = approved(); const student = complete(settings);
  student.institutional[0].status = 'missed';
  student.institutional[0].justification = '';
  let result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.ok(result.pc < 100);
  assert.ok(result.pending.some(message => message.includes('falta justificación')));
  student.institutional[0].justification = 'No asistió al concurso convocado';
  student.institutional[0].evidence = '';
  result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.ok(result.pending.some(message => message.includes('falta evidencia')));
  student.institutional[0].evidence = 'Lista de asistencia firmada';
  assert.equal(calculateStudent(student, settings).eligible, true);
});

test('Solo se normalizan los grados completos de 2.º F, 3.º F y 4.º F de secundaria', () => {
  assert.deepEqual(ACTIVE_BIMESTERS, ['I', 'II', 'III']);
  for (const [grade, canonical] of [
    ['2', '2.º de secundaria'], [' 2.° de Secundaria ', '2.º de secundaria'], ['segundo grado de secundaria', '2.º de secundaria'],
    ['3ro secundaria', '3.º de secundaria'], ['TERCERO', '3.º de secundaria'], ['tercer grado de educación secundaria', '3.º de secundaria'], ['3.er de secundaria', '3.º de secundaria'], ['4to grado', '4.º de secundaria'], ['cuarto de secundaria', '4.º de secundaria'],
  ]) assert.equal(normalizeCohort(grade, ' f ')?.grade, canonical);
  for (const grade of ['12', '25', '23', '2do primaria', '2.º F', 'pre 3', '3.º de secundaria extra', '2to', '4ro', '3do', '1', '5']) assert.equal(normalizeCohort(grade, 'F'), null, grade);
  for (const section of ['A', 'FF', '2F', '']) assert.equal(normalizeCohort('3', section), null, section);
});

test('El promedio I–II se compara con III y los datos heredados IV no afectan ningún cálculo', () => {
  const settings = approved();
  const student = complete(settings);
  student.academic.forEach(area => area.grades.forEach(row => { row.splice(0, row.length, 'B', 'A', 'AD', 'C'); }));
  const original = structuredClone(student);
  const result = calculateStudent(student, settings);
  assert.equal(result.s1, 2.5);
  assert.equal(result.s2, 4);
  assert.equal(result.delta, 1.5);
  assert.equal(result.g, 75);
  assert.equal(result.r, 75);
  assert.equal(result.p, 100);
  assert.equal(result.a, 80);
  assert.equal(result.pa, 100);
  assert.equal(result.eligible, true);
  assert.ok(result.pending.every(message => !message.includes('IV bimestre')));
  assert.deepEqual(student, original);
  student.academic.forEach(area => area.grades.forEach(row => { row[3] = ''; }));
  assert.deepEqual(calculateStudent(student, settings), result);
  student.academic.forEach(area => area.grades.forEach(row => { row[2] = ''; row[3] = 'AD'; }));
  assert.equal(calculateStudent(student, settings).academicComplete, false);
  assert.equal(calculateStudent(student, settings).s2, null);
});

test('Sin aprobación de PDF no se evalúan A/B/C ni se alteran los registros manuales', () => {
  const settings = approved();
  for (const invalidate of [
    (student: Student) => { delete student.reportApproval; },
    (student: Student) => { student.reportApproval!.approvedAt = 'sin confirmar'; },
    (student: Student) => { student.pdfIds = []; },
  ]) {
    const student = complete(settings);
    invalidate(student);
    const original = structuredClone(student);
    const result = calculateStudent(student, settings);
    assert.equal(isReportApproved(student), false);
    for (const field of ['a', 'b', 'c', 'total', 'g', 'r', 'p', 'attendance', 'punctuality', 'discipline', 'participation', 'family'] as const) assert.equal(result[field], null, field);
    assert.equal(result.progress, 0);
    assert.equal(result.eligible, false);
    assert.equal(rankStudents([student], settings).length, 0);
    assert.ok(result.pending.some(message => message.includes('libreta PDF')));
    assert.deepEqual(student, original);
  }
});

test('Una cohorte no admitida nunca participa del ranking aunque mantenga su expediente', () => {
  const settings = approved();
  for (const [grade, section] of [['5', 'F'], ['3', 'A'], ['12', 'F']]) {
    const student = complete(settings);
    student.grade = grade; student.section = section;
    assert.equal(calculateStudent(student, settings).eligible, false);
    assert.deepEqual(rankStudents([student], settings), []);
    assert.equal(student.grade, grade);
    assert.equal(student.institutional.length, 10);
  }
});

const report = (student: Student, patch: Partial<PdfRecord> = {}): PdfRecord => ({
  id: student.pdfIds[0] ?? 'libreta-prueba', name: 'libreta.pdf', hash: 'hash-prueba', size: 100,
  uploadedAt: '2026-08-12T11:00:00.000Z', status: 'validated', studentId: student.id,
  extractedCode: student.code, extractedName: student.name, extractedGrade: student.grade, extractedSection: student.section,
  period: 'I–III', text: 'Documento real confirmado previamente', ocr: false, warnings: [], areas: structuredClone(student.academic), ...patch,
});
const legacyState = (): AppState => {
  const settings = approved(); delete settings.workflowVersion; delete settings.progressionComparison;
  const student = complete(settings); student.grade = '3ro'; student.section = 'f'; delete student.reportApproval;
  student.academic.forEach(area => area.grades.forEach(row => row.push('C')));
  return { settings, students: [student], pdfs: [report(student)] };
};

test('La migración actualiza el flujo una vez, recupera PDF confirmado y conserva IV y B/C manuales', () => {
  const source = legacyState();
  source.settings.cohortRecords = [commonEvent()];
  source.students[0].pdfIds = [];
  const original = structuredClone(source);
  const result = migrateState(source);
  const student = result.students[0];
  assert.equal(result.settings.workflowVersion, 2);
  assert.equal(result.settings.progressionComparison, 'first_two_vs_third');
  assert.equal(result.settings.criteriaApproved, false);
  assert.equal(student.validated.academic, false);
  assert.equal(student.validated.performance, true);
  assert.equal(student.validated.commitment, true);
  assert.equal(student.grade, '3.º de secundaria');
  assert.equal(student.section, 'F');
  assert.equal(result.settings.cohortRecords?.[0].grade, student.grade);
  assert.equal(result.pdfs[0].extractedGrade, original.pdfs[0].extractedGrade);
  assert.equal(result.pdfs[0].extractedSection, original.pdfs[0].extractedSection);
  assert.deepEqual(student.pdfIds, [result.pdfs[0].id]);
  assert.equal(student.reportApproval?.pdfId, result.pdfs[0].id);
  assert.equal(student.reportApproval?.approvedAt, original.students[0].updatedAt);
  for (const field of ['attendance', 'discipline', 'institutional', 'family', 'academic', 'history'] as const) assert.deepEqual(student[field], original.students[0][field]);
  assert.deepEqual(migrateState(result), result);
  assert.deepEqual(source, original);
  student.validated.academic = true; result.settings.criteriaApproved = true;
  const approvedAgain = migrateState(result);
  assert.equal(approvedAgain.settings.criteriaApproved, true);
  assert.equal(approvedAgain.students[0].validated.academic, true);
});

test('La migración no inventa aprobación para documentos pendientes, ajenos, reemplazados o de otra identidad', () => {
  const changes: ((state: AppState) => void)[] = [
    state => { state.pdfs[0].status = 'review'; },
    state => { state.pdfs[0].status = 'replaced'; },
    state => { state.pdfs[0].studentId = 'otro-estudiante'; },
    state => { state.pdfs[0].extractedCode = 'otro-codigo'; },
    state => { state.pdfs[0].extractedName = 'Otro estudiante'; },
    state => { state.pdfs[0].extractedGrade = '2'; },
    state => { state.pdfs[0].extractedSection = 'A'; },
    state => { state.students[0].grade = '5'; state.pdfs[0].extractedGrade = '5'; },
    state => { state.pdfs = []; },
  ];
  for (const change of changes) {
    const state = legacyState(); change(state);
    const beforeBC = structuredClone({ attendance: state.students[0].attendance, discipline: state.students[0].discipline, institutional: state.students[0].institutional, family: state.students[0].family });
    const result = migrateState(state);
    assert.equal(result.students[0].reportApproval, undefined);
    assert.deepEqual({ attendance: result.students[0].attendance, discipline: result.students[0].discipline, institutional: result.students[0].institutional, family: result.students[0].family }, beforeBC);
    assert.equal(result.students.length, 1);
  }
});

test('La identidad confirmada permite migrar una reasignación explícita y la revocación actual no se recupera', () => {
  const state = legacyState();
  const student = state.students[0];
  state.pdfs[0].confirmedIdentity = { code: student.code, name: student.name, grade: 'tercero de secundaria', section: 'F' };
  state.pdfs[0].extractedCode = 'otro'; state.pdfs[0].extractedName = 'Lectura equivocada';
  const migrated = migrateState(state);
  assert.equal(isReportApproved(migrated.students[0]), true);
  assert.equal(migrated.pdfs[0].confirmedIdentity?.grade, '3.º de secundaria');
  delete migrated.students[0].reportApproval;
  assert.equal(migrateState(migrated).students[0].reportApproval, undefined);
  migrated.students[0].reportApproval = { pdfId: migrated.pdfs[0].id, approvedAt: '2026-08-12T12:00:00.000Z' };
  migrated.pdfs[0].status = 'replaced';
  assert.equal(migrateState(migrated).students[0].reportApproval, undefined);
});

test('Un cierre heredado se reabre una sola vez para revisar el cálculo I–III', () => {
  const state = legacyState(); state.settings.closed = true;
  const beforeBC = structuredClone({ attendance: state.students[0].attendance, discipline: state.students[0].discipline, institutional: state.students[0].institutional, family: state.students[0].family });
  const migrated = migrateState(state);
  assert.equal(migrated.settings.closed, false);
  assert.equal(migrated.settings.criteriaApproved, false);
  assert.deepEqual({ attendance: migrated.students[0].attendance, discipline: migrated.students[0].discipline, institutional: migrated.students[0].institutional, family: migrated.students[0].family }, beforeBC);
  migrated.settings.criteriaApproved = true; migrated.settings.closed = true;
  const reviewed = migrateState(migrated);
  assert.equal(reviewed.settings.closed, true);
  assert.equal(reviewed.settings.criteriaApproved, true);
});

test('La migración de fichas nuevas y demo deja B/C sin registros ni aprobación ficticia', () => {
  const demo = createDemoState(); delete demo.settings.workflowVersion;
  const migrated = migrateState(demo);
  for (const student of migrated.students) {
    assert.equal(student.reportApproval, undefined);
    assert.deepEqual(student.attendance, { required: null, attended: null, punctual: null, exempted: null, validated: false });
    assert.deepEqual(student.discipline, { confirmed: false, incidents: [] });
    assert.deepEqual(student.institutional, []);
    assert.deepEqual(student.family, []);
    assert.equal(calculateStudent(student, migrated.settings).eligible, false);
  }
});
