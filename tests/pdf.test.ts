import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractPdf, parseReportText } from '../server/pdf.js';
import type { Settings } from '../shared/types.js';

const settings: Settings = {
  year: 2027, version: 'test',
  areas: [{ id: 'math', name: 'Matemática', group: 'math', competencies: ['Resuelve problemas de cantidad', 'Resuelve problemas de regularidad'], eligible: true }],
  academicWeights: { general: .4, specialized: .4, progress: .2 }, scienceWeight: .6,
  performanceWeights: { attendance: .6, discipline: .4 }, commitmentWeights: { participation: .7, family: .3 },
  criteriaApproved: false, naPolicy: 'pending', naPolicyApproved: false, disciplineTypes: [], activityTypes: [], familyTypes: [], closed: false,
};
const text = `Codigo de estudiante: ST-001\nEstudiante: Ana Perez\nGrado: 3\nSeccion: B\nPeriodo: 2026\nMATEMATICA\nCompetencias                    I   II   III   IV\nResuelve problemas de cantidad   A   A    AD    A\nResuelve problemas de regularidad  A B - C\n`;

function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 11 Tf 40 790 Td 16 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('reads identity and four ordered bimesters; missing cell remains empty', () => {
  const result = parseReportText(text, settings);
  assert.equal(result.extractedCode, 'ST-001');
  assert.equal(result.extractedName, 'Ana Perez');
  assert.equal(result.extractedGrade, '3');
  assert.equal(result.extractedSection, 'B');
  assert.equal(result.period, '2026');
  assert.deepEqual(result.areas[0].grades, [['A', 'A', 'AD', 'A'], ['A', 'B', '', 'C']]);
  assert.equal(result.areas[0].validated, false);
});

test('unknown competencies do not populate another student row or invent grades', () => {
  const result = parseReportText('Matematica\nOtra competencia A A A A\n', settings);
  assert.deepEqual(result.areas[0].grades, [['', '', '', ''], ['', '', '', '']]);
  assert.ok(result.warnings.some(w => w.includes('no pudieron vincularse')));
  assert.equal(result.extractedCode, '');
});

test('conflicting duplicate competency versions clear that row for human review', () => {
  const result = parseReportText(text + '\nResuelve problemas de cantidad B B B B', settings);
  assert.deepEqual(result.areas[0].grades[0], ['', '', '', '']);
  assert.ok(result.warnings.some(w => w.includes('repetida')));
});

test('extracts a real PDF through poppler', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'circulos-test-'));
  try {
    const file = path.join(dir, 'libreta.pdf');
    await writeFile(file, makePdf(text.split('\n')));
    const result = await extractPdf(file, settings);
    assert.equal(result.extractedCode, 'ST-001');
    assert.deepEqual(result.areas[0].grades[0], ['A', 'A', 'AD', 'A']);
    assert.equal(result.ocr, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects disguised non-PDF files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'circulos-test-'));
  try {
    const file = path.join(dir, 'fake.pdf');
    await writeFile(file, 'This is not a PDF');
    await assert.rejects(extractPdf(file, settings), /PDF válido/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OCR reads a scanned PDF and marks its cells as unvalidated', async () => {
  const result = await extractPdf(path.join(import.meta.dirname, 'fixtures', 'scanned.pdf'), settings);
  assert.equal(result.ocr, true);
  assert.equal(result.extractedCode, 'SC-001');
  assert.ok(result.text.includes('Ana Perez'));
  assert.equal(result.areas[0].validated, false);
  assert.ok(result.warnings.some(w => w.includes('OCR aplicado')));
  const localSpanish = await access(path.join(import.meta.dirname, '..', '.tools', 'tessdata', 'spa.traineddata')).then(() => true, () => false);
  if (localSpanish) assert.ok(!result.warnings.some(w => w.includes('idioma inglés')));
});

test('mixed PDF uses OCR for image grades despite a native header longer than 100 characters', async () => {
  const result = await extractPdf(path.join(import.meta.dirname, 'fixtures', 'mixed.pdf'), settings);
  assert.equal(result.ocr, true);
  assert.ok(result.text.includes('CABECERA NATIVA'));
  assert.ok(result.text.includes('Ana Perez'));
  assert.equal(result.extractedCode, 'SC-001');
  assert.deepEqual(result.areas[0].grades[0], ['A', 'A', 'AD', 'A']);
  assert.equal(result.areas[0].validated, false);
});

test('digital-only unrecognized text is preserved without unnecessary OCR', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'circulos-test-'));
  try {
    const file = path.join(dir, 'native-without-grades.pdf');
    await writeFile(file, makePdf([
      'CABECERA NATIVA. Este documento contiene texto digital y ninguna imagen.',
      'La estructura de sus notas requiere transcripcion manual sin interpretar valores.',
      'Estudiante: Ana Perez',
    ]));
    const result = await extractPdf(file, settings);
    assert.equal(result.ocr, false);
    assert.ok(result.text.includes('CABECERA NATIVA'));
    assert.deepEqual(result.areas[0].grades[0], ['', '', '', '']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
