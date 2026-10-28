import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractPdf, parseReportText } from '../server/pdf.js';
import type { Settings } from '../shared/types.js';
import { SUPPLEMENTAL_REPORT_AREAS } from '../shared/report-catalog.js';

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

test('reads identity and retains only I–III from four ordered bimesters; missing cell remains empty', () => {
  const result = parseReportText(text, settings);
  assert.equal(result.extractedCode, 'ST-001');
  assert.equal(result.extractedName, 'Ana Perez');
  assert.equal(result.extractedGrade, '3');
  assert.equal(result.extractedSection, 'B');
  assert.equal(result.period, '2026');
  assert.deepEqual(result.areas[0].grades, [['A', 'A', 'AD'], ['A', 'B', '']]);
  assert.equal(result.areas[0].validated, false);
});

test('reads three native bimesters without needing a fourth column', () => {
  const result = parseReportText(`Código del estudiante: ST-003
Apellidos y nombres: Pérez García Ana María
Grado y sección: 3.º F
Periodo: 2026
Matemática
Resuelve problemas de cantidad A B C
Resuelve problemas de regularidad AD - A`, settings);
  assert.equal(result.extractedCode, 'ST-003');
  assert.equal(result.extractedName, 'Pérez García Ana María');
  assert.equal(result.extractedGrade, '3.º');
  assert.equal(result.extractedSection, 'F');
  assert.deepEqual(result.areas[0].grades, [['A', 'B', 'C'], ['AD', '', 'A']]);
  assert.ok(!result.warnings.some(warning => warning.includes('no corresponde a')));
});

test('student code is read from its own label even when school modular code appears first', () => {
  const result = parseReportText('Código modular: 1234567\nCódigo del estudiante: 00012345678901\nDNI: 88888888', settings);
  assert.equal(result.extractedCode, '00012345678901');
  assert.equal(parseReportText('Código modular: 1234567\nDNI: 88888888\nCódigo: ABC123', settings).extractedCode, '');
  assert.equal(parseReportText('Código modular del estudiante: 1234567', settings).extractedCode, '');
});

test('reads separate surname and given-name labels without absorbing nearby identity fields', () => {
  const result = parseReportText('Apellidos: PÉREZ GARCÍA    Nombres: ANA MARÍA    Grado: 2°    Sección: F\nCódigo estudiante: AL-02', settings);
  assert.equal(result.extractedName, 'PÉREZ GARCÍA ANA MARÍA');
  assert.equal(result.extractedCode, 'AL-02');
  assert.equal(result.extractedGrade, '2°');
  assert.equal(result.extractedSection, 'F');
  const split = parseReportText('Apellidos: López Ríos\nNombres: José Luis\nGrado/Sección: cuarto de secundaria - "F"', settings);
  assert.equal(split.extractedName, 'López Ríos José Luis');
  assert.equal(split.extractedGrade, 'cuarto de secundaria');
  assert.equal(split.extractedSection, 'F');
  const separateSurnames = parseReportText('Apellido paterno: López    Apellido materno: Ríos    Nombres: José Luis', settings);
  assert.equal(separateSurnames.extractedName, 'López Ríos José Luis');
});

test('missing identity is not replaced by a different labelled field or a later line', () => {
  const result = parseReportText('Código de estudiante:\nMATEMATICA\nEstudiante: Grado: 3\nSección: F\nApellidos: Pérez', settings);
  assert.equal(result.extractedCode, '');
  assert.equal(result.extractedName, '');
  assert.equal(parseReportText('Código del estudiante: Grado: 3', settings).extractedCode, '');
  assert.ok(result.warnings.some(warning => warning.includes('Apellidos y nombres completos no reconocidos')));
  assert.equal(parseReportText('Estudiante:\nMATEMATICA', settings).extractedName, '');
});

test('reads no-colon SIAGIE student labels without borrowing school or DNI identifiers', () => {
  for (const label of ['Código del estudiante', 'Código de estudiante', 'Código estudiante', 'Código del educando', 'Código del alumno', 'Cod. Estudiante', 'Código de matrícula']) {
    const result = parseReportText(`INFORME DE PROGRESO DEL ESTUDIANTE
Código modular 1234567
DNI 87654321
${label} 00012345678901
Nombres y apellidos del estudiante ANA MARÍA PÉREZ GARCÍA
Grado de estudios TERCER GRADO DE SECUNDARIA    Sección «F»
Año escolar 2026`, settings);
    assert.equal(result.extractedCode, '00012345678901', label);
    assert.equal(result.extractedName, 'ANA MARÍA PÉREZ GARCÍA', label);
    assert.equal(result.extractedGrade, 'TERCER GRADO DE SECUNDARIA', label);
    assert.equal(result.extractedSection, 'F', label);
    assert.equal(result.period, '2026', label);
  }
});

test('reads wrapped identity labels followed by a distinct value line', () => {
  const result = parseReportText(`INFORME DE PROGRESO DEL ESTUDIANTE
Código modular
1234567
Código del
estudiante
00012345678901
APELLIDOS Y
NOMBRES DEL ESTUDIANTE
PÉREZ GARCÍA ANA MARÍA
Grado
TERCERO
Sección
F
Periodo
2026`, settings);
  assert.equal(result.extractedCode, '00012345678901');
  assert.equal(result.extractedName, 'PÉREZ GARCÍA ANA MARÍA');
  assert.equal(result.extractedGrade, 'TERCERO');
  assert.equal(result.extractedSection, 'F');
  assert.equal(result.period, '2026');
});

test('reads aligned header/value columns and preserves an empty student-code cell', () => {
  const widths = [20, 26, 14, 38, 26, 12];
  const row = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] || 0)).join('');
  const header = row(['Código modular', 'Código del educando', 'DNI', 'Apellidos y nombres', 'Grado', 'Sección', 'Año escolar']);
  const values = ['1234567', '00012345678901', '87654321', 'PÉREZ GARCÍA ANA MARÍA', 'TERCERO', 'F', '2026'];
  const result = parseReportText(`INFORME DE PROGRESO DEL ESTUDIANTE\n${header}\n${row(values)}`, settings);
  assert.equal(result.extractedCode, '00012345678901');
  assert.equal(result.extractedName, 'PÉREZ GARCÍA ANA MARÍA');
  assert.equal(result.extractedGrade, 'TERCERO');
  assert.equal(result.extractedSection, 'F');
  assert.equal(result.period, '2026');
  values[1] = '';
  const missingCode = parseReportText(`${header}\n${row(values)}`, settings);
  assert.equal(missingCode.extractedCode, '');
  assert.equal(missingCode.extractedName, 'PÉREZ GARCÍA ANA MARÍA');
  assert.equal(missingCode.extractedGrade, 'TERCERO');
  assert.equal(missingCode.extractedSection, 'F');
  const collapsed = parseReportText('Código estudiante Apellidos y nombres\n00012345678901 PÉREZ GARCÍA ANA MARÍA', settings);
  assert.equal(collapsed.extractedCode, '');
  assert.equal(collapsed.extractedName, '');
});

test('keeps conflicts and staff identity empty while preserving complete explicitly labelled values', () => {
  const conflict = parseReportText('Código estudiante: AB-1\nCódigo estudiante: AB_1\nApellidos y nombres: Pérez Ana\nApellidos y nombres: López Rosa', settings);
  assert.equal(conflict.extractedCode, '');
  assert.equal(conflict.extractedName, '');
  const staff = parseReportText('Apellidos y nombres del director: PÉREZ GARCÍA ANA\nNombres y apellidos del apoderado\nLÓPEZ RÍOS JOSÉ', settings);
  assert.equal(staff.extractedName, '');
  assert.equal(parseReportText('Código estudiante: OWNER-A\nEstudiante: Estudiante Real', settings).extractedName, 'Estudiante Real');
  assert.equal(parseReportText('Código estudiante: ABCD', settings).extractedCode, 'ABCD');
  const stacked = parseReportText('Código estudiante\nREC-review\nApellidos y nombres\nEstudiante Recuperado review', settings);
  assert.equal(stacked.extractedCode, 'REC-review');
  assert.equal(stacked.extractedName, 'Estudiante Recuperado review');
});

test('cohorts outside 2.º F, 3.º F and 4.º F remain visible and require correction', () => {
  for (const pair of ['Grado: 1\nSección: F', 'Grado: 3\nSección: A', 'Grado: 5\nSección: F', 'Grado: 2 primaria\nSección: F', 'Grado: 25\nSección: F']) {
    const result = parseReportText(pair, settings);
    assert.ok(result.warnings.some(warning => warning.includes('no corresponde a 2.º F, 3.º F o 4.º F')));
  }
  const missing = parseReportText('Apellidos y nombres: Pérez Ana', settings);
  assert.equal(missing.extractedGrade, '');
  assert.equal(missing.extractedSection, '');
});

test('unknown competencies do not populate another student row or invent grades', () => {
  const result = parseReportText('Matematica\nOtra competencia A A A A\n', settings);
  assert.deepEqual(result.areas[0].grades, [['', '', ''], ['', '', '']]);
  assert.ok(result.warnings.some(w => w.includes('no pudieron vincularse')));
  assert.equal(result.extractedCode, '');
});

test('conflicting duplicate competency versions clear that row for human review', () => {
  const result = parseReportText(text + '\nResuelve problemas de cantidad B B B B', settings);
  assert.deepEqual(result.areas[0].grades[0], ['', '', '']);
  assert.ok(result.warnings.some(w => w.includes('repetida')));
});

test('the ignored fourth bimester cannot make otherwise identical active rows conflict', () => {
  const result = parseReportText(text + '\nResuelve problemas de cantidad A A AD C', settings);
  assert.deepEqual(result.areas[0].grades[0], ['A', 'A', 'AD']);
  assert.ok(!result.warnings.some(warning => warning.includes('repetida')));
});

test('rows with extra cells are left blank instead of shifting the bimester order', () => {
  const result = parseReportText('Matemática\nResuelve problemas de cantidad A B C A B', settings);
  assert.deepEqual(result.areas[0].grades[0], ['', '', '']);
  assert.ok(result.warnings.some(warning => warning.includes('no pudieron vincularse')));
});

test('recognizes wrapped uppercase DPCC and science area headings', () => {
  const expanded: Settings = { ...settings, areas: [
    ...settings.areas,
    { id: 'dpcc', name: 'Desarrollo Personal, Ciudadanía y Cívica', group: 'dpcc', competencies: ['Construye su identidad', 'Convive y participa democráticamente'], eligible: true },
    { id: 'science', name: 'Ciencia y Tecnología', group: 'science', competencies: ['Indaga mediante métodos científicos para construir sus conocimientos'], eligible: true },
  ] };
  const result = parseReportText(`DESARROLLO PERSONAL,
CIUDADANÍA Y CÍVICA
Construye su identidad AD A B
Convive y participa democráticamente A B C
CIENCIA Y
TECNOLOGÍA
Indaga mediante métodos científicos
para construir sus conocimientos B AD A`, expanded);
  assert.deepEqual(result.areas[1].grades, [['AD', 'A', 'B'], ['A', 'B', 'C']]);
  assert.deepEqual(result.areas[2].grades, [['B', 'AD', 'A']]);
});

test('uses printed bimester positions when an aligned middle cell is empty', () => {
  const heading = 'Competencias'.padEnd(52) + 'I'.padEnd(8) + 'II'.padEnd(8) + 'III'.padEnd(8) + 'IV';
  const row = 'Resuelve problemas de cantidad'.padEnd(52) + 'A'.padEnd(8) + ''.padEnd(8) + 'AD'.padEnd(8) + 'C';
  const result = parseReportText(`Matemática\n${heading}\n${row}`, settings);
  assert.deepEqual(result.areas[0].grades[0], ['A', '', 'AD']);
});

test('an area outside the catalog cannot reuse the previous area competencies', () => {
  const result = parseReportText('Matemática\nResuelve problemas de cantidad A B C\nINGLÉS\nResuelve problemas de regularidad AD AD AD', settings);
  assert.deepEqual(result.areas[0].grades, [['A', 'B', 'C'], ['', '', '']]);
});

const compactSettings: Settings = { ...settings, areas: [
  { id: 'math', name: 'Matemática', group: 'math', eligible: true, competencies: ['Resuelve problemas de cantidad', 'Resuelve problemas de regularidad, equivalencia y cambio', 'Resuelve problemas de forma, movimiento y localización', 'Resuelve problemas de gestión de datos e incertidumbre'] },
  { id: 'science', name: 'Ciencia y Tecnología', group: 'science', eligible: true, competencies: ['Indaga mediante métodos científicos', 'Explica el mundo físico', 'Diseña y construye soluciones tecnológicas'] },
  { id: 'communication', name: 'Comunicación', group: 'communication', eligible: true, competencies: ['Se comunica oralmente en su lengua materna', 'Lee diversos tipos de textos', 'Escribe diversos tipos de textos'] },
  { id: 'social', name: 'Ciencias Sociales', group: 'social', eligible: true, competencies: ['Construye interpretaciones históricas', 'Gestiona responsablemente el espacio y el ambiente', 'Gestiona responsablemente los recursos económicos'] },
  { id: 'dpcc', name: 'Desarrollo Personal, Ciudadanía y Cívica', group: 'dpcc', eligible: true, competencies: ['Construye su identidad', 'Convive y participa democráticamente'] },
] };
const compactExpected = [
  [['A', 'B', 'AD'], ['C', 'AD', 'B'], ['B', 'C', 'A'], ['AD', 'A', 'C']],
  [['C', 'B', 'AD'], ['A', 'AD', 'C'], ['B', 'A', 'AD']],
  [['AD', 'C', 'B'], ['B', 'AD', 'A'], ['C', 'A', 'B']],
  [['A', 'C', 'AD'], ['AD', 'B', 'C'], ['B', 'A', 'C']],
  [['C', 'AD', 'A'], ['AD', 'C', 'B']],
];
const compactHeading = 'ÁREA'.padEnd(50) + 'COMPETENCIAS'.padEnd(200) + ['I', 'II', 'III', 'IV'].map(value => value.padEnd(8)).join('');
const compactRow = (area: string, competency: string, cells: string[]) => area.padEnd(50) + competency.padEnd(200) + cells.map(value => value.padEnd(8)).join('');

test('compact SIAGIE rows read all 45 active grades when the area shares its first competency line', () => {
  const printed = [
    ['MATEMÁTICA', 'RESUELVE PROBLEMAS DE CANTIDAD'],
    ['', 'RESUELVE PROBLEMAS DE REGULARIDAD'],
    ['', 'RESUELVE PROBLEMAS DE FORMA'],
    ['', 'RESUELVE PROBLEMAS DE GESTIÓN DE DATOS'],
    ['CIENCIA Y TECNOLOGÍA', 'INDAGA MEDIANTE MÉTODOS CIENTÍFICOS PARA CONSTRUIR SUS CONOCIMIENTOS'],
    ['', 'EXPLICA EL MUNDO FÍSICO BASÁNDOSE EN CONOCIMIENTOS SOBRE LOS SERES VIVOS, MATERIA Y ENERGÍA, BIODIVERSIDAD, TIERRA Y UNIVERSO'],
    ['', 'DISEÑA Y CONSTRUYE SOLUCIONES TECNOLÓGICAS PARA RESOLVER PROBLEMAS DE SU ENTORNO'],
    ['COMUNICACIÓN', 'SE COMUNICA ORALMENTE'],
    ['', 'LEE DIVERSOS TIPOS DE TEXTOS ESCRITOS EN SU LENGUA MATERNA'],
    ['', 'ESCRIBE DIVERSOS TIPOS DE TEXTOS EN SU LENGUA MATERNA'],
    ['CIENCIAS SOCIALES', 'CONSTRUYE INTERPRETACIONES HISTÓRICAS'],
    ['', 'GESTIONA RESPONSABLEMENTE EL ESPACIO Y EL AMBIENTE'],
    ['', 'GESTIONA RESPONSABLEMENTE LOS RECURSOS ECONÓMICOS'],
    ['DESARROLLO PERSONAL, CIUDADANÍA Y CÍVICA', 'CONSTRUYE SU IDENTIDAD'],
    ['', 'CONVIVE Y PARTICIPA DEMOCRÁTICAMENTE EN LA BÚSQUEDA DEL BIEN COMÚN'],
  ];
  const expected = compactExpected.flat();
  const report = parseReportText([compactHeading, ...printed.map(([area, label], index) => compactRow(area, label, [...expected[index], 'C']))].join('\n'), compactSettings);
  assert.deepEqual(report.areas.map(area => area.grades), compactExpected);
  assert.equal(report.areas.flatMap(area => area.grades.flat()).filter(Boolean).length, 45);
  assert.ok(!report.warnings.some(warning => warning.includes('casillas del catálogo') || warning.includes('no pudieron vincularse')));
});

test('wrapped area cells beside the first competency retain every active grade with a blank IV', () => {
  const lines = [compactHeading];
  for (const [areaIndex, area] of compactSettings.areas.entries()) {
    const areaLines = areaIndex === 1 ? ['CIENCIA Y', 'TECNOLOGÍA'] : areaIndex === 4 ? ['DESARROLLO PERSONAL,', 'CIUDADANÍA Y CÍVICA'] : [area.name];
    area.competencies.forEach((label, competency) => {
      lines.push(compactRow(competency === 0 ? areaLines[0] : '', label, [...compactExpected[areaIndex][competency], '']));
      if (competency === 0 && areaLines[1]) lines.push(areaLines[1]);
    });
  }
  const report = parseReportText(lines.join('\n'), compactSettings);
  assert.deepEqual(report.areas.map(area => area.grades), compactExpected);
});

test('native missing first, middle and last cells preserve their printed columns even with one or two grades', () => {
  const rows = [
    compactRow('MATEMÁTICA', compactSettings.areas[0].competencies[0], ['', 'B', 'AD', 'C']),
    compactRow('', compactSettings.areas[0].competencies[1], ['A', '', 'C', '']),
    compactRow('', compactSettings.areas[0].competencies[2], ['', '', 'B', '']),
    compactRow('', compactSettings.areas[0].competencies[3], ['', '', '', 'AD']),
  ];
  const report = parseReportText([compactHeading, ...rows].join('\n'), compactSettings);
  assert.deepEqual(report.areas[0].grades, [['', 'B', 'AD'], ['A', '', 'C'], ['', '', 'B'], ['', '', '']]);
});

test('explicit table delimiters preserve blanks and exclude the fourth column', () => {
  const report = parseReportText(`| MATEMÁTICA | Resuelve problemas de cantidad | | AD | C | B |
| | Resuelve problemas de regularidad | B | | AD | |`, settings);
  assert.deepEqual(report.areas[0].grades, [['', 'AD', 'C'], ['B', '', 'AD']]);
});

test('separately drawn grade cells are associated only with the preceding identifiable competency', () => {
  const cells = ['A', '', 'AD', 'C'].map((cell, index) => ' '.repeat(250 + index * 8) + cell).filter(line => line.trim());
  const report = parseReportText([compactHeading, 'MATEMÁTICA', 'Resuelve problemas de cantidad', ...cells, 'Otra competencia', ' '.repeat(250) + 'B', ' '.repeat(258) + 'C', ' '.repeat(266) + 'AD'].join('\n'), settings);
  assert.deepEqual(report.areas[0].grades, [['A', '', 'AD'], ['', '', '']]);
});

test('a neighboring unknown area or an unrelated prefix cannot donate grades to configured competencies', () => {
  const report = parseReportText(`MATEMÁTICA Resuelve problemas de cantidad A B C
INGLÉS Resuelve problemas de regularidad AD AD AD
MATEMÁTICA
Resumen de clase Resuelve problemas de regularidad C C C
Resuelve problemas de regularidad A B C
Resuelve problemas de regularidad AD AD AD
Resuelve problemas de regularidad A B C`, settings);
  assert.deepEqual(report.areas[0].grades, [['A', 'B', 'C'], ['', '', '']]);
  assert.ok(report.warnings.some(warning => warning.includes('repetida')));
});

test('all ten report subjects retain 78 scanned grades without changing the approved five-area catalog', () => {
  const original = structuredClone(compactSettings);
  const rows = [compactHeading];
  for (const area of [...compactSettings.areas, ...SUPPLEMENTAL_REPORT_AREAS]) {
    area.competencies.forEach((competency, index) => rows.push(compactRow(index === 0 ? area.name : '', competency, ['AD', 'B', 'C', 'A'])));
  }
  const report = parseReportText(rows.join('\n'), compactSettings);
  assert.equal(report.areas.length, 5);
  assert.equal(report.supplementalAreas?.length, 5);
  assert.deepEqual(report.supplementalAreas?.map(area => area.definition.id), ['ingles', 'educacion-fisica', 'arte-cultura', 'educacion-religiosa', 'educacion-trabajo']);
  assert.equal([...report.areas, ...(report.supplementalAreas || [])].flatMap(area => area.grades.flat()).filter(Boolean).length, 78);
  for (const extra of report.supplementalAreas || []) for (const grades of extra.grades) assert.deepEqual(grades, ['AD', 'B', 'C']);
  assert.deepEqual(compactSettings, original);
  assert.ok(!report.warnings.some(warning => warning.includes('casillas del catálogo')));
});

test('only supplemental subjects printed in the report contribute to expected cells or returned definitions', () => {
  const rows = [compactHeading, ...compactSettings.areas.flatMap(area => area.competencies.map((competency, index) => compactRow(index === 0 ? area.name : '', competency, ['A', 'B', 'C', ''])))];
  const base = parseReportText(rows.join('\n'), compactSettings);
  assert.equal(base.supplementalAreas, undefined);
  assert.ok(!base.warnings.some(warning => warning.includes('casillas del catálogo')));
  rows.push('EDUCACIÓN FÍSICA', compactRow('', 'Asume una vida saludable', ['AD', '', 'B', '']));
  const partial = parseReportText(rows.join('\n'), compactSettings);
  assert.deepEqual(partial.supplementalAreas?.map(area => area.definition.id), ['educacion-fisica']);
  assert.deepEqual(partial.supplementalAreas?.[0].grades, [['', '', ''], ['AD', '', 'B'], ['', '', '']]);
  assert.ok(partial.warnings.some(warning => warning.includes('47 de 54')));
});

test('OCR whitespace artifacts are tolerated without substituting letters or matching an unrelated prefix', () => {
  const report = parseReportText(`MATEMÁTICA
Resuelve problem as DECANTIDAD AD B C
Resuelve problemas DEREGULARIDAD A B AD`, settings);
  assert.deepEqual(report.areas[0].grades, [['AD', 'B', 'C'], ['A', 'B', 'AD']]);
  const unknown = parseReportText(`MATEMÁTICA
Resuelve problemas de cantidades AD AD AD
Resuelve problemas de regubridad C C C`, settings);
  assert.deepEqual(unknown.areas[0].grades, [['', '', ''], ['', '', '']]);
});

test('an area and its first competency may both wrap across the same two table lines', () => {
  const report = parseReportText(`CIENCIA Y          Indaga mediante métodos
TECNOLOGÍA         científicos para construir sus conocimientos A B C
DESARROLLO PERSONAL,       Convive y participa
CIUDADANÍA Y CÍVICA        democráticamente AD C B`, compactSettings);
  assert.deepEqual(report.areas[1].grades[0], ['A', 'B', 'C']);
  assert.deepEqual(report.areas[4].grades[1], ['AD', 'C', 'B']);
});

test('explicit English and religion text cannot populate a stale Communication or DPCC area', () => {
  const report = parseReportText(`COMUNICACIÓN
Se comunica oralmente en inglés como lengua extranjera A B C
Lee diversos tipos de textos escritos en inglés como lengua extranjera AD B C
Escribe diversos tipos de textos en inglés como lengua extranjera B C AD
DESARROLLO PERSONAL, CIUDADANÍA Y CÍVICA
Construye su identidad como persona humana, amada por Dios, digna, libre y trascendente C C C`, compactSettings);
  assert.deepEqual(report.areas[2].grades, [['', '', ''], ['', '', ''], ['', '', '']]);
  assert.deepEqual(report.areas[4].grades, [['', '', ''], ['', '', '']]);
});

test('extracts a real PDF through poppler', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'circulos-test-'));
  try {
    const file = path.join(dir, 'libreta.pdf');
    await writeFile(file, makePdf(text.split('\n')));
    const result = await extractPdf(file, settings);
    assert.equal(result.extractedCode, 'ST-001');
    assert.deepEqual(result.areas[0].grades[0], ['A', 'A', 'AD']);
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
  assert.deepEqual(result.areas[0].grades[0], ['A', 'A', 'AD']);
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
    assert.deepEqual(result.areas[0].grades[0], ['', '', '']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
