import type { AcademicArea, Grade, Settings, Student, SupplementalArea } from './types.js';
import { ACTIVE_BIMESTERS, normalizeCohort } from './policy.js';
import { SUPPLEMENTAL_REPORT_AREAS } from './report-catalog.js';
import { hasActiveGrades, omittedCompetencyIndexes } from './academic-policy.js';

export interface ExtractedReport {
  extractedCode: string;
  extractedName: string;
  extractedGrade: string;
  extractedSection: string;
  period: string;
  text: string;
  ocr: boolean;
  warnings: string[];
  areas: AcademicArea[];
  supplementalAreas?: SupplementalArea[];
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const areaAliases: Record<string, string[]> = {
  math: ['matematica', 'matematicas'],
  science: ['ciencia y tecnologia', 'ciencia tecnologia', 'ciencia tecnologia y ambiente'],
  communication: ['comunicacion'],
  social: ['ciencias sociales'],
  dpcc: ['desarrollo personal ciudadania y civica', 'desarrollo personal ciudadania civica', 'dpcc'],
};

export const REPORT_REVIEW_WARNING = 'Lectura provisional: confirme identidad, áreas, competencias y orden I–III comparando con el PDF original.';
export const PDF_GRADE_PARSER_VERSION = 3;

type IdentityField = 'code' | 'name' | 'surnames' | 'paternal' | 'maternal' | 'given' | 'grade' | 'section' | 'cohort' | 'period' | 'ignore';
interface IdentityLabel { field: IdentityField; start: number; end: number; line: number; lastLine: number; column: number }

// Long labels precede their component labels. Whitespace also permits a PDF to wrap a label.
const identityLabelPattern = /\b(?:c[oó]d(?:igo|\.)?\s*(?:de(?:l)?\s*)?(?:estudiante|educando|alumno(?:\(a\))?|est\.?|alum\.?)|c[oó]digo\s+modular(?:\s+del?\s+estudiante)?|c[oó]digo\s+de\s+matr[ií]cula|(?:apellidos\s*(?:y|,|\/)\s*nombres|nombres\s*(?:y|,|\/)\s*apellidos)(?:\s+del?\s+(?:estudiante|educando|alumno(?:\(a\))?|director|tutor|apoderado|docente))?|apellido\s+paterno|apellido\s+materno|grado\s*(?:y|\/|-)\s*secci[oó]n|grado(?:\s+de\s+estudios?)?|secci[oó]n|a[ñn]o(?:\s+(?:escolar|lectivo|acad[eé]mico))?|per[ií]odo|fecha\s+de\s+nacimiento|DNI|c[oó]digo|nivel|sexo|nombres|apellidos|estudiante|alumno(?:\(a\))?|tutor|director|docente)\b/gi;

function identityField(label: string): IdentityField {
  const value = normalize(label);
  if (/^(codigo|cod) (?:de |del )?(?:estudiante|educando|alumno|est|alum)$/.test(value) || value === 'codigo de matricula') return 'code';
  if (/^(?:apellidos (?:y )?nombres|nombres (?:y )?apellidos)/.test(value)) return /\b(?:director|tutor|apoderado|docente)\b/.test(value) ? 'ignore' : 'name';
  if (/^(?:estudiante|alumno)/.test(value)) return 'name';
  if (value === 'apellidos') return 'surnames';
  if (value === 'apellido paterno') return 'paternal';
  if (value === 'apellido materno') return 'maternal';
  if (value === 'nombres') return 'given';
  if (/^grado.*seccion$/.test(value)) return 'cohort';
  if (/^grado/.test(value)) return 'grade';
  if (value === 'seccion') return 'section';
  if (/^(?:ano|periodo)/.test(value)) return 'period';
  return 'ignore';
}

const gradeExpression = '(?:[0-9]{1,2}(?:\\s*\\.?(?:[°ºo]|do|ro|to|ero|er))?|primero|primer|segundo|tercero|tercer|cuarto|quinto|sexto)(?:\\s+grado)?(?:\\s+(?:de\\s+)?(?:educaci[oó]n\\s+)?(?:secundaria|primaria))?';
const trimField = (value: string): string => value.replace(/^[\s:：=#|]+|[\s|]+$/g, '').replace(/\s+/g, ' ').trim();

function validIdentityValue(field: IdentityField, raw: string): string {
  const value = trimField(raw);
  if (!value || value.length > 180) return '';
  if (field === 'code') return /^[A-Z0-9][A-Z0-9_-]{1,29}$/i.test(value) && !/^(?:matematicas?|comunicacion|competencias?|dpcc|bimestres?|secundaria|primaria|pendiente|ninguno)$/i.test(normalize(value)) ? value : '';
  if (field === 'grade') return new RegExp(`^${gradeExpression}$`, 'i').test(value) ? value : '';
  if (field === 'section') return value.match(/^["'“”«»]?([A-Z])["'“”«»]?$/i)?.[1].toUpperCase() || '';
  if (field === 'cohort') return new RegExp(`^(${gradeExpression})[\\s,;|/\\-]+["'“”«»]?([A-Z])["'“”«»]?$`, 'i').test(value) ? value : '';
  if (field === 'period') return /^(20\d{2})$/.test(value) ? value : '';
  if (field === 'ignore') return '';
  // Do not promote titles, institutional fields, or an area heading to a person's name.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s'’.,-]*$/u.test(value) || /\b(?:informe|progreso|instituci[oó]n|educativa|grado|secci[oó]n|matem[aá]tica|comunicaci[oó]n|competencias?|secundaria|primaria|director|docente|apoderado|tutor|ciencia|ciudadan[ií]a|c[ií]vica|sociales|nacimiento)\b/i.test(value)) return '';
  const words = value.match(/[\p{L}\p{M}]+/gu) || [];
  return words.length >= (field === 'name' ? 2 : 1) ? value : '';
}

/** Read explicit identity labels and their own cells; never infer a code from DNI or school data. */
function readIdentity(source: string): { extractedCode: string; extractedName: string; extractedGrade: string; extractedSection: string; period: string } {
  const text = source.replace(/\r/g, '').replace(/\t/g, '        ');
  const lines = text.split('\n');
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const middle = (low + high) >> 1; if (lineStarts[middle] <= offset) low = middle; else high = middle; }
    return low;
  };
  const labels: IdentityLabel[] = [];
  for (const match of text.matchAll(identityLabelPattern)) {
    const start = match.index;
    const line = lineAt(start);
    // A title ending in “del estudiante” is not a separate identity label.
    const prefix = text.slice(lineStarts[line], start);
    if (/^(?:estudiante|alumno)/i.test(match[0]) && prefix.trim() && !/(?: {2,}|\|\s*)$/.test(prefix)) continue;
    const previous = labels.at(-1);
    if (/^(?:estudiante|alumno)/i.test(match[0]) && previous?.field === 'name' && previous.lastLine === line - 1 && !trimField(text.slice(previous.end, start)) && !/^\s*[:：=]/.test(text.slice(start + match[0].length, lineStarts[line] + lines[line].length))) continue;
    if (identityField(match[0]) === 'grade' && previous?.field === 'grade' && previous.lastLine === line && validIdentityValue('grade', text.slice(previous.end, start)) && !/^\s*[:：=]/.test(text.slice(start + match[0].length, lineStarts[line] + lines[line].length))) continue;
    labels.push({ field: identityField(match[0]), start, end: start + match[0].length, line, lastLine: lineAt(start + match[0].length - 1), column: start - lineStarts[line] });
  }
  const candidates = new Map<IdentityField, Set<string>>();
  const add = (field: IdentityField, raw: string): boolean => {
    const value = validIdentityValue(field, raw);
    if (!value) return false;
    const values = candidates.get(field) || new Set<string>();
    values.add(value); candidates.set(field, values); return true;
  };
  const readCell = (label: IdentityLabel, raw: string): boolean => {
    if (label.field !== 'cohort') return add(label.field, raw);
    const value = validIdentityValue('cohort', raw);
    const pair = value.match(new RegExp(`^(${gradeExpression})[\\s,;|/\\-]+["'“”«»]?([A-Z])["'“”«»]?$`, 'i'));
    if (!pair) return false;
    add('grade', pair[1]); add('section', pair[2]); return true;
  };
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    if (label.field === 'ignore') continue;
    const endOfLine = lineStarts[label.lastLine] + lines[label.lastLine].length;
    const next = labels[index + 1];
    const inlineEnd = next?.line === label.lastLine ? next.start : endOfLine;
    const inline = text.slice(label.end, inlineEnd);
    if (readCell(label, inline)) continue;
    // A nonempty but invalid value cannot borrow a later student's data.
    if (trimField(inline)) continue;
    const rowLabels = labels.filter(item => item.line <= label.lastLine && item.lastLine >= label.line);
    const finalHeaderLine = Math.max(...rowLabels.map(item => item.lastLine));
    const valueLine = finalHeaderLine + 1;
    if (valueLine >= lines.length || labels.some(item => item.line <= valueLine && item.lastLine >= valueLine)) continue;
    const row = lines[valueLine];
    if (rowLabels.length === 1) {
      readCell(label, row);
      continue;
    }
    const ordered = rowLabels.slice().sort((a, b) => a.column - b.column);
    const position = ordered.indexOf(label);
    // Aligned columns preserve a blank code even if DNI or the name follows it.
    const cells = [...row.matchAll(/\S.*?(?= {2,}|\s*\||$)/g)].map(match => ({ value: match[0].replace(/^\|\s*/, '').trim(), column: match.index }));
    const aligned = cells.filter(cell => Math.abs(cell.column - label.column) <= 3);
    if (aligned.length === 1 && readCell(label, aligned[0].value)) continue;
    // Never slice arbitrary characters from a collapsed row: that can produce
    // a plausible but incomplete name or the tail of a different identifier.
    if (cells.length === ordered.length && cells.every((cell, i) => Math.abs(cell.column - ordered[i].column) <= 3)) readCell(label, cells[position].value);
  }
  const unique = (field: IdentityField): string => {
    const values = [...(candidates.get(field) || [])];
    const canonical = new Set(values.map(value => field === 'code' ? value.toUpperCase() : normalize(value)));
    return canonical.size === 1 ? values[0] : '';
  };
  const nameFields: IdentityField[] = ['name', 'surnames', 'paternal', 'maternal', 'given'];
  const conflictingName = nameFields.some(field => (candidates.get(field)?.size || 0) > 1 && !unique(field));
  const surnames = unique('surnames') || [unique('paternal'), unique('maternal')].filter(Boolean).join(' ');
  const given = unique('given');
  const name = unique('name');
  const combined = surnames && given ? `${surnames} ${given}` : '';
  return {
    extractedCode: unique('code'),
    extractedName: conflictingName || name && combined && normalize(name) !== normalize(combined) ? '' : name || combined,
    extractedGrade: unique('grade'), extractedSection: unique('section'), period: unique('period'),
  };
}

/** Summary warnings can be regenerated after independent native/OCR readings are merged. */
export function reportWarnings(report: Pick<ExtractedReport, 'extractedCode' | 'extractedName' | 'extractedGrade' | 'extractedSection' | 'period' | 'areas' | 'supplementalAreas'>, settings: Settings, cohort?: Pick<Student, 'grade' | 'section'>): string[] {
  const warnings: string[] = [];
  if (!report.extractedCode) warnings.push('Código de estudiante no reconocido automáticamente; se necesita una lectura legible del PDF original.');
  if (!report.extractedName) warnings.push('Apellidos y nombres completos no reconocidos automáticamente; se necesita una lectura legible del PDF original.');
  if (!report.extractedGrade || !report.extractedSection) warnings.push('Grado o sección no reconocidos automáticamente; se necesita una lectura legible del PDF original.');
  else if (!normalizeCohort(report.extractedGrade, report.extractedSection)) warnings.push('El aula reconocida debe indicar un grado de 1.º a 5.º de secundaria y una sección de A a Z. Revise el PDF original antes de confirmar.');
  if (!report.period) warnings.push('Año de la libreta no reconocido; confirme que corresponde al periodo de evaluación.');
  else if (Number(report.period) !== settings.year - 1) warnings.push(`La libreta indica ${report.period}; se esperaba ${settings.year - 1}. Revise el periodo.`);
  const courses = [
    ...settings.areas.flatMap(definition => {
      const input = report.areas.find(area => area.areaId === definition.id);
      return input && hasActiveGrades(input) ? [{ definition, grades: input.grades }] : [];
    }),
    ...(report.supplementalAreas || []).filter(hasActiveGrades),
  ];
  const classroom = { grade: cohort?.grade || report.extractedGrade, section: cohort?.section || report.extractedSection };
  const expected = courses.reduce((sum, area) => sum + (area.definition.competencies.length - omittedCompetencyIndexes(area.definition, area, classroom).length) * ACTIVE_BIMESTERS.length, 0);
  const recognized = courses.reduce((sum, area) => {
    const omitted = new Set(omittedCompetencyIndexes(area.definition, area, classroom));
    return sum + area.grades.reduce((total, row, competency) => total + (omitted.has(competency) ? 0 :
      ACTIVE_BIMESTERS.filter((_, index) => ['AD', 'A', 'B', 'C'].includes(row[index] || '')).length), 0);
  }, 0);
  if (!courses.length) warnings.push('No se reconocieron notas en ningún curso de los bimestres I–III. Reintente el escaneo con una copia legible del PDF.');
  else if (recognized < expected) warnings.push(`Se reconocieron ${recognized} de ${expected} casillas del catálogo. Reintente el escaneo con una copia legible del PDF.`);
  return warnings;
}

// Explicit curriculum names cover the abbreviated labels used in compact SIAGIE
// reports. A short phrase is accepted only for its own configured competency.
const competencyLabels = [
  ['resuelve problemas de cantidad'],
  ['resuelve problemas de regularidad', 'resuelve problemas de regularidad equivalencia y cambio'],
  ['resuelve problemas de forma', 'resuelve problemas de forma movimiento y localizacion'],
  ['resuelve problemas de gestion de datos', 'resuelve problemas de gestion de datos e incertidumbre'],
  ['indaga mediante metodos cientificos', 'indaga mediante metodos cientificos para construir sus conocimientos'],
  ['explica el mundo fisico', 'explica el mundo fisico basandose en conocimientos sobre los seres vivos materia y energia biodiversidad tierra y universo'],
  ['disena y construye soluciones tecnologicas', 'disena y construye soluciones tecnologicas para resolver problemas de su entorno'],
  ['se comunica oralmente', 'se comunica oralmente en su lengua materna'],
  ['lee diversos tipos de textos', 'lee diversos tipos de textos escritos en su lengua materna', 'lee diversos tipos de textos en su lengua materna'],
  ['escribe diversos tipos de textos', 'escribe diversos tipos de textos en su lengua materna'],
  ['construye interpretaciones historicas'],
  ['gestiona responsablemente el espacio y el ambiente'],
  ['gestiona responsablemente los recursos economicos'],
  ['construye su identidad'],
  ['convive y participa democraticamente', 'convive y participa democraticamente en la busqueda del bien comun'],
  ['se desenvuelve de manera autonoma', 'se desenvuelve de manera autonoma a traves de su motricidad'],
  ['asume una vida saludable'],
  ['interactua a traves de sus habilidades sociomotrices'],
  ['aprecia de manera critica manifestaciones', 'aprecia de manera critica manifestaciones artistico culturales'],
  ['crea proyectos desde los lenguajes artisticos'],
  ['asume la experiencia del encuentro personal', 'asume la experiencia del encuentro personal y comunitario con dios en su proyecto de vida en coherencia con su creencia religiosa'],
  ['gestiona proyectos de emprendimiento', 'gestiona proyectos de emprendimiento economico o social'],
];

function normalizedLabel(value: string): string {
  return normalize(value).replace(/^(?:competencia\s*)?(?:c\s*)?\d+\s+/, '');
}

function labelsFor(competency: string): string[] {
  const label = normalizedLabel(competency);
  const known = competencyLabels.find(labels => labels.some(candidate => label === candidate || label.startsWith(`${candidate} `)));
  return [...new Set([label, ...(known || [])])];
}

function matchesLabel(line: string, label: string): boolean {
  const candidate = normalizedLabel(line);
  const compact = candidate.replace(/ /g, '');
  // OCR may insert or omit a word space. Removing only whitespace cannot change
  // letters or turn a different competency into a plausible fuzzy match.
  return labelsFor(label).some(known => {
    if (candidate === known || candidate.startsWith(`${known} `)) return true;
    const joined = known.replace(/ /g, '');
    if (compact === joined) return true;
    if (!compact.startsWith(joined)) return false;
    let end = 0, characters = 0;
    while (end < candidate.length && characters < joined.length) { if (candidate[end] !== ' ') characters++; end++; }
    return candidate[end] === ' ';
  });
}

const otherAreaLabels = ['ingles', 'ingles como lengua extranjera', 'educacion fisica', 'arte y cultura', 'educacion religiosa', 'educacion para el trabajo', 'castellano como segunda lengua', 'tutoria', 'tutoria y orientacion educativa'];
const gradeToken = '(?:AD|A|B|C|[-–—?]|S\\/D)';
const gradeSuffix = new RegExp(`(?:^|[\\s|;,])(${gradeToken}(?:[\\s|;,]+${gradeToken})*[\\s|;,]*)$`, 'i');
const gradeTokens = /AD|S\/D|A|B|C|[-–—?]/gi;
interface PrintedGrade { value: string; column: number }
interface PrintedRow { label: string; tokens: PrintedGrade[]; explicitCells?: string[] }

function readPrintedRow(line: string): PrintedRow | undefined {
  // Explicit cell delimiters preserve empty cells without needing text coordinates.
  if ((line.match(/\|/g)?.length || 0) >= 3) {
    const cells = line.split('|');
    if (!cells[0].trim()) cells.shift();
    if (!cells.at(-1)?.trim()) cells.pop(); // remove the outside table border once
    const lastLabel = cells.findLastIndex(cell => cell.trim() && !new RegExp(`^${gradeToken}$`, 'i').test(cell.trim()));
    const grades = cells.slice(lastLabel + 1).map(cell => cell.trim().toUpperCase());
    if (lastLabel >= 0 && grades.length && grades.some(Boolean) && grades.every(cell => !cell || new RegExp(`^${gradeToken}$`, 'i').test(cell))) {
      return { label: cells.slice(0, lastLabel + 1).join(' '), tokens: [], explicitCells: grades };
    }
  }
  const match = line.match(gradeSuffix);
  if (!match) return undefined;
  const offset = (match.index || 0) + match[0].indexOf(match[1]);
  return {
    label: line.slice(0, match.index).trim(),
    tokens: [...match[1].matchAll(gradeTokens)].map(token => ({ value: token[0].toUpperCase(), column: offset + token.index })),
  };
}

/** Parse only identifiable rows; uncertain cells remain empty until a person reviews the source. */
export function parseReportText(text: string, settings: Settings, cohort?: Pick<Student, 'grade' | 'section'>): ExtractedReport {
  const lines = text.replace(/\r/g, '').split('\n').filter(line => line.trim());
  const warnings: string[] = [REPORT_REVIEW_WARNING];
  const identity = readIdentity(text);
  const emptyGrades = (): Grade[] => ACTIVE_BIMESTERS.map(() => '');
  const definitions = [...settings.areas, ...SUPPLEMENTAL_REPORT_AREAS.filter(extra => !settings.areas.some(area => area.id === extra.id || normalize(area.name) === normalize(extra.name)))];
  const areas: AcademicArea[] = definitions.map(area => ({ areaId: area.id, grades: area.competencies.map(emptyGrades), validated: false }));
  const aliases = definitions.map(area => [...new Set([area.name, ...(areaAliases[area.group] || []), ...(area.id === 'ingles' ? ['ingles como lengua extranjera'] : [])].map(normalize))]);
  let currentArea = -1;
  let wrappedLabel = '';
  let areaLabelBuffer = '';
  let gradeColumns: { label: string; column: number }[] = [];
  let ambiguous = 0;
  const seen = new Set<string>();
  const conflicted = new Set<string>();
  const detectedAreas = new Set<number>();
  let pendingCells: PrintedRow | undefined;
  const asGrade = (value: string): Grade => ['AD', 'A', 'B', 'C'].includes(value) ? value as Grade : '';
  const areaFragment = (value: string, areaIndex: number, continuation = false): boolean => aliases[areaIndex].some(alias => {
    if (!value) return false;
    if (alias === value || alias.startsWith(`${value} `)) return true;
    return continuation && (` ${alias} `).includes(` ${value} `);
  });
  const stripAreaFragment = (value: string, areaIndex: number): string => {
    const words = value.split(' ');
    for (let end = words.length; end > 0; end--) {
      const fragment = words.slice(0, end).join(' ');
      if (fragment.length >= 4 && areaFragment(fragment, areaIndex, true)) return words.slice(end).join(' ');
    }
    return value;
  };
  const locate = (raw: string): { area: number; competency: number; label: string } | undefined => {
    const value = normalizedLabel(raw).replace(/^areas?(?: curriculares?)?(?: de)? /, '');
    const matches: { area: number; competency: number; label: string }[] = [];
    for (let area = 0; area < definitions.length; area++) {
      const words = value.split(' ');
      for (let start = 0; start < words.length; start++) {
        const prefix = words.slice(0, start).join(' ');
        if (prefix ? !areaFragment(prefix, area, area === currentArea) && !areaFragment(`${areaLabelBuffer} ${prefix}`.trim(), area) : area !== currentArea) continue;
        const label = words.slice(start).join(' ');
        const joined = label.replace(/ /g, '');
        // Shared opening words do not erase explicit language/religion evidence
        // when the transition to another subject was unreadable.
        if (definitions[area].group === 'communication' && joined.includes('ingles')) continue;
        if (definitions[area].group === 'dpcc' && /(?:comopersonahumana|dios|religion|creenciareligiosa)/.test(joined)) continue;
        if (definitions[area].id === 'ingles' && joined.includes('lenguamaterna')) continue;
        const competencies = definitions[area].competencies.flatMap((competency, index) => matchesLabel(label, competency) ? [index] : []);
        if (competencies.length === 1) matches.push({ area, competency: competencies[0], label });
      }
    }
    const unique = matches.filter((match, index) => matches.findIndex(other => match.area === other.area && match.competency === other.competency) === index);
    return unique.length === 1 ? unique[0] : undefined;
  };
  const cellsFor = (row: PrintedRow): Grade[] | undefined => {
    const source = row.explicitCells || row.tokens.map(token => token.value);
    if (source.length > 4 || !source.length) return undefined;
    if (row.explicitCells) return source.length === 3 || source.length === 4 ? source.slice(0, ACTIVE_BIMESTERS.length).map(asGrade) : undefined;
    if (source.length === 4 || source.length === 3 && gradeColumns.length !== 4) return source.slice(0, ACTIVE_BIMESTERS.length).map(asGrade);
    if (gradeColumns.length < 3) return undefined;
    // Missing native cells have no token. Assign each remaining value only when
    // its printed column identifies one bimester; never slide values to the left.
    const positions = row.tokens.map(token => {
      const distances = gradeColumns.map(heading => Math.abs(heading.column - token.column));
      const closest = distances.indexOf(Math.min(...distances));
      const gap = closest ? gradeColumns[closest].column - gradeColumns[closest - 1].column : gradeColumns[1].column - gradeColumns[0].column;
      return distances[closest] <= Math.max(1, gap / 3) ? closest : -1;
    });
    if (positions.some(position => position < 0) || new Set(positions).size !== positions.length) return undefined;
    const cells = emptyGrades();
    row.tokens.forEach((token, index) => { if (positions[index] < ACTIVE_BIMESTERS.length) cells[positions[index]] = asGrade(token.value); });
    return cells;
  };
  const consume = (row: PrintedRow): void => {
    const candidates = [row.label, `${wrappedLabel} ${row.label}`.trim()];
    const match = candidates.map(locate).find(Boolean);
    wrappedLabel = '';
    if (!match) { ambiguous++; return; }
    currentArea = match.area;
    detectedAreas.add(match.area);
    areaLabelBuffer = '';
    const cells = cellsFor(row);
    if (!cells) { ambiguous++; return; }
    const key = `${match.area}:${match.competency}`;
    if (conflicted.has(key)) return;
    if (seen.has(key)) {
      if (areas[match.area].grades[match.competency].every((cell, index) => cell === cells[index])) return;
      areas[match.area].grades[match.competency] = emptyGrades();
      conflicted.add(key);
      const definition = definitions[match.area];
      warnings.push(`Competencia repetida en ${definition.name}: ${definition.competencies[match.competency]}. Revise la versión aplicable.`);
      return;
    }
    seen.add(key);
    areas[match.area].grades[match.competency] = cells;
  };
  for (const line of lines) {
    let row = readPrintedRow(line);
    // Some PDF drawing orders put all grade cells after the competency text.
    // Keep their original columns until the next labelled row ends the group.
    if (row && !row.label.trim() && !row.explicitCells && wrappedLabel) {
      if (pendingCells) pendingCells.tokens.push(...row.tokens);
      else pendingCells = { label: wrappedLabel, tokens: [...row.tokens] };
      continue;
    }
    if (pendingCells) { consume(pendingCells); pendingCells = undefined; }
    const headings = [...line.matchAll(/\b(IV|III|II|I)\b/g)].map(match => ({ label: match[1], column: match.index }));
    if ((headings.length === 3 || headings.length === 4) && headings.every((heading, index) => heading.label === ['I', 'II', 'III', 'IV'][index]) && /competenc|bimestre|calificaci|^\s*[IV|\s]+$/i.test(line)) {
      gradeColumns = headings; wrappedLabel = ''; continue;
    }
    let label = normalizedLabel(row?.label || line).replace(/^areas?(?: curriculares?)?(?: de)? /, '');
    // A left-hand area cell and its competency can both wrap. Preserve the
    // competency fragment even before it is long enough to identify the row.
    const columns = (row?.label || line).match(/^\s*(\S.*?) {2,}(\S.*)$/);
    if (columns) {
      const fragment = normalize(columns[1]);
      const candidates = definitions.flatMap((_, area) => areaFragment(fragment, area, area === currentArea)
        || areaLabelBuffer && areaFragment(`${areaLabelBuffer} ${fragment}`, area) ? [area] : []);
      if (candidates.length === 1) {
        if (currentArea !== candidates[0]) wrappedLabel = '';
        currentArea = candidates[0]; detectedAreas.add(currentArea); areaLabelBuffer = '';
        label = normalizedLabel(columns[2]);
        if (row) row = { ...row, label };
      }
    }
    // Full area labels can share the first competency's row.
    const complete = aliases.flatMap((names, area) => names.flatMap(name => label === name || label.startsWith(`${name} `) ? [{ area, name }] : [])).sort((a, b) => b.name.length - a.name.length)[0];
    if (complete) {
      currentArea = complete.area; wrappedLabel = ''; areaLabelBuffer = '';
      detectedAreas.add(complete.area);
      label = label.slice(complete.name.length).trim();
      if (!row && !label) continue;
    } else {
      const outside = [...Object.values(areaAliases).flat(), ...otherAreaLabels].map(normalize).some(alias => label === alias || label.startsWith(`${alias} `));
      if (outside && !locate(label)) { currentArea = -1; wrappedLabel = ''; areaLabelBuffer = ''; if (row) ambiguous++; continue; }
    }
    if (row) {
      // Retain the original prefix for locate(), including a wrapped area fragment.
      consume({ ...row, label: complete ? label : row.label });
      continue;
    }
    const match = locate(label);
    if (match) { currentArea = match.area; detectedAreas.add(match.area); areaLabelBuffer = ''; wrappedLabel = match.label; continue; }
    const combined = `${areaLabelBuffer} ${label}`.trim();
    const areaIndex = aliases.findIndex(names => names.includes(combined));
    if (areaIndex >= 0) { currentArea = areaIndex; detectedAreas.add(areaIndex); areaLabelBuffer = ''; wrappedLabel = ''; continue; }
    const partial = [combined, label].find(candidate => candidate && aliases.some(names => names.some(alias => alias.startsWith(`${candidate} `))));
    if (partial) { areaLabelBuffer = partial; currentArea = -1; wrappedLabel = ''; continue; }
    if (currentArea < 0 || /^\s*(?:(?:I|II|III|IV)\b|BIMESTRE|CALIFICACI|NIVEL|COMPETENCIAS?\b|AREA\b)/i.test(line)) continue;
    label = stripAreaFragment(label, currentArea);
    if (label) wrappedLabel = `${wrappedLabel} ${label}`.trim().slice(-700);
  }
  if (pendingCells) consume(pendingCells);
  const configuredAreas = areas.slice(0, settings.areas.length);
  const supplementalAreas = areas.flatMap((area, index) => index >= settings.areas.length && detectedAreas.has(index) ? [{ definition: structuredClone(definitions[index]), grades: area.grades }] : []);
  warnings.push(...reportWarnings({ ...identity, areas: configuredAreas, supplementalAreas }, settings, cohort));
  if (ambiguous) warnings.push(`${ambiguous} fila(s) con notas no pudieron vincularse con seguridad a una competencia del catálogo.`);
  return { ...identity, text, ocr: false, warnings, areas: configuredAreas, ...(supplementalAreas.length ? { supplementalAreas } : {}) };
}
