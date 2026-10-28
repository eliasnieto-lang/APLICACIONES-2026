import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateStudent, rankStudents } from '../shared/calculations';
import { createStudent, defaultSettings } from '../shared/defaults';
import { ACADEMIC_CONTEST_TYPE, CONTEST_SCOPE_OPTIONS, contestPoints, contestRequiredFields, isAcademicContest, isValidContestDate } from '../shared/contests';
import type { Commitment, Settings, Student } from '../shared/types';

const contest = (patch: Partial<Commitment> = {}): Commitment => ({
  id: 'concurso-1', eventType: ACADEMIC_CONTEST_TYPE, scope: 'local', date: '2027-06-12', placement: '3.er puesto',
  name: '', required: false, status: 'fulfilled', justification: '', evidence: '', validated: true, ...patch,
});
const legacy = (patch: Partial<Commitment> = {}): Commitment => ({
  id: 'anterior-1', name: 'Concurso académico', date: '2027-06-12', required: true,
  status: 'fulfilled', justification: '', evidence: 'Acta de asistencia', validated: true, ...patch,
});
const settings = (): Settings => ({ ...structuredClone(defaultSettings), criteriaApproved: true });
const complete = (config = settings()): Student => {
  const student = createStudent({ code: '001', name: 'Estudiante de prueba', grade: '3', section: 'F' }, config);
  student.academic.forEach(area => { area.grades = area.grades.map(() => ['A', 'A', 'A']); area.validated = true; });
  student.attendance = { required: 100, exempted: 0, attended: 100, punctual: 100, validated: true };
  student.discipline = { confirmed: true, incidents: [] };
  student.institutional = [contest()];
  student.family = [legacy({ id: 'familia-1', name: 'Reunión de familias' })];
  student.validated = { academic: true, performance: true, commitment: true };
  student.pdfIds = ['libreta-prueba'];
  student.reportApproval = { pdfId: 'libreta-prueba', approvedAt: '2027-08-12T12:00:00.000Z' };
  return student;
};

test('La escala propuesta distingue concursos locales, regionales y nacionales sobre 100', () => {
  assert.deepEqual(defaultSettings.activityTypes, ['CONCURSOS ACADÉMICOS']);
  assert.deepEqual(CONTEST_SCOPE_OPTIONS.map(option => option.points), [40, 70, 100]);
  const config = settings();
  for (const option of CONTEST_SCOPE_OPTIONS) {
    const student = complete(config);
    student.institutional[0].scope = option.value;
    const result = calculateStudent(student, config);
    assert.equal(contestPoints(student.institutional[0]), option.points);
    assert.equal(result.participation, option.points);
    assert.equal(result.c, .7 * option.points + .3 * 100);
    assert.equal(result.pc, 100);
    assert.equal(result.eligible, true);
  }
});

test('Solo clasificación, fecha y ubicación son obligatorias para validar un concurso nuevo', () => {
  const config = settings();
  const student = complete(config);
  student.institutional[0] = contest({ required: false, status: 'pending', name: '', evidence: '', justification: '', representingSchool: false });
  assert.deepEqual(contestRequiredFields(student.institutional[0]), []);
  const before = structuredClone(student);
  const result = calculateStudent(student, config);
  assert.equal(result.participation, 40);
  assert.equal(result.pc, 100);
  assert.equal(result.eligible, true);
  assert.ok(result.pending.every(message => !/falta evidencia|falta justificación|registro sin nombre/.test(message)));
  assert.deepEqual(student, before);
});

test('Un solo campo obligatorio ausente o una fecha imposible mantiene el concurso pendiente', () => {
  const config = settings();
  for (const patch of [
    { scope: undefined }, { date: '' }, { date: '2027-02-29' }, { date: '2027-04-31' }, { placement: '   ' },
  ] satisfies Partial<Commitment>[]) {
    const student = complete(config);
    student.institutional[0] = contest(patch);
    const result = calculateStudent(student, config);
    assert.ok(contestRequiredFields(student.institutional[0]).length > 0);
    assert.equal(result.participation, null);
    assert.equal(result.c, null);
    assert.ok(result.pc < 100);
    assert.equal(result.eligible, false);
    assert.deepEqual(rankStudents([student], config), []);
  }
  assert.equal(isValidContestDate('2028-02-29'), true);
  assert.equal(isValidContestDate('2027-2-12'), false);
  assert.equal(isValidContestDate('fecha'), false);
  assert.equal(contestPoints({ scope: undefined }), null);
  assert.deepEqual(contestRequiredFields(contest({ eventType: undefined })), ['tipo de evento (local, regional o nacional)']);
});

test('PI usa el mejor concurso; añadir participaciones menores no reduce ni acumula el puntaje', () => {
  const config = settings();
  const student = complete(config);
  student.institutional = [contest({ scope: 'regional' }), contest({ id: 'local-2' }), contest({ id: 'local-3' })];
  assert.equal(calculateStudent(student, config).participation, 70);
  student.institutional.push(contest({ id: 'nacional', scope: 'national' }));
  assert.equal(calculateStudent(student, config).participation, 100);
  student.institutional = student.institutional.filter(record => record.scope === 'local');
  assert.equal(calculateStudent(student, config).participation, 40);
});

test('El puntaje de concurso completo es provisional hasta validar los registros y el ámbito C', () => {
  const config = settings();
  const student = complete(config);
  student.institutional.push(contest({ id: 'nacional', scope: 'national', validated: false }));
  let result = calculateStudent(student, config);
  assert.equal(result.participation, 100);
  assert.equal(result.c, 100);
  assert.ok(result.pc < 100);
  assert.equal(result.eligible, false);
  student.institutional[1].validated = true;
  student.validated.commitment = false;
  result = calculateStudent(student, config);
  assert.equal(result.pc, 100);
  assert.equal(result.eligible, false);
});

test('Incumplimientos explícitos puntúan cero y no ganan por tener mayor alcance', () => {
  const config = settings();
  const student = complete(config);
  student.institutional.push(contest({ id: 'nacional-incumplido', scope: 'national', status: 'missed' }));
  assert.equal(calculateStudent(student, config).participation, 40);
  student.institutional = [student.institutional[1]];
  const result = calculateStudent(student, config);
  assert.equal(result.participation, 0);
  assert.equal(result.c, 30);
  assert.equal(result.eligible, true);
});

test('Los estados explícitos justificado y No aplica conservan la regla común aprobada', () => {
  const config = settings();
  const student = complete(config);
  student.institutional = [contest({ status: 'justified' }), contest({ id: 'no-aplica', scope: 'national', status: 'na' })];
  let result = calculateStudent(student, config);
  assert.equal(result.participation, null);
  assert.equal(result.participationNA, true);
  assert.equal(result.c, null);
  assert.equal(result.eligible, false);
  config.naPolicy = 'other_component'; config.naPolicyApproved = true;
  result = calculateStudent(student, config);
  assert.equal(result.c, 100);
  assert.equal(result.eligible, true);
});

test('La evidencia y las condiciones de los compromisos familiares permanecen obligatorias', () => {
  const config = settings();
  const student = complete(config);
  // Even a typed-looking entry in the family array follows family rules.
  student.family = [contest({ id: 'familia', name: 'Reunión familiar', required: true })];
  const result = calculateStudent(student, config);
  assert.equal(result.participation, 40);
  assert.equal(result.family, null);
  assert.equal(result.c, null);
  assert.ok(result.pending.some(message => message.includes('Compromiso familiar') && message.includes('falta evidencia')));
});

test('Los registros históricos conservan la fórmula anterior sin convertirse por su nombre', () => {
  const config = settings();
  const student = complete(config);
  student.institutional = Array.from({ length: 5 }, (_, i) => legacy({ id: `anterior-${i}`, status: i < 4 ? 'fulfilled' : 'missed', justification: i < 4 ? '' : 'Incumplimiento documentado' }));
  const before = structuredClone(student.institutional);
  const result = calculateStudent(student, config);
  assert.equal(isAcademicContest(student.institutional[0]), false);
  assert.equal(result.participation, 80);
  assert.equal(result.c, 86);
  assert.equal(result.eligible, true);
  assert.deepEqual(student.institutional, before);
  student.institutional[0].evidence = '';
  assert.equal(calculateStudent(student, config).participation, null);
});

test('Mezclar registros históricos y concursos nuevos requiere clasificar los históricos expresamente', () => {
  const config = settings();
  const student = complete(config);
  student.institutional.push(legacy());
  const before = structuredClone(student.institutional);
  const result = calculateStudent(student, config);
  assert.equal(result.participation, null);
  assert.equal(result.c, null);
  assert.equal(result.eligible, false);
  assert.ok(result.pending.some(message => message.includes('clasificar expresamente los registros históricos')));
  assert.deepEqual(student.institutional, before);
  student.institutional[1] = contest({ id: 'anterior-1', scope: 'regional' });
  assert.equal(calculateStudent(student, config).participation, 70);
});
