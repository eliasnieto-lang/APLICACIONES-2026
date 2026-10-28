import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilenameIdentity, parseReportFilename, resolveReportIdentity } from '../shared/filename-identity.js';
import { normalizeCohort } from '../shared/policy.js';

test('reads the complete ordered name and canonical classroom from the report filename', () => {
  assert.deepEqual(parseReportFilename('BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf'), {
    name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2.º de secundaria', section: 'F',
  });
  assert.deepEqual(parseReportFilename('C:\\boletas\\BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.PDF'), {
    name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2.º de secundaria', section: 'F',
  });
});

test('recognizes common report prefixes, grade arrangements, explicit years and sections', () => {
  for (const filename of [
    'LIBRETA_DE_NOTAS_3ro_F_Pérez_García_Ana_María.pdf',
    'Informe de progreso del estudiante_tercer grado de secundaria_F_Pérez_García_Ana_María.pdf',
    'BOLETA_2026_3F_Pérez_García_Ana_María.pdf',
    'Reporte_3ro_F_Secundaria_Pérez_García_Ana_María_2026.pdf',
    'Pérez_García_Ana_María_3ro_F_Secundaria_año escolar 2026.pdf',
  ]) assert.deepEqual(parseReportFilename(filename), { name: 'Pérez García Ana María', grade: '3.º de secundaria', section: 'F' }, filename);
  assert.deepEqual(parseReportFilename('/tmp/4.º de secundaria_Sección «F»_Muñoz_D’Ávila_José-Luis.pdf'), {
    name: 'Muñoz D’Ávila José-Luis', grade: '4.º de secundaria', section: 'F',
  });
});

test('accepts names alone without inventing a code or classroom and preserves written names', () => {
  assert.deepEqual(parseReportFilename('SEGURA_CAMONES_ANDRES_ADRIAN.pdf'), { name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '', section: '' });
  assert.deepEqual(parseReportFilename('Segundo_Núñez_Ana.pdf'), { name: 'Segundo Núñez Ana', grade: '', section: '' });
  assert.equal(parseReportFilename('BOLETA_2F_DE-LA-CRUZ_O\'CONNOR_ANA.pdf').name, 'DE-LA-CRUZ O\'CONNOR ANA');
});

test('generic files and unexplained numeric suffixes cannot become student names', () => {
  for (const filename of ['documento-sin-identidad-1.pdf', 'report.pdf', 'foto1.pdf', 'documento_sin_identidad.pdf', 'BOLETA.pdf', 'informe_de_progreso.pdf', 'original_review.pdf', 'original_failed.pdf', 'fuera_de_aula.pdf', 'Pérez_García_Ana_12.pdf', 'Pérez_García_Ana_2026.pdf']) {
    assert.equal(parseReportFilename(filename).name, '', filename);
  }
});

test('unsupported classrooms remain unsupported instead of borrowing a supported grade', () => {
  for (const filename of ['BOLETA_6F_PEREZ_GARCIA_ANA.pdf', 'BOLETA_25_F_PEREZ_GARCIA_ANA.pdf', 'BOLETA_2do_F_Primaria_PEREZ_GARCIA_ANA.pdf']) {
    const identity = parseReportFilename(filename);
    assert.equal(identity.name, 'PEREZ GARCIA ANA', filename);
    assert.equal(normalizeCohort(identity.grade, identity.section), null, filename);
  }
  assert.equal(parseReportFilename('BOLETA_6F_PEREZ_GARCIA_ANA.pdf').grade, '6');
});

test('fifth F is recognized precisely in filenames and grade normalization', () => {
  for (const filename of [
    'BOLETA_5F_PEREZ_GARCIA_ANA.pdf',
    'BOLETA_5to año F_Secundaria_PEREZ_GARCIA_ANA.pdf',
    'LIBRETA_quinto grado de secundaria_Sección F_PEREZ_GARCIA_ANA.pdf',
    'PEREZ_GARCIA_ANA_5.º de secundaria_F.pdf',
  ]) assert.deepEqual(parseReportFilename(filename), { name: 'PEREZ GARCIA ANA', grade: '5.º de secundaria', section: 'F' }, filename);
  for (const grade of ['5', '5.º', '5°', '5o', '5to', 'quinto', 'quinto grado de secundaria']) {
    assert.equal(normalizeCohort(grade, 'F')?.grade, '5.º de secundaria', grade);
    assert.equal(normalizeCohort(grade, 'G')?.section, 'G', grade);
  }
  for (const grade of ['15', '25', '5ro', '5do', '5to primaria', 'pre 5', '5to de secundaria extra']) assert.equal(normalizeCohort(grade, 'F'), null, grade);
});

test('all five secondary grades and single-letter classrooms are recognized precisely', () => {
  for (const [filename, grade, section] of [
    ['BOLETA_1ro_A_Secundaria_PEREZ_GARCIA_ANA.pdf', '1.º de secundaria', 'A'],
    ['LIBRETA_primer grado de secundaria_Sección B_PEREZ_GARCIA_ANA.pdf', '1.º de secundaria', 'B'],
    ['BOLETA_2do_A_Secundaria_PEREZ_GARCIA_ANA.pdf', '2.º de secundaria', 'A'],
    ['BOLETA_3ro_C_Secundaria_PEREZ_GARCIA_ANA.pdf', '3.º de secundaria', 'C'],
    ['BOLETA_4to_Z_Secundaria_PEREZ_GARCIA_ANA.pdf', '4.º de secundaria', 'Z'],
    ['BOLETA_5to_G_Secundaria_PEREZ_GARCIA_ANA.pdf', '5.º de secundaria', 'G'],
  ]) assert.deepEqual(parseReportFilename(filename), { name: 'PEREZ GARCIA ANA', grade, section }, filename);
  for (const grade of ['1', '1.º', '1°', '1o', '1ro', '1ero', '1er', 'primero', 'primer grado de secundaria', '1ro año de secundaria']) {
    assert.equal(normalizeCohort(grade, ' a ')?.label, '1.º A', grade);
  }
  for (const [grade, section] of [['1', 'AA'], ['1', '1'], ['1', ''], ['6', 'B'], ['12', 'A'], ['1do', 'A'], ['1ro primaria', 'A']]) {
    assert.equal(normalizeCohort(grade, section), null, `${grade} ${section}`);
  }
});

test('filename values precede PDF text, while missing filename fields retain existing readings', () => {
  const pdf = { name: 'BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf', extractedName: 'OTRO ESTUDIANTE', extractedGrade: '5', extractedSection: 'A' };
  assert.deepEqual(resolveReportIdentity(pdf), { name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '2.º de secundaria', section: 'F' });
  assert.deepEqual(resolveReportIdentity({ ...pdf, name: 'report.pdf' }), { name: 'OTRO ESTUDIANTE', grade: '5', section: 'A' });
  assert.deepEqual(resolveReportIdentity({ ...pdf, name: 'SEGURA_CAMONES_ANDRES_ADRIAN.pdf' }), { name: 'SEGURA CAMONES ANDRES ADRIAN', grade: '5', section: 'A' });
});

test('conflicting filename classrooms remain visible instead of falling back to a valid text classroom', () => {
  const pdf = { name: 'BOLETA_2F_PEREZ_GARCIA_ANA_Sección A.pdf', extractedName: 'Texto PDF', extractedGrade: '2', extractedSection: 'F' };
  const identity = resolveReportIdentity(pdf);
  assert.equal(identity.name, 'PEREZ GARCIA ANA');
  assert.equal(identity.section, 'A / F');
  assert.notEqual(identity.grade, '2.º de secundaria');
});

test('manual edits including explicit blanks and prior confirmed corrections take precedence', () => {
  const pdf = { name: 'BOLETA_2F_SEGURA_CAMONES_ANDRES_ADRIAN.pdf', extractedName: 'Texto PDF', extractedGrade: '5', extractedSection: 'A', confirmedIdentity: { code: '', name: 'Corrección Confirmada', grade: '4.º de secundaria', section: 'F' } };
  assert.deepEqual(resolveReportIdentity(pdf), { name: 'Corrección Confirmada', grade: '4.º de secundaria', section: 'F' });
  assert.equal(resolveReportIdentity({ ...pdf, manualName: '  Nueva   Corrección  ' }).name, 'Nueva Corrección');
  assert.equal(resolveReportIdentity({ ...pdf, manualName: '' }).name, '');
});

test('applying filename identity updates present fields and preserves unrelated PDF source fields', () => {
  const pdf = { name: 'SEGURA_CAMONES_ANDRES_ADRIAN.pdf', extractedName: 'Texto PDF', extractedGrade: '3', extractedSection: 'F', extractedCode: 'KEEP-1', text: 'Calificaciones originales' };
  assert.equal(applyFilenameIdentity(pdf), pdf);
  assert.equal(pdf.extractedName, 'SEGURA CAMONES ANDRES ADRIAN');
  assert.equal(pdf.extractedGrade, '3');
  assert.equal(pdf.extractedSection, 'F');
  assert.equal(pdf.extractedCode, 'KEEP-1');
  assert.equal(pdf.text, 'Calificaciones originales');
});
