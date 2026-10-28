import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudent, defaultSettings } from '../shared/defaults.js';
import { migrateState } from '../shared/migrations.js';
import { applyReprocessedReport, confirmReport, identifyReport, registerImportedReport, ReportWorkflowError } from '../shared/report-workflow.js';
import { stateReferenceErrors, stateSchema } from '../server/validation.js';
import type { AppState, PdfRecord, Student } from '../shared/types.js';

const filename = 'BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf';
const state = (): AppState => {
  const settings = structuredClone(defaultSettings);
  settings.areas = [{ id: 'math', name: 'Matemática', group: 'math', eligible: true, competencies: ['Resuelve problemas'] }];
  return { students: [], settings, pdfs: [] };
};
const report = (patch: Partial<PdfRecord> = {}): PdfRecord => ({
  id: globalThis.crypto.randomUUID(), name: filename, hash: 'a'.repeat(64), size: 123, uploadedAt: '2026-10-01T10:00:00.000Z',
  status: 'review', studentId: null, extractedCode: '', extractedName: '', extractedGrade: '', extractedSection: '', period: '', text: '', ocr: false, warnings: [],
  areas: [{ areaId: 'math', grades: [['', '', '']], validated: false }], ...patch,
});
const manualRecords = (student: Student) => {
  student.attendance = { required: 200, attended: 180, punctual: 170, exempted: 10, validated: true };
  student.discipline = { confirmed: true, incidents: [] };
  student.institutional = [{ id: 'contest', name: 'Concurso', date: '2026-10-10', required: true, status: 'fulfilled', justification: '', evidence: 'Acta', validated: true, placement: 'Segundo puesto', representingSchool: true }];
  student.family = [{ id: 'meeting', name: 'Reunión', date: '2026-10-10', required: true, status: 'fulfilled', justification: '', evidence: 'Firma', validated: true }];
  student.validated.performance = true;
  student.validated.commitment = true;
  return structuredClone({ attendance: student.attendance, discipline: student.discipline, institutional: student.institutional, family: student.family, performance: student.validated.performance, commitment: student.validated.commitment });
};
const currentManualRecords = (student: Student) => ({ attendance: student.attendance, discipline: student.discipline, institutional: student.institutional, family: student.family, performance: student.validated.performance, commitment: student.validated.commitment });

test('the supplied filename registers and confirms with all text identity fields and period blank', () => {
  const app = state(), pdf = report(); app.pdfs.push(pdf);
  const student = registerImportedReport(app, pdf)!;
  assert.ok(student);
  assert.equal(student.name, 'SEGURA CAMONES ANDRES ADRIAN');
  assert.equal(student.grade, '2.º de secundaria'); assert.equal(student.section, 'F');
  assert.ok(student.code.startsWith('AUTO-'));
  assert.equal(pdf.extractedCode, ''); assert.equal(pdf.period, ''); assert.equal(pdf.text, '');
  assert.equal(student.reportApproval, undefined);
  const result = confirmReport(app, pdf.id);
  assert.equal(result.student.id, student.id); assert.equal(result.pdf.status, 'validated');
  assert.equal(result.student.reportApproval?.pdfId, pdf.id);
  assert.equal(result.student.validated.academic, false, 'empty grades still need academic review');
  assert.deepEqual(stateReferenceErrors(app), []);
  assert.equal(stateSchema.safeParse(app).success, true);
});

test('a fifth F filename registers, confirms and retains its classroom after migration', () => {
  const app = state(), pdf = report({ name: 'BOLETA_5to año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf' });
  const settings = structuredClone(app.settings);
  app.pdfs.push(pdf);
  const student = registerImportedReport(app, pdf)!;
  assert.ok(student);
  assert.equal(student.grade, '5.º de secundaria');
  assert.equal(student.section, 'F');
  confirmReport(app, pdf.id);
  const migrated = migrateState(app);
  assert.equal(migrated.students.length, 1);
  assert.equal(migrated.students[0].id, student.id);
  assert.equal(migrated.students[0].grade, '5.º de secundaria');
  assert.deepEqual(migrated.students[0].reportApproval, student.reportApproval);
  assert.deepEqual(migrated.settings, settings);
  assert.deepEqual(stateReferenceErrors(migrated), []);
});

test('filename name and classroom take precedence over conflicting text extraction', () => {
  const app = state(), pdf = report({ extractedCode: 'KNOWN-1', extractedName: 'Nombre equivocado', extractedGrade: '4', extractedSection: 'F' }); app.pdfs.push(pdf);
  const student = registerImportedReport(app, pdf)!;
  assert.equal(student.name, 'SEGURA CAMONES ANDRES ADRIAN'); assert.equal(student.grade, '2.º de secundaria');
  assert.equal(student.code, 'KNOWN-1');
  assert.equal(pdf.extractedName, student.name);
});

test('a manual fallback name creates a student without requesting a code and survives reprocessing', () => {
  const app = state(), pdf = report({ name: 'libreta.pdf', extractedGrade: '3', extractedSection: 'F' }); app.pdfs.push(pdf);
  assert.equal(registerImportedReport(app, pdf), null);
  identifyReport(app, pdf.id, { name: '  PÉREZ   RAMOS ANA MARÍA  ' });
  const student = app.students[0], manual = manualRecords(student), code = student.code;
  assert.equal(student.name, 'PÉREZ RAMOS ANA MARÍA'); assert.equal(pdf.manualName, student.name);
  const { id: _id, name: _name, hash: _hash, size: _size, uploadedAt: _date, status: _status, studentId: _student, ...reading } = report({ name: 'ignored.pdf', extractedName: 'Nombre OCR distinto', extractedGrade: '3', extractedSection: 'F', areas: [{ areaId: 'math', grades: [['A', 'B', 'AD']], validated: false }] });
  applyReprocessedReport(app, pdf.id, reading);
  assert.equal(app.students.length, 1); assert.equal(student.id, pdf.studentId); assert.equal(student.code, code);
  assert.equal(student.name, 'PÉREZ RAMOS ANA MARÍA'); assert.equal(pdf.manualName, student.name);
  assert.deepEqual(currentManualRecords(student), manual);
  assert.deepEqual(student.academic[0].grades, [['A', 'B', 'AD']]);
  confirmReport(app, pdf.id);
  assert.equal(pdf.confirmedIdentity?.name, 'PÉREZ RAMOS ANA MARÍA');
  assert.deepEqual(stateReferenceErrors(app), []);
});

test('correcting only the name on the same approved report preserves academic edits and manual B/C', () => {
  const app = state(), pdf = report({ areas: [{ areaId: 'math', grades: [['A', 'A', 'A']], validated: false }] }); app.pdfs.push(pdf);
  const student = registerImportedReport(app, pdf)!; confirmReport(app, pdf.id);
  const manual = manualRecords(student), code = student.code;
  student.academic[0].grades[0][0] = 'AD'; student.academic[0].validated = false; student.validated.academic = false;
  const academic = structuredClone(student.academic);
  confirmReport(app, pdf.id, { name: 'SEGURA CAMONES ANDRÉS ADRIÁN CORREGIDO' });
  assert.equal(app.students.length, 1); assert.equal(pdf.studentId, student.id); assert.equal(student.code, code);
  assert.equal(student.name, 'SEGURA CAMONES ANDRÉS ADRIÁN CORREGIDO'); assert.equal(pdf.manualName, student.name);
  assert.deepEqual(student.academic, academic); assert.equal(student.validated.academic, false);
  assert.deepEqual(currentManualRecords(student), manual);
  assert.deepEqual(stateReferenceErrors(app), []);
  const migrated = migrateState(app);
  assert.equal(migrated.students[0].name, student.name); assert.equal(migrated.students[0].reportApproval?.pdfId, pdf.id);
});

test('saving a provisional name edit keeps the linked record, grades and manual B/C', () => {
  const app = state(), pdf = report({ areas: [{ areaId: 'math', grades: [['A', 'A', 'A']], validated: false }] }); app.pdfs.push(pdf);
  const student = registerImportedReport(app, pdf)!, manual = manualRecords(student), academic = structuredClone(student.academic);
  identifyReport(app, pdf.id, { name: 'NOMBRE CORREGIDO' });
  assert.equal(student.name, 'NOMBRE CORREGIDO'); assert.equal(student.id, pdf.studentId);
  assert.deepEqual(student.academic, academic); assert.deepEqual(currentManualRecords(student), manual);
  confirmReport(app, pdf.id);
  assert.equal(student.name, 'NOMBRE CORREGIDO'); assert.deepEqual(currentManualRecords(student), manual);
});

test('migration derives retained pending filename identity immediately, with no OCR or lost metadata', () => {
  const app = state(), pdf = report({ status: 'pending' }); app.pdfs.push(pdf);
  const original = structuredClone(app), migrated = migrateState(app);
  assert.equal(migrated.students.length, 1); assert.equal(migrated.students[0].name, 'SEGURA CAMONES ANDRES ADRIAN');
  assert.equal(migrated.pdfs[0].extractedName, 'SEGURA CAMONES ANDRES ADRIAN'); assert.equal(migrated.pdfs[0].extractedGrade, '2.º de secundaria');
  assert.equal(migrated.pdfs[0].id, pdf.id); assert.equal(migrated.pdfs[0].hash, pdf.hash); assert.equal(migrated.pdfs[0].size, pdf.size); assert.equal(migrated.pdfs[0].uploadedAt, pdf.uploadedAt);
  assert.equal(migrated.pdfs[0].text, ''); assert.equal(migrated.pdfs[0].extractedCode, ''); assert.equal(migrated.students[0].reportApproval, undefined);
  assert.deepEqual(app, original); assert.deepEqual(migrateState(migrated), migrated);
});

test('migration repairs a legacy provisional filename label while retaining linked data', () => {
  const app = state(), student = createStudent({ code: 'LEGACY', name: 'Nombre OCR equivocado', grade: '2', section: 'F' }, app.settings);
  const pdf = report({ studentId: student.id, extractedName: student.name, extractedGrade: '2', extractedSection: 'F' }); student.pdfIds.push(pdf.id); app.students.push(student); app.pdfs.push(pdf);
  const manual = manualRecords(student), academic = structuredClone(student.academic), migrated = migrateState(app);
  assert.equal(migrated.students[0].id, student.id); assert.equal(migrated.students[0].name, 'SEGURA CAMONES ANDRES ADRIAN');
  assert.deepEqual(migrated.students[0].academic, academic); assert.deepEqual(currentManualRecords(migrated.students[0]), manual);
});

test('migration and semantic validation retain a valid approval when the PDF contains no code', () => {
  const app = state(), student = createStudent({ code: 'AUTO-legacy', name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2', section: 'F' }, app.settings);
  const pdf = report({ status: 'validated', studentId: student.id }); student.pdfIds.push(pdf.id); student.reportApproval = { pdfId: pdf.id, approvedAt: '2026-10-02T12:00:00.000Z' }; app.students.push(student); app.pdfs.push(pdf);
  const manual = manualRecords(student), migrated = migrateState(app);
  assert.deepEqual(migrated.students[0].reportApproval, student.reportApproval); assert.deepEqual(currentManualRecords(migrated.students[0]), manual);
  assert.deepEqual(stateReferenceErrors(migrated), []);
});

test('code-less replacements match one normalized name and classroom and retain manual B/C', () => {
  const app = state(), first = report(); app.pdfs.push(first);
  const student = registerImportedReport(app, first)!; confirmReport(app, first.id); const manual = manualRecords(student);
  const replacement = report({ name: 'BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRÉS ADRIÁN.pdf', areas: [{ areaId: 'math', grades: [['B', 'A', 'AD']], validated: false }] }); app.pdfs.push(replacement);
  assert.equal(registerImportedReport(app, replacement)?.id, student.id); assert.equal(app.students.length, 1);
  assert.equal(first.status, 'replaced'); assert.equal(student.reportApproval, undefined); assert.deepEqual(currentManualRecords(student), manual);
});

test('homonyms and students from another classroom never silently merge', () => {
  const app = state();
  for (const code of ['HOM-1', 'HOM-2']) app.students.push(createStudent({ code, name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2', section: 'F' }, app.settings));
  const pdf = report(); app.pdfs.push(pdf);
  assert.equal(registerImportedReport(app, pdf), null); assert.equal(pdf.studentId, null); assert.equal(app.students.length, 2);
  assert.throws(() => confirmReport(app, pdf.id), (error: unknown) => error instanceof ReportWorkflowError && error.status === 409);
  const separate = state(), other = createStudent({ code: 'OTHER', name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '3', section: 'F' }, separate.settings); separate.students.push(other);
  const second = report(); separate.pdfs.push(second); const student = registerImportedReport(separate, second)!;
  assert.notEqual(student.id, other.id); assert.equal(separate.students.length, 2); assert.equal(other.pdfIds.length, 0);
});

test('a recognized existing code resolves homonyms and unsupported classrooms remain blocked', () => {
  const app = state();
  for (const code of ['HOM-1', 'HOM-2']) app.students.push(createStudent({ code, name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2', section: 'F' }, app.settings));
  const pdf = report({ extractedCode: 'HOM-2' }); app.pdfs.push(pdf);
  assert.equal(registerImportedReport(app, pdf)?.id, app.students[1].id);
  const invalid = report({ name: 'libreta.pdf', extractedName: 'Nombre Completo', extractedGrade: '6', extractedSection: 'F' }); app.pdfs.push(invalid);
  assert.equal(registerImportedReport(app, invalid), null);
  assert.throws(() => confirmReport(app, invalid.id, { name: 'Nombre Corregido' }), (error: unknown) => error instanceof ReportWorkflowError && error.status === 400);
  assert.throws(() => identifyReport(app, invalid.id, { name: 'Nombre Corregido', grade: '2', section: 'A' }), (error: unknown) => error instanceof ReportWorkflowError && error.status === 400);
});


test('a manual name and classroom correction reuses a unique existing student and blocks homonyms', () => {
  const app = state(), student = createStudent({ code: 'EXISTING', name: 'ANA PÉREZ', grade: '2', section: 'F' }, app.settings);
  app.students.push(student); const manual = manualRecords(student);
  const pdf = report({ name: 'libreta.pdf' }); app.pdfs.push(pdf);
  identifyReport(app, pdf.id, { name: 'ANA PEREZ', grade: '2', section: 'F' });
  assert.equal(app.students.length, 1); assert.equal(pdf.studentId, student.id); assert.equal(pdf.confirmedIdentity?.code, student.code);
  assert.deepEqual(currentManualRecords(student), manual);
  const ambiguous = state();
  for (const code of ['FIRST', 'SECOND']) ambiguous.students.push(createStudent({ code, name: 'ANA PEREZ', grade: '2', section: 'F' }, ambiguous.settings));
  const unlinked = report({ name: 'libreta.pdf' }); ambiguous.pdfs.push(unlinked);
  assert.throws(() => identifyReport(ambiguous, unlinked.id, { name: 'ANA PEREZ', grade: '2', section: 'F' }), (error: unknown) => error instanceof ReportWorkflowError && error.status === 409);
  assert.equal(ambiguous.students.length, 2); assert.equal(unlinked.studentId, null);
});
