import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudent, defaultSettings } from '../shared/defaults';
import { migrateState } from '../shared/migrations';
import { settingsSchema, stateSchema } from '../server/validation';
import type { AppState } from '../shared/types';

function previousEvaluation(): AppState {
  const settings = structuredClone(defaultSettings);
  delete settings.bimesterWeights;
  delete settings.academicScoringPolicy;
  settings.criteriaApproved = true;
  settings.closed = true;
  settings.dimensionWeights = { academic: .55, performance: .25, commitment: .2 };
  const student = createStudent({ code: 'MIG-1', name: 'ESTUDIANTE PRUEBA MIGRACION', grade: '4', section: 'F', commitmentEnabled: false, noContestParticipation: true, circleStatus: 'remains' }, settings);
  student.academic.forEach(area => { area.grades = area.grades.map(() => ['A', 'A', 'AD', 'B']); area.validated = true; });
  student.academic[0].grades[0][0] = 'AD';
  student.attendance = { required: 200, exempted: 0, attended: 190, punctual: 180, validated: true };
  student.discipline = { confirmed: true, incidents: [] };
  student.family = [{ id: 'FAM-1', name: 'Reunión de familias', date: '2026-07-10', required: true, status: 'fulfilled', justification: '', evidence: '', validated: true }];
  student.validated = { academic: true, performance: true, commitment: true };
  student.pdfIds = ['PDF-MIG-1'];
  student.reportApproval = { pdfId: 'PDF-MIG-1', approvedAt: '2026-08-12T12:00:00.000Z' };
  student.history = [{ id: 'HIST-1', date: '2026-08-12T12:00:00.000Z', field: 'Validación manual de Académico', before: 'false', after: 'true' }];
  return { settings, students: [student], pdfs: [{
    id: 'PDF-MIG-1', name: 'BOLETA_4to año F_Secundaria_ESTUDIANTE_PRUEBA_MIGRACION.pdf', hash: 'a'.repeat(64), size: 100, uploadedAt: '2026-08-10T12:00:00.000Z', status: 'validated', studentId: student.id,
    extractedCode: student.code, extractedName: student.name, extractedGrade: student.grade, extractedSection: student.section, period: '2026', text: 'Lectura original conservada', ocr: false, warnings: [], areas: structuredClone(student.academic),
    confirmedIdentity: { code: student.code, name: student.name, grade: student.grade, section: student.section },
  }] };
}

test('La fórmula bimestral nueva migra una evaluación anterior sin modificar datos ni revisiones', () => {
  const previous = previousEvaluation(), retained = structuredClone(previous);
  assert.equal(stateSchema.safeParse(previous).success, true, 'El respaldo anterior sigue aceptándose sin los campos nuevos.');
  const current = migrateState(stateSchema.parse(JSON.parse(JSON.stringify(previous))));
  assert.deepEqual(current.settings.bimesterWeights, { first: .25, second: .25, third: .5 });
  assert.equal(current.settings.academicScoringPolicy, 'weighted_bimesters_common_progression');
  assert.equal(current.settings.criteriaApproved, false);
  assert.equal(current.settings.closed, true);
  assert.deepEqual(current.settings.dimensionWeights, retained.settings.dimensionWeights);
  assert.deepEqual(current.students, retained.students, 'Se conservan notas, AD históricos, B/C, decisiones, historial y revisiones.');
  assert.deepEqual(current.pdfs, retained.pdfs, 'No se reescribe la extracción ni la aprobación del PDF.');
  assert.deepEqual(previous, retained, 'La migración no muta su entrada.');
});

test('La migración de ponderación se aplica una sola vez y conserva una aprobación posterior', () => {
  const once = migrateState(previousEvaluation());
  assert.deepEqual(migrateState(once), once);
  once.settings.criteriaApproved = true;
  assert.deepEqual(migrateState(once), once, 'Recargar no vuelve a invalidar los criterios aprobados con la nueva fórmula.');
  once.settings.bimesterWeights = { first: .2, second: .3, third: .5 };
  assert.deepEqual(migrateState(once).settings.bimesterWeights, once.settings.bimesterWeights, 'Una configuración explícita bajo la política actual no se sobrescribe.');
});

test('Los nuevos campos de configuración conservan compatibilidad y validan sus tipos', () => {
  const settings = structuredClone(defaultSettings);
  assert.equal(settingsSchema.safeParse(settings).success, true);
  assert.equal(settingsSchema.safeParse({ ...settings, bimesterWeights: { first: .25, second: .25, third: 1.01 } }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, academicScoringPolicy: 'otra-politica' }).success, false);
  delete settings.bimesterWeights;
  delete settings.academicScoringPolicy;
  assert.equal(settingsSchema.safeParse(settings).success, true);
});
