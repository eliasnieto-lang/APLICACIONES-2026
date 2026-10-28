import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extractPdf, parseReportText } from '../server/pdf.js';
import { layoutPdfText, mergePdfReadings, needsPdfRecovery, needsRenderedGradeRecovery } from '../shared/pdf-recovery.js';
import { defaultSettings } from '../shared/defaults.js';
import { SUPPLEMENTAL_REPORT_AREAS } from '../shared/report-catalog.js';
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

test('browser coordinate layout preserves compact grade cells and their header columns', () => {
  const word = (text: string, x: number, y: number, width = text.length * 2.5) => ({ text, x, y, width, height: 6 });
  const text = layoutPdfText([
    word('Competencias Bimestre', 10, 10), word('I', 155, 10), word('II', 175, 10), word('III', 195, 10), word('IV', 215, 10),
    word('MATEMATICA', 10, 20),
    word('Resuelve problemas de cantidad', 10, 30, 135), word('A', 155, 30, 19.8), word('B', 175, 30, 19.8), word('C', 195, 30), word('AD', 215, 30),
    word('Resuelve problemas de regularidad', 10, 40, 135), word('B', 175, 40), word('C', 195, 40), word('AD', 215, 40),
  ]);
  const lines = text.split('\n');
  assert.ok(/A\s+B\s+C\s+AD$/.test(lines[2]), 'small gaps must not concatenate A/B/C grade items');
  assert.equal(lines[0].indexOf('II'), lines[3].indexOf('B'), 'missing first grade retains the physical II column');
  assert.deepEqual(parseReportText(text, settings).areas[0].grades, [['A', 'B', 'C'], ['', 'B', 'C']]);
});

test('a split AD glyph is retained as one grade', () => {
  const text = layoutPdfText([
    { text: 'A', x: 10, y: 10, width: 4, height: 6 },
    { text: 'D', x: 14.1, y: 10, width: 4, height: 6 },
    { text: 'B', x: 30, y: 10, width: 4, height: 6 },
    { text: 'C', x: 50, y: 10, width: 4, height: 6 },
  ]);
  assert.ok(/^AD\s+B\s+C$/.test(text));
});

test('missing vector grades trigger rendering only for a recognizable grade table or an explicit grade rescan', () => {
  const incomplete = parseReportText(`${identity}\nCompetencias Bimestre I II III IV\nMATEMATICA\nResuelve problemas de cantidad X X X X`, settings);
  assert.equal(needsRenderedGradeRecovery(incomplete, settings), true);
  const withoutTable = parseReportText(`${identity}\nMATEMATICA\nResuelve problemas de cantidad X X X`, settings);
  assert.equal(needsRenderedGradeRecovery(withoutTable, settings), false);
  assert.equal(needsRenderedGradeRecovery(withoutTable, settings, true), true);
  assert.equal(needsRenderedGradeRecovery(parseReportText(`${identity}\n${grades}`, settings), settings, true), false);
  assert.equal(needsRenderedGradeRecovery(parseReportText(`${identity}\nCompetencias Bimestre I II III IV\nTexto sin competencias reconocibles`, settings), settings), false);
});

test('recovery is needed for a missing header even with complete native grades', () => {
  assert.equal(needsPdfRecovery(parseReportText(grades, settings)), true);
  assert.equal(needsPdfRecovery(parseReportText(`${identity}\n${grades}`, settings)), false);
  assert.equal(needsPdfRecovery(parseReportText(identity, settings)), true);
});

test('filename identity skips metadata OCR while missing grades still require recovery', () => {
  assert.equal(needsPdfRecovery(parseReportText(grades, settings), false), false);
  assert.equal(needsPdfRecovery(parseReportText('MATEMATICA\nResuelve problemas de cantidad A - B', settings), false), true);
});

const englishGrades = SUPPLEMENTAL_REPORT_AREAS[0].competencies.map((competency, index) => `${competency} ${index ? 'A B AD' : 'AD B C'}`).join('\n');

test('only detected additional subjects contribute missing cells to automatic recovery', () => {
  const base = `${identity}\n${grades}`;
  assert.equal(needsPdfRecovery(parseReportText(base, settings)), false, 'absent additional subjects are not missing data');
  const incomplete = parseReportText(`${base}\nCompetencias Bimestre I II III IV\nINGLES\n${SUPPLEMENTAL_REPORT_AREAS[0].competencies[0]} A - C`, settings);
  assert.equal(incomplete.supplementalAreas?.length, 1);
  assert.equal(needsPdfRecovery(incomplete), true);
  assert.equal(needsRenderedGradeRecovery(incomplete, settings), true);
  const complete = parseReportText(`${base}\nINGLES\n${englishGrades}`, settings);
  assert.equal(needsPdfRecovery(complete), false);
  assert.equal(needsRenderedGradeRecovery(complete, settings, true), false);
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

test('additional OCR subjects merge by subject and competency while retaining native row conflicts', () => {
  const english = SUPPLEMENTAL_REPORT_AREAS[0];
  const native = parseReportText(`${identity}\n${grades}\nINGLES\n${english.competencies[0]} A - C\n${english.competencies[1]} A - AD`, settings);
  const physicalEducation = SUPPLEMENTAL_REPORT_AREAS[1];
  const recognized = parseReportText(`${identity}\n${grades}\nINGLES\n${englishGrades}\nEDUCACION FISICA\n${physicalEducation.competencies.map(competency => `${competency} B C A`).join('\n')}`, settings);
  // Definitions, rather than array offsets, identify the independent OCR rows.
  const source = recognized.supplementalAreas![0];
  source.definition.competencies.reverse();
  source.grades.reverse();
  const result = mergePdfReadings(native, recognized, settings);
  assert.deepEqual(result.supplementalAreas?.find(area => area.definition.id === 'ingles')?.grades, [['A', '', 'C'], ['A', 'B', 'AD'], ['A', 'B', 'AD']]);
  assert.deepEqual(result.supplementalAreas?.find(area => area.definition.id === 'educacion-fisica')?.grades, [['B', 'C', 'A'], ['B', 'C', 'A'], ['B', 'C', 'A']]);
  assert.ok(result.warnings.some(warning => warning.includes('sin combinar esa fila')));
  assert.deepEqual(native.supplementalAreas?.[0].grades[1], ['A', '', 'AD'], 'native evidence remains unchanged');
});

test('an incompatible OCR identity cannot add an additional subject', () => {
  const native = parseReportText(`${identity}\n${grades}`, settings);
  const recognized = parseReportText(`${identity.replace('Ana Perez', 'Otra Persona')}\nINGLES\n${englishGrades}`, settings);
  const result = mergePdfReadings(native, recognized, settings);
  assert.equal(result.supplementalAreas, undefined);
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

test('an actual compact native PDF supplies every I–III catalog grade', async () => {
  const { makeCompactPdf } = createRequire(import.meta.url)('./compact-report-fixture.cjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'circulos-compact-'));
  try {
    const file = path.join(directory, 'compact.pdf');
    await writeFile(file, makeCompactPdf(defaultSettings, { code: 'SC-001', name: 'Ana Perez', grade: '3' }));
    const result = await extractPdf(file, defaultSettings);
    assert.equal(result.ocr, false, 'the compact table must be understood directly from its native text');
    assert.equal(result.areas.flatMap(area => area.grades.flat()).filter(Boolean).length, 45);
    for (const area of result.areas) for (const row of area.grades) assert.deepEqual(row, ['C', 'B', 'A']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an actual compact native PDF also supplies all printed additional subject grades', async () => {
  const { makeCompactPdf } = createRequire(import.meta.url)('./compact-report-fixture.cjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'circulos-all-subjects-'));
  try {
    const file = path.join(directory, 'all-subjects.pdf');
    await writeFile(file, makeCompactPdf(defaultSettings, { code: 'SC-001', name: 'Ana Perez', grade: '3', additionalAreas: SUPPLEMENTAL_REPORT_AREAS }));
    const result = await extractPdf(file, defaultSettings);
    assert.equal(result.ocr, false);
    assert.equal(result.supplementalAreas?.length, 5);
    assert.equal([...result.areas, ...(result.supplementalAreas || [])].flatMap(area => area.grades.flat()).filter(Boolean).length, 78);
    for (const area of result.supplementalAreas || []) for (const row of area.grades) assert.deepEqual(row, ['C', 'B', 'A']);
    assert.equal(needsPdfRecovery(result), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Visible vector text with an unusable extraction map, so no raster can trigger OCR. */
function makeVectorGradePdf(tableHeader: boolean): Buffer {
  const clean = (value: string) => value.replace(/[\\()]/g, '\\$&');
  const draw = (value: string, x: number, y: number, font = 'F1', size = 20) => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${clean(value)}) Tj ET`;
  // Keep an intact native identity layer while the test isolates vector grade recovery.
  const commands = identity.split('\n').map((line, index) => `q BT 3 Tr /F1 14 Tf 1 0 0 1 40 ${790 - index * 24} Tm (${clean(line.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))}) Tj ET Q`);
  commands.push(draw('MATEMATICA', 40, 640));
  if (tableHeader) commands.push(draw('Competencias                         Bimestre I II III', 40, 612, 'F1', 14));
  for (const [index, competency] of settings.areas[0].competencies.entries()) {
    const y = 570 - index * 40;
    commands.push(draw(competency.toUpperCase(), 40, y, 'F1', 16));
    const values = index ? ['A', 'B', 'AD'] : ['AD', 'B', 'C'];
    values.forEach((value, column) => commands.push(draw(value, 420 + column * 60, y, 'F2', 20)));
  }
  const stream = commands.join('\n');
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /UnusableGrades def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n4 beginbfchar\n<41> <0058>\n<42> <0059>\n<43> <005A>\n<44> <0051>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 7 0 R >>',
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('vector-only grades are rendered automatically for a table and on a forced grade rescan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'circulos-vector-'));
  try {
    for (const tableHeader of [true, false]) {
      const file = path.join(directory, `vector-${tableHeader}.pdf`);
      await writeFile(file, makeVectorGradePdf(tableHeader));
      const result = await extractPdf(file, settings, { forceGrades: !tableHeader });
      assert.equal(result.ocr, true);
      assert.deepEqual(result.areas[0].grades, [['AD', 'B', 'C'], ['A', 'B', 'AD']], result.text);
      assert.equal(result.extractedCode, 'SC-001');
      assert.equal(result.extractedName, 'Ana Perez');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
