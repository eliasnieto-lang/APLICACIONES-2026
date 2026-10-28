import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgression, calculateStudent, calculateTotal, cohortRecordApplies, DEFAULT_DIMENSION_WEIGHTS, fmt, getDimensionWeights, getEffectiveDimensionWeights, rankStudents, validateSettings } from '../shared/calculations';
import { createDemoState, createStudent, defaultSettings } from '../shared/defaults';
import type { AppState, CohortRecord, Commitment, PdfRecord, Settings, Student } from '../shared/types';
import { ACTIVE_BIMESTERS, ALLOWED_COHORTS, cohortKey, isReportApproved, normalizeCohort } from '../shared/policy';
import { migrateState } from '../shared/migrations';
import { activeAreas, hasActiveGrades, isAreaComplete } from '../shared/academic-policy';
import { commitmentRequiredFields, incidentRequiredFields } from '../shared/record-validation';
import { semanticStudentErrors } from '../server/validation';

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
test('Confirmar que no participó da PI0 sin inventar eventos y conserva la revisión final de Compromiso', () => {
  const settings = approved(), student = complete(settings);
  student.institutional = [];
  student.noContestParticipation = true;
  student.family = records('Familia', 3, 3);
  student.validated.commitment = false;
  const before = structuredClone(student);
  const provisional = calculateStudent(student, settings);
  assert.equal(provisional.participation, 0);
  assert.equal(provisional.participationNA, false);
  assert.equal(provisional.family, 100);
  assert.equal(provisional.c, 30);
  assert.equal(provisional.total, 67.375);
  assert.equal(provisional.pc, 100);
  assert.equal(provisional.progress, 100);
  assert.equal(provisional.commitmentComplete, true);
  assert.equal(provisional.eligible, false);
  assert.deepEqual(provisional.pending, ['Confirmar validación final de Compromiso.']);
  assert.deepEqual(student, before);
  assert.deepEqual(semanticStudentErrors(student, settings), []);
  student.validated.commitment = true;
  assert.equal(calculateStudent(student, settings).eligible, true);
  assert.equal(rankStudents([student], settings).length, 1);
  assert.deepEqual(student.institutional, []);
});
test('No participar exige confirmación expresa y deshacerla devuelve el apartado a pendiente', () => {
  const settings = approved(), student = complete(settings);
  student.institutional = [];
  assert.equal(calculateStudent(student, settings).participation, null);
  assert.equal(calculateStudent(student, settings).total, null);
  student.noContestParticipation = true;
  assert.equal(calculateStudent(student, settings).participation, 0);
  student.noContestParticipation = false;
  const pending = calculateStudent(student, settings);
  assert.equal(pending.participation, null);
  assert.equal(pending.total, null);
  assert.equal(pending.eligible, false);
  assert.ok(pending.pending.some(message => message.includes('participación institucional')));
});
test('La no participación no permite omitir familia y se conserva al excluir Compromiso', () => {
  const settings = approved(), student = complete(settings);
  student.institutional = []; student.family = []; student.noContestParticipation = true;
  assert.equal(calculateStudent(student, settings).participation, 0);
  assert.equal(calculateStudent(student, settings).family, null);
  assert.equal(calculateStudent(student, settings).total, null);
  student.commitmentEnabled = false; student.validated.commitment = false;
  const before = structuredClone(student), result = calculateStudent(student, settings);
  assert.equal(result.c, null);
  assert.equal(result.eligible, true);
  assert.equal(result.progress, 100);
  assert.deepEqual(student, before);
  student.commitmentEnabled = true;
  assert.equal(calculateStudent(student, settings).total, null);
});
test('Confirmar no participación y mantener concursos es una contradicción incluso con C excluida', () => {
  for (const commitmentEnabled of [true, false]) {
    const settings = approved(), student = complete(settings);
    student.noContestParticipation = true; student.commitmentEnabled = commitmentEnabled;
    const before = structuredClone(student), result = calculateStudent(student, settings);
    assert.equal(result.eligible, false);
    assert.ok(result.pending.some(message => message.includes('existen registros')));
    assert.ok(semanticStudentErrors(student, settings).some(message => message.includes('no participación')));
    assert.deepEqual(rankStudents([student], settings), []);
    assert.deepEqual(student, before);
  }
});
test('Los expedientes nuevos y antiguos distinguen sin participación de un apartado aún sin revisar', () => {
  const settings = approved(), student = complete(settings);
  assert.equal(student.noContestParticipation, false);
  delete student.noContestParticipation;
  const original = structuredClone(student);
  const migrated = migrateState({ settings, students: [student], pdfs: [] }).students[0];
  assert.equal(migrated.noContestParticipation, false);
  assert.deepEqual(migrated.institutional, original.institutional);
  assert.deepEqual(migrated.family, original.family);
  assert.deepEqual(migrated.history, original.history);
  student.institutional = []; student.noContestParticipation = true;
  assert.equal(migrateState({ settings, students: [student], pdfs: [] }).students[0].noContestParticipation, true);
});
test('El promedio general pondera Académico 50 %, Desempeño 25 % y Compromiso 25 %', () => {
  const total = calculateTotal(78.76, 89.5, 83)!;
  assert.ok(Math.abs(total - 82.505) < 1e-12);
  assert.equal(fmt(total), (82.51).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  assert.equal(calculateTotal(75, 80, null), null);
  assert.equal(calculateTotal(null, 80, 100), null);
  assert.equal(calculateTotal(75, null, 100), null);
  assert.ok(Math.abs(calculateTotal(75, 80, null, { academic: .7, performance: .2, commitment: .1 }, false)! - (75 * 7 + 80 * 2) / 9) < 1e-12);
});
test('Los pesos configurables mantienen Académico como mayor componente y se aplican sin redondeo intermedio', () => {
  const settings = approved(), student = complete(settings);
  assert.deepEqual(getDimensionWeights(settings), { academic: .5, performance: .25, commitment: .25 });
  assert.deepEqual(getDimensionWeights({}), DEFAULT_DIMENSION_WEIGHTS);
  settings.dimensionWeights = { academic: .7, performance: .2, commitment: .1 };
  assert.deepEqual(validateSettings(settings), []);
  const result = calculateStudent(student, settings);
  assert.ok(Math.abs(result.total! - (75 * .7 + 89.5 * .2 + 83 * .1)) < 1e-12);
  for (const weights of [
    { academic: .3, performance: .5, commitment: .2 },
    { academic: .4, performance: .4, commitment: .2 },
    { academic: .6, performance: .4, commitment: 0 },
    { academic: .7, performance: .3, commitment: .2 },
    { academic: Number.NaN, performance: .25, commitment: .15 },
  ]) {
    settings.dimensionWeights = weights;
    assert.ok(validateSettings(settings).length);
    assert.equal(calculateStudent(student, settings).eligible, false);
  }
});
test('Excluir Compromiso normaliza A:B, no exige C ni sus confirmaciones y conserva todos sus datos', () => {
  const settings = approved(), student = complete(settings);
  student.commitmentEnabled = false;
  student.validated.commitment = false;
  // An unfinished old C entry must remain available if the operator enables C again.
  student.family[0].date = ''; student.family[0].validated = false;
  student.institutional = [];
  const before = structuredClone(student);
  const effective = getEffectiveDimensionWeights(settings, student);
  assert.equal(effective.academic, 2 / 3);
  assert.equal(effective.performance, 1 / 3);
  assert.equal(effective.commitment, 0);
  const result = calculateStudent(student, settings);
  assert.equal(result.commitmentExcluded, true);
  assert.equal(result.c, null);
  assert.equal(result.pc, 0);
  assert.equal(result.progress, 100);
  assert.equal(result.eligible, true);
  assert.ok(Math.abs(result.total! - (75 * 50 + 89.5 * 25) / 75) < 1e-12);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(semanticStudentErrors(student, settings), []);
  assert.equal(rankStudents([student], settings).length, 1);
  assert.deepEqual(student, before);
  student.commitmentEnabled = true;
  assert.equal(calculateStudent(student, settings).eligible, false);
  assert.equal(calculateStudent(student, settings).total, null);
});
test('Excluir Compromiso no omite datos ni confirmaciones obligatorios de Académico y Desempeño', () => {
  for (const invalidate of [
    (student: Student) => { student.academic[0].grades[0][2] = ''; },
    (student: Student) => { student.attendance.attended = null; },
    (student: Student) => { student.validated.academic = false; },
    (student: Student) => { student.validated.performance = false; },
    (student: Student) => { student.attendance.validated = false; },
    (student: Student) => { student.discipline.confirmed = false; },
  ]) {
    const settings = approved(), student = complete(settings);
    student.commitmentEnabled = false; student.institutional = []; student.family = [];
    invalidate(student);
    const result = calculateStudent(student, settings);
    assert.equal(result.eligible, false);
    assert.deepEqual(rankStudents([student], settings), []);
    assert.ok(result.pending.length);
    assert.ok(result.pending.every(message => !/Compromiso|Participación|familia/i.test(message)));
  }
});
test('La permanencia es una decisión manual independiente del puntaje y la clasificación', () => {
  const settings = approved(), student = complete(settings);
  const result = calculateStudent(student, settings);
  for (const circleStatus of ['pending', 'remains', 'does_not_remain'] as const) {
    student.circleStatus = circleStatus;
    assert.deepEqual(calculateStudent(student, settings), result);
    assert.equal(student.circleStatus, circleStatus);
  }
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
test('Un curso sin notas I–III queda fuera de promedios, avance y pendientes sin borrar IV', () => {
  const settings = approved();
  const student = complete(settings);
  const math = student.academic.find(area => area.areaId === 'matematica')!;
  math.grades.forEach(row => { row.splice(0, row.length, '', '', '', 'AD'); });
  math.validated = false;
  const original = structuredClone(student);
  const result = calculateStudent(student, settings);
  assert.equal(hasActiveGrades(math), false);
  assert.equal(activeAreas(student, settings).length, 4);
  assert.equal('matematica' in result.areaAverages, false);
  for (const field of ['g', 'r', 'p', 'a'] as const) assert.equal(result[field], 75, field);
  assert.equal(result.s1, 3);
  assert.equal(result.s2, 3);
  assert.equal(result.pa, 100);
  assert.equal(result.academicComplete, true);
  assert.equal(result.eligible, true);
  assert.ok(result.pending.every(message => !message.includes('Matemática') && !message.includes('notas del')));
  assert.deepEqual(student, original);
  student.academic = student.academic.filter(area => area.areaId !== 'matematica');
  assert.deepEqual(calculateStudent(student, settings), result);
  assert.equal(settings.areas.filter(area => area.eligible).length, 5);
});
test('Un curso parcialmente cargado sigue exigiendo todas sus competencias I–III', () => {
  const settings = approved();
  const student = complete(settings);
  const math = student.academic.find(area => area.areaId === 'matematica')!;
  math.grades[0][2] = '';
  assert.equal(hasActiveGrades(math), true);
  assert.equal(isAreaComplete(settings.areas[0], math), false);
  const result = calculateStudent(student, settings);
  assert.equal(result.a, null);
  assert.equal(result.r, null);
  assert.equal(result.science, null);
  assert.equal(result.letters, 3);
  assert.equal(result.s2, null);
  assert.equal(result.academicComplete, false);
  assert.ok(result.pa < 100);
  assert.ok(result.pending.includes('Faltan 1 notas del III bimestre.'));
  assert.equal(result.eligible, false);
  math.grades[0][2] = 'A';
  assert.equal(isAreaComplete(settings.areas[0], math), true);
});
test('Las aulas de secundaria promedian Ciencia con las competencias cursadas y exigen revisión manual', () => {
  for (const [grade, section] of [['1', 'A'], ['2', 'B'], ['3', 'F'], ['4', 'F'], ['5', 'Z']]) {
    const settings = approved(), student = complete(settings);
    student.grade = grade; student.section = section;
    const science = student.academic.find(area => area.areaId === 'ciencia')!;
    science.grades[0] = ['', '', '', 'AD'];
    science.validated = false; student.validated.academic = false;
    const original = structuredClone(student);
    const provisional = calculateStudent(student, settings);
    for (const field of ['g', 'r', 'p', 'a'] as const) assert.equal(provisional[field], 75, `${grade}: ${field}`);
    assert.equal(provisional.areaAverages.ciencia, 3);
    assert.equal(provisional.academicComplete, true);
    assert.equal(provisional.pa, 100 * 36 / 42);
    assert.equal(provisional.eligible, false);
    assert.ok(provisional.pending.includes('Validar área: Ciencia y Tecnología.'));
    assert.ok(provisional.pending.every(message => !message.includes('notas del')));
    assert.deepEqual(student, original);
    science.validated = true; student.validated.academic = true;
    const validated = calculateStudent(student, settings);
    assert.equal(validated.pa, 100);
    assert.equal(validated.eligible, true);
    assert.deepEqual(semanticStudentErrors(student, settings), []);
    assert.deepEqual(science.grades[0], ['', '', '', 'AD']);
  }
});
test('La excepción de Indaga conserva la ponderación y progresión calculadas desde las otras competencias', () => {
  const settings = approved(), student = complete(settings); student.grade = '4';
  const science = student.academic.find(area => area.areaId === 'ciencia')!;
  science.grades = [['', '', ''], ['B', 'A', 'AD'], ['A', 'AD', 'AD']];
  const result = calculateStudent(student, settings);
  assert.equal(result.areaAverages.ciencia, 10 / 3);
  assert.ok(Math.abs(result.g! - 230 / 3) < 1e-12);
  assert.ok(Math.abs(result.r! - 77.5) < 1e-12);
  assert.equal(result.s1, 3);
  assert.equal(result.s2, 3.2);
  assert.equal(result.p, 82.5);
  assert.ok(Math.abs(result.a! - 469 / 6) < 1e-12);
});
test('Una Indaga parcial u otra competencia incompleta sigue pendiente y no se puede validar', () => {
  for (const grade of ['2', '3', '4', '5']) {
    const settings = approved(), student = complete(settings); student.grade = grade;
    const science = student.academic.find(area => area.areaId === 'ciencia')!;
    science.grades[0] = ['', 'A', ''];
    assert.equal(calculateStudent(student, settings).a, null);
    assert.equal(calculateStudent(student, settings).eligible, false);
    assert.ok(semanticStudentErrors(student, settings).some(error => error.includes('calificaciones vacías')));
  }
  const settings = approved(), student = complete(settings); student.grade = '4';
  const science = student.academic.find(area => area.areaId === 'ciencia')!;
  science.grades[0] = ['', '', '']; science.grades[1][2] = '';
  assert.equal(calculateStudent(student, settings).a, null);
  assert.ok(semanticStudentErrors(student, settings).some(error => error.includes('calificaciones vacías')));
});
test('R usa el grupo cursado completo cuando Ciencias o Letras carece de notas', () => {
  for (const scienceOnly of [true, false]) {
    for (const scienceWeight of [.6, 0, 1]) {
      const settings = approved(); settings.scienceWeight = scienceWeight;
      const student = complete(settings);
      student.academic.forEach(area => {
        const isScience = ['matematica', 'ciencia'].includes(area.areaId);
        const grade = isScience === scienceOnly ? area.areaId === 'matematica' ? 'AD' : 'A' : '';
        area.grades.forEach(row => row.fill(grade));
        area.validated = isScience === scienceOnly;
      });
      const result = calculateStudent(student, settings);
      const expected = scienceOnly ? 87.5 : 75;
      assert.equal(result.science, scienceOnly ? 3.5 : null);
      assert.equal(result.letters, scienceOnly ? null : 3);
      for (const field of ['g', 'r', 'p', 'a'] as const) assert.equal(result[field], expected, field);
      assert.equal(result.pa, 100);
      assert.equal(result.eligible, true);
    }
  }
});
test('Sin ningún curso con notas activas no se inventa A ni avance académico', () => {
  const settings = approved();
  const student = complete(settings);
  student.academic.forEach(area => area.grades.forEach(row => { row.splice(0, row.length, '', '', '', 'AD'); }));
  const original = structuredClone(student);
  const result = calculateStudent(student, settings);
  for (const field of ['g', 'r', 'p', 'a', 's1', 's2', 'science', 'letters', 'total'] as const) assert.equal(result[field], null, field);
  assert.equal(result.pa, 0);
  assert.equal(result.academicComplete, false);
  assert.deepEqual(result.areaAverages, {});
  assert.equal(result.eligible, false);
  assert.deepEqual(rankStudents([student], settings), []);
  assert.ok(result.pending.every(message => !message.startsWith('Validar área:') && !message.includes('notas del')));
  assert.deepEqual(student, original);
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
test('Una incidencia verificada necesita categoría, fecha y descripción; medida y evidencia son opcionales', () => {
  const settings = approved();
  const student = complete(settings);
  student.discipline.incidents[0].measure = '';
  student.discipline.incidents[0].evidence = '';
  const result = calculateStudent(student, settings);
  assert.deepEqual(incidentRequiredFields(student.discipline.incidents[0], settings.disciplineTypes), []);
  assert.equal(result.discipline, 85);
  assert.equal(result.b, 89.5);
  assert.equal(result.eligible, true);
  settings.disciplineTypes.find(type => type.id === 'grave')!.discount = null;
  assert.deepEqual(incidentRequiredFields(student.discipline.incidents[0], settings.disciplineTypes), []);
  const pendingDiscount = calculateStudent(student, settings);
  assert.equal(pendingDiscount.discipline, null);
  assert.equal(pendingDiscount.eligible, false);
  assert.ok(pendingDiscount.pending.some(message => message.includes('descuento aprobado')));
});
test('Una incidencia con categoría desconocida, fecha imposible o descripción vacía sigue pendiente', () => {
  const settings = approved();
  for (const patch of [{ typeId: '' }, { typeId: 'desconocida' }, { date: '' }, { date: '2026-02-30' }, { description: '   ' }]) {
    const student = complete(settings);
    Object.assign(student.discipline.incidents[0], patch);
    const result = calculateStudent(student, settings);
    assert.ok(incidentRequiredFields(student.discipline.incidents[0], settings.disciplineTypes).length);
    assert.equal(result.discipline, null);
    assert.equal(result.b, null);
    assert.equal(result.eligible, false);
  }
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
test('Sin registros no significa No aplica; una fila No aplica necesita sus datos mínimos y validación', () => {
  const settings = approved(); settings.naPolicy = 'other_component'; settings.naPolicyApproved = true;
  const student = complete(settings); student.institutional = [];
  assert.equal(calculateStudent(student, settings).c, null);
  assert.equal(calculateStudent(student, settings).participationNA, false);
  student.institutional = [{ ...records('Acta de no aplicabilidad', 1, 1)[0], status: 'na', justification: '' }];
  assert.equal(calculateStudent(student, settings).c, 90);
  assert.equal(calculateStudent(student, settings).eligible, true);
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
test('Los listados de 1.º A y 1.º B mantienen puestos independientes con el promedio ponderado', () => {
  const settings = approved();
  const students = ['A', 'B'].flatMap(section => [false, true].map(highAcademic => {
    const student = complete(settings);
    student.id = `${section}-${highAcademic ? 'alto' : 'base'}`;
    student.grade = 'primero'; student.section = section;
    if (highAcademic) student.academic.forEach(area => area.grades.forEach(row => row.fill('AD')));
    return student;
  }));
  const ranking = rankStudents(students, settings);
  assert.deepEqual(ranking.map(row => [row.cohort, row.position, row.student.id]), [
    ['1.º A', 1, 'A-alto'], ['1.º A', 2, 'A-base'], ['1.º B', 1, 'B-alto'], ['1.º B', 2, 'B-base'],
  ]);
  assert.equal(ranking[0].result.total, 93.125);
  assert.equal(ranking[1].result.total, 80.625);
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
  assert.ok(demo.students.every(student => normalizeCohort(student.grade, student.section)));
  assert.ok(new Set(demo.students.map(student => cohortKey(student.grade, student.section))).size > 1);
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
test('Convocatoria común N/A conserva su vinculación y validación con justificación opcional', () => {
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
  event.evidence = '';
  assert.equal(calculateStudent(student, settings).eligible, true);
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
test('La evidencia es opcional en compromisos familiares e institucionales históricos', () => {
  const settings = approved();
  for (const kind of ['institutional', 'family'] as const) {
    const student = complete(settings);
    student[kind][0].evidence = '   ';
    student[kind][0].justification = '';
    const result = calculateStudent(student, settings);
    assert.equal(result.c, 83);
    assert.equal(result.pc, 100);
    assert.equal(result.progress, 100);
    assert.equal(result.eligible, true);
    assert.ok(result.pending.every(message => !message.includes('evidencia') && !message.includes('justificación')));
  }
});
test('Un registro no exigible conserva su exclusión con justificación y evidencia opcionales', () => {
  const settings = approved();
  const student = complete(settings);
  student.institutional[0].required = false;
  student.institutional[0].justification = '';
  student.institutional[0].evidence = '';
  const result = calculateStudent(student, settings);
  assert.equal(result.participation, 100 * 7 / 9);
  assert.equal(result.pc, 100);
  assert.equal(result.eligible, true);
});

test('Estados cumplido, incumplido, justificado y N/A no exigen evidencia ni justificación', () => {
  const settings = approved();
  for (const kind of ['institutional', 'family'] as const) {
    for (const status of ['fulfilled', 'missed', 'justified', 'na'] as const) {
      const student = complete(settings);
      Object.assign(student[kind][0], { status, justification: '', evidence: '' });
      const original = structuredClone(student);
      const result = calculateStudent(student, settings);
      assert.deepEqual(commitmentRequiredFields(student[kind][0]), []);
      assert.ok(result.c !== null);
      assert.equal(result.pc, 100);
      assert.equal(result.eligible, true);
      assert.deepEqual(student, original);
    }
  }
});
test('Nombre, fecha real y estado siguen siendo obligatorios en compromisos familiares e históricos', () => {
  const settings = approved();
  for (const kind of ['institutional', 'family'] as const) {
    for (const patch of [{ name: '   ' }, { date: '' }, { date: '2026-02-30' }, { status: 'pending' as const }]) {
      const student = complete(settings);
      Object.assign(student[kind][0], patch, { evidence: '', justification: '' });
      const result = calculateStudent(student, settings);
      assert.ok(commitmentRequiredFields(student[kind][0]).length);
      assert.equal(result.c, null);
      assert.ok(result.pc < 100);
      assert.equal(result.eligible, false);
      assert.deepEqual(rankStudents([student], settings), []);
    }
  }
});

test('Se normalizan los cinco grados y las secciones A–Z de secundaria con expresiones completas', () => {
  assert.deepEqual(ACTIVE_BIMESTERS, ['I', 'II', 'III']);
  for (const [grade, canonical] of [
    ['1ro AÑO de secundaria', '1.º de secundaria'], ['primero', '1.º de secundaria'], ['2', '2.º de secundaria'], [' 2.° de Secundaria ', '2.º de secundaria'], ['segundo grado de secundaria', '2.º de secundaria'],
    ['3ro secundaria', '3.º de secundaria'], ['TERCERO', '3.º de secundaria'], ['tercer grado de educación secundaria', '3.º de secundaria'], ['3.er de secundaria', '3.º de secundaria'], ['4to grado', '4.º de secundaria'], ['cuarto de secundaria', '4.º de secundaria'], ['5to grado', '5.º de secundaria'], ['quinto de secundaria', '5.º de secundaria'],
  ]) assert.equal(normalizeCohort(grade, ' f ')?.grade, canonical);
  for (const grade of ['12', '25', '23', '2do primaria', '2.º F', 'pre 3', '3.º de secundaria extra', '2to', '4ro', '3do', '0', '6']) assert.equal(normalizeCohort(grade, 'F'), null, grade);
  for (const section of ['FF', '2F', '', 'Ñ', '1']) assert.equal(normalizeCohort('3', section), null, section);
  for (const section of ['A', 'B', 'F', 'Z']) assert.equal(normalizeCohort('3', section.toLowerCase())?.label, `3.º ${section}`);
  assert.equal(ALLOWED_COHORTS.length, 25);
  assert.ok(ALLOWED_COHORTS.every(cohort => /^[A-E]$/.test(cohort.section)));
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
  for (const [grade, section] of [['6', 'F'], ['3', 'AA'], ['12', 'F']]) {
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

test('La migración del promedio ponderado conserva datos y cierre, requiere aprobación una vez y respeta pesos explícitos', () => {
  const settings = approved(), student = complete(settings);
  delete settings.dimensionWeights; settings.closed = true;
  delete student.commitmentEnabled; delete student.circleStatus;
  const source: AppState = { settings, students: [student], pdfs: [report(student)] };
  const before = structuredClone(source);
  const migrated = migrateState(source);
  assert.deepEqual(migrated.settings.dimensionWeights, DEFAULT_DIMENSION_WEIGHTS);
  assert.equal(migrated.settings.criteriaApproved, false);
  assert.equal(migrated.settings.closed, true);
  assert.equal(migrated.students[0].commitmentEnabled, true);
  assert.equal(migrated.students[0].circleStatus, 'pending');
  for (const field of ['academic', 'attendance', 'discipline', 'institutional', 'family', 'validated', 'history'] as const) assert.deepEqual(migrated.students[0][field], before.students[0][field]);
  assert.deepEqual(source, before);
  migrated.settings.dimensionWeights = { academic: .7, performance: .2, commitment: .1 };
  migrated.settings.criteriaApproved = true;
  migrated.students[0].commitmentEnabled = false;
  migrated.students[0].circleStatus = 'does_not_remain';
  assert.deepEqual(migrateState(migrated), migrated);
});

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
    state => { state.students[0].grade = '6'; state.pdfs[0].extractedGrade = '6'; },
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
