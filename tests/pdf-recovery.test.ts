import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractPdf, parseReportText } from '../server/pdf.js';
import { mergePdfReadings, needsPdfRecovery } from '../shared/pdf-recovery.js';
import type { Settings } from '../shared/types.js';

const settings: Settings = {
  year: 2027, version: 'recovery-test',
  areas: [{ id: 'math', name: 'Matemática', group: 'math', competencies: ['Resuelve problemas de cantidad', 'Resuelve problemas de regularidad'], eligible: true }],
  academicWeights: { general: .4, specialized: .4, progress: .2 }, scienceWeight: .6,
  performanceWeights: { attendance: .6, discipline: .4 }, commitmentWeights: { participation: .7, family: .3 },
  criteriaApproved: false, naPolicy: 'pending', naPolicyApproved: false, disciplineTypes: [], activityTypes: [], familyTypes: [], closed: false,
};
const identity = 'Código de estudiante: SC-001\nEstudiante: Ana Perez\nGrado: 3\nSección: F\nPeriodo: 2026';
const grades = 'MATEMATICA\nResuelve problemas de cantidad AD B C\nResuelve problemas de regularidad A B AD';

test('recovery is needed for a missing header even with complete native grades', () => {
  assert.equal(needsPdfRecovery(parseReportText(grades, settings)), true);
  assert.equal(needsPdfRecovery(parseReportText(`${identity}\n${grades}`, settings)), false);
  assert.equal(needsPdfRecovery(parseReportText(identity, settings)), true);
});

test('filename identity skips metadata OCR while missing grades still require recovery', () => {
  assert.equal(needsPdfRecovery(parseReportText(grades, settings), false), false);
  assert.equal(needsPdfRecovery(parseReportText('MATEMATICA\nResuelve problemas de cantidad A - B', settings), false), true);
});

test('independent OCR fills a missing identity without making repeated native grade rows conflict', () => {
  const native = parseReportText(grades, settings);
  const result = mergePdfReadings(native, parseReportText(`${identity}\n${grades}`, settings), settings);
  assert.equal(result.extractedCode, 'SC-001');
  assert.equal(result.extractedName, 'Ana Perez');
  assert.deepEqual(result.areas[0].grades, [['AD', 'B', 'C'], ['A', 'B', 'AD']]);
  assert.equal(result.ocr, true);
  assert.equal(result.areas[0].validated, false);
  assert.ok(!result.warnings.some(warning => /no reconocido|no reconocidos|repetida/.test(warning)));
  assert.equal(native.extractedName, '', 'native reading remains unchanged');
});

test('equivalent accented names and ordinal grades permit filling a missing code', () => {
  const native = parseReportText('Estudiante: ANA PÉREZ\nGrado: 3.º\nSección: F\nPeriodo: 2026', settings);
  const result = mergePdfReadings(native, parseReportText(identity, settings), settings);
  assert.equal(result.extractedCode, 'SC-001');
  assert.equal(result.extractedName, 'ANA PÉREZ');
  assert.equal(result.extractedGrade, '3.º');
});

test('a conflicting student or period cannot supply missing identity or grades', () => {
  for (const conflict of ['Código de estudiante: OTHER-02', 'Estudiante: Otro Alumno', 'Periodo: 2025']) {
    const field = conflict.split(':')[0];
    const source = identity.split('\n').map(line => line.startsWith(`${field}:`) ? conflict : line).join('\n');
    const native = parseReportText(identity.replace(/\nGrado: 3/, ''), settings);
    const result = mergePdfReadings(native, parseReportText(`${source}\n${grades}`, settings), settings);
    assert.equal(result.extractedGrade, '');
    assert.deepEqual(result.areas[0].grades[0], ['', '', '']);
    assert.ok(result.warnings.some(warning => warning.includes('sin combinar datos incompatibles')));
  }
});

test('OCR fills aligned blank cells but leaves a conflicting native row untouched', () => {
  const native = parseReportText(`${identity}\nMATEMATICA\nResuelve problemas de cantidad A - C\nResuelve problemas de regularidad A - AD`, settings);
  const recognized = parseReportText(`${identity}\nMATEMATICA\nResuelve problemas de cantidad B AD C\nResuelve problemas de regularidad A B AD`, settings);
  const result = mergePdfReadings(native, recognized, settings);
  assert.deepEqual(result.areas[0].grades, [['A', '', 'C'], ['A', 'B', 'AD']]);
  assert.ok(result.warnings.some(warning => warning.includes('sin combinar esa fila')));
  assert.ok(result.warnings.some(warning => warning.includes('5 de 6 casillas')));
});

/** Reuse the fictitious scan as an image XObject, retaining only its identity header. */
async function makeMixedPdf(nativeLines: string[], logo = false): Promise<Buffer> {
  const fixture = (await readFile(path.join(import.meta.dirname, 'fixtures', 'scanned.pdf'))).toString('latin1');
  const image = fixture.match(/3 0 obj\s*([\s\S]*?)\s*endobj/)?.[1];
  assert.ok(image);
  const drawing = logo ? 'q 40 0 0 40 40 720 cm /Im0 Do Q' : 'q 0 680 612 162 re W n 612 0 0 842 0 0 cm /Im0 Do Q';
  const text = `BT /F1 12 Tf 40 620 Td 22 TL ${nativeLines.map((line, index) => `${index ? 'T* ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET`;
  const content = `${drawing}\n${text}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    image,
  ];
  let result = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result, 'latin1'));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result, 'latin1');
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, 'latin1');
}

test('a raster identity header is recovered when every native grade is already recognized', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'circulos-header-'));
  try {
    const file = path.join(directory, 'header-and-native-grades.pdf');
    await writeFile(file, await makeMixedPdf(grades.split('\n')));
    const result = await extractPdf(file, settings);
    assert.equal(result.ocr, true);
    assert.equal(result.extractedCode, 'SC-001');
    assert.equal(result.extractedName, 'Ana Perez');
    assert.equal(result.extractedGrade, '3');
    assert.equal(result.extractedSection, 'B');
    assert.equal(result.period, '2026');
    assert.deepEqual(result.areas[0].grades, [['AD', 'B', 'C'], ['A', 'B', 'AD']]);
    assert.ok(!result.warnings.some(warning => warning.includes('no reconocido')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a small high-resolution logo does not force OCR for missing metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'circulos-logo-'));
  try {
    const file = path.join(directory, 'native-with-logo.pdf');
    await writeFile(file, await makeMixedPdf(grades.split('\n'), true));
    const result = await extractPdf(file, settings);
    assert.equal(result.ocr, false);
    assert.equal(result.extractedCode, '');
    assert.deepEqual(result.areas[0].grades, [['AD', 'B', 'C'], ['A', 'B', 'AD']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
