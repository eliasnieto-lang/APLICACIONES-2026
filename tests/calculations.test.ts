import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgression, calculateStudent, calculateTotal, cohortRecordApplies, fmt, rankStudents, validateSettings } from '../shared/calculations';
import { createDemoState, createStudent, defaultSettings } from '../shared/defaults';
import type { CohortRecord, Commitment, Settings, Student } from '../shared/types';

const approved = (): Settings => {
  const settings = structuredClone(defaultSettings);
  settings.criteriaApproved = true;
  settings.disciplineTypes.find(t => t.id === 'grave')!.discount = 15;
  return settings;
};
const records = (name: string, n: number, fulfilled: number): Commitment[] => Array.from({ length: n }, (_, i) => ({ id: `${name}-${i}`, name: `${name} ${i}`, date: '2026-06-12', required: true, status: i < fulfilled ? 'fulfilled' : 'missed', justification: '', evidence: 'Acta de prueba', validated: true }));
const complete = (settings = approved()): Student => {
  const student = createStudent({ code: '001', name: 'Estudiante de prueba', grade: '3', section: 'A' }, settings);
  student.academic.forEach(a => { a.grades = a.grades.map(() => ['A', 'A', 'A', 'A']); a.validated = true; });
  student.attendance = { required: 200, exempted: 0, attended: 190, punctual: 171, validated: true };
  student.discipline = { confirmed: true, incidents: [{ id: 'inc-1', typeId: 'grave', date: '2026-06-12', description: 'Incidencia verificada de prueba', measure: 'Acuerdo formativo registrado en acta', evidence: 'Acta de prueba', verified: true }] };
  student.institutional = records('Actividad', 10, 8);
  student.family = records('Familia', 10, 9);
  student.validated = { academic: true, performance: true, commitment: true };
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
test('Cartilla: falta IV bimestre, avance menor100, total pendiente y fuera de ranking', () => {
  const settings = approved();
  const student = complete(settings);
  student.academic.forEach(a => a.grades.forEach(g => { g[3] = ''; }));
  const result = calculateStudent(student, settings);
  assert.equal(result.a, null);
  assert.equal(result.total, null);
  assert.ok(result.pa < 100);
  assert.ok(result.progress < 100);
  assert.ok(result.pending.some(p => /IV bimestre/.test(p)));
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
  const other = complete(settings); other.id = 'otro'; other.section = 'B';
  const rows = rankStudents([first, second, third, other], settings);
  assert.deepEqual(rows.map(r => r.position), [1, 1, 3, 1]);
  assert.equal(rows[0].cohort, '3 · A');
  assert.equal(rows[3].cohort, '3 · B');
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
  assert.ok(demo.students.some(s => calculateStudent(s, demo.settings).eligible));
  assert.ok(demo.students.some(s => !calculateStudent(s, demo.settings).eligible));
  assert.ok(demo.students.every(s => s.code.startsWith('DEMO-')));
  assert.equal(defaultSettings.criteriaApproved, false);
});

const commonEvent = (input: Partial<CohortRecord> = {}): CohortRecord => ({ id: 'evento-comun', kind: 'institutional', name: 'Concurso de Ciencias', date: '2026-08-10', grade: '3', section: 'A', required: true, ...input });
const answeredEvent = (event: CohortRecord): Commitment => ({ id: `respuesta-${event.id}`, catalogId: event.id, name: event.name, date: event.date, required: event.required, status: 'fulfilled', justification: '', evidence: 'Acta de participación', validated: true });

test('Convocatorias comunes: grado/sección vacíos aplican a todos y filtros específicos se respetan', () => {
  const student = { grade: '3', section: 'A' };
  assert.equal(cohortRecordApplies(commonEvent(), student), true);
  assert.equal(cohortRecordApplies(commonEvent({ grade: '', section: '' }), student), true);
  assert.equal(cohortRecordApplies(commonEvent({ grade: '4' }), student), false);
  assert.equal(cohortRecordApplies(commonEvent({ section: 'B' }), student), false);
  assert.equal(cohortRecordApplies(commonEvent({ grade: ' 3 ', section: ' A ' }), student), true);
});
test('createStudent añade únicamente eventos aplicables con catalogId, estado pendiente e ids nuevos', () => {
  const settings = approved();
  settings.cohortRecords = [commonEvent(), commonEvent({ id: 'global', kind: 'family', grade: '', section: '' }), commonEvent({ id: 'otro-grado', grade: '4' })];
  const student = createStudent({ code: '002', name: 'Alumno', grade: '3', section: 'A' }, settings);
  assert.equal(student.institutional.length, 1);
  assert.equal(student.family.length, 1);
  assert.equal(student.institutional[0].catalogId, 'evento-comun');
  assert.equal(student.family[0].catalogId, 'global');
  assert.notEqual(student.institutional[0].id, student.family[0].id);
  assert.ok([...student.institutional, ...student.family].every(record => record.status === 'pending' && record.validated === false));
  const copied = createStudent(student, settings);
  assert.equal(copied.institutional.length, 1);
  assert.equal(copied.family.length, 1);
});
test('Faltar una convocatoria común impide C, PC100 y ranking aunque haya otros registros validados', () => {
  const settings = approved();
  const student = complete(settings);
  settings.cohortRecords = [commonEvent()];
  const result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.equal(result.total, null);
  assert.ok(result.pc < 100);
  assert.equal(result.eligible, false);
  assert.ok(result.pending.some(p => p.includes('falta convocatoria común Concurso de Ciencias')));
  student.institutional.push(answeredEvent(settings.cohortRecords[0]));
  const resolved = calculateStudent(student, settings);
  assert.ok(resolved.c !== null);
  assert.equal(resolved.pc, 100);
  assert.equal(resolved.eligible, true);
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
