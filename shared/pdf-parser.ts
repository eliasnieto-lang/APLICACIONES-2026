import type { AcademicArea, Grade, Settings } from './types.js';
import { ACTIVE_BIMESTERS, normalizeCohort } from './policy.js';

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
export function reportWarnings(report: Pick<ExtractedReport, 'extractedCode' | 'extractedName' | 'extractedGrade' | 'extractedSection' | 'period' | 'areas'>, settings: Settings): string[] {
  const warnings: string[] = [];
  if (!report.extractedCode) warnings.push('Código de estudiante no reconocido automáticamente; se necesita una lectura legible del PDF original.');
  if (!report.extractedName) warnings.push('Apellidos y nombres completos no reconocidos automáticamente; se necesita una lectura legible del PDF original.');
  if (!report.extractedGrade || !report.extractedSection) warnings.push('Grado o sección no reconocidos automáticamente; se necesita una lectura legible del PDF original.');
  else if (!normalizeCohort(report.extractedGrade, report.extractedSection)) warnings.push('El aula reconocida no corresponde a 2.º F, 3.º F o 4.º F. Revise el PDF original antes de confirmar.');
  if (!report.period) warnings.push('Año de la libreta no reconocido; confirme que corresponde al periodo de evaluación.');
  else if (Number(report.period) !== settings.year - 1) warnings.push(`La libreta indica ${report.period}; se esperaba ${settings.year - 1}. Revise el periodo.`);
  const expected = settings.areas.reduce((sum, area) => sum + area.competencies.length * ACTIVE_BIMESTERS.length, 0);
  const recognized = report.areas.reduce((sum, area) => sum + area.grades.reduce((total, row) => total + row.filter(Boolean).length, 0), 0);
  if (recognized < expected) warnings.push(`Se reconocieron ${recognized} de ${expected} casillas del catálogo. Las restantes requieren transcripción o revisión manual.`);
  return warnings;
}

function matchesLabel(line: string, label: string): boolean {
  const a = normalize(line).replace(/^(?:competencia )?\d+ /, '');
  const b = normalize(label);
  if (!b) return false;
  return a === b || a.startsWith(`${b} `) || (b.length > 22 && a.includes(b));
}

/** Parse only identifiable rows; uncertain cells remain empty until a person reviews the source. */
export function parseReportText(text: string, settings: Settings): ExtractedReport {
  const lines = text.replace(/\r/g, '').split('\n').filter(line => line.trim());
  const warnings: string[] = [REPORT_REVIEW_WARNING];
  const identity = readIdentity(text);
  const emptyGrades = (): Grade[] => ACTIVE_BIMESTERS.map(() => '');
  const areas: AcademicArea[] = settings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(emptyGrades), validated: false }));
  let currentArea = -1;
  let wrappedLabel = '';
  let areaLabelBuffer = '';
  let gradeColumns: { label: string; column: number }[] = [];
  let ambiguous = 0;
  const seen = new Set<string>();
  // Native reports have three or four bimesters. Keep only I–III; explicit blanks preserve positions.
  const suffix = /(?:^|[\s|;,])((?:AD|A|B|C|[-–—?]|S\/D)(?:[\s|;,]+(?:AD|A|B|C|[-–—?]|S\/D)){2,})\s*$/i;
  for (const line of lines) {
    const headings = [...line.matchAll(/\b(IV|III|II|I)\b/g)].map(match => ({ label: match[1], column: match.index }));
    if ((headings.length === 3 || headings.length === 4) && headings.every((heading, index) => heading.label === ['I', 'II', 'III', 'IV'][index]) && /competenc|bimestre|calificaci|^\s*[IV|\s]+$/i.test(line)) {
      gradeColumns = headings;
      wrappedLabel = '';
      continue;
    }
    const gradeMatch = line.match(suffix);
    const label = gradeMatch ? line.slice(0, gradeMatch.index).trim() : line;
    const normalizedLabel = normalize(label).replace(/^(?:areas?(?: curriculares?)?(?: de)? |\d+ )/, '');
    const areaCandidates = [normalizedLabel, `${areaLabelBuffer} ${normalizedLabel}`.trim()];
    const areaIndex = settings.areas.findIndex(area => {
      const aliases = [area.name, ...(areaAliases[area.group] || [])];
      return aliases.some(alias => areaCandidates.some(candidate => candidate === normalize(alias) || candidate === `${normalize(alias)} ${area.group}` || candidate.startsWith(`${normalize(alias)} competencia `)));
    });
    if (areaIndex >= 0) {
      currentArea = areaIndex;
      wrappedLabel = '';
      areaLabelBuffer = '';
      if (!gradeMatch) continue;
    } else if (!gradeMatch) {
      const partial = areaCandidates.find(candidate => candidate && settings.areas.some(area => [area.name, ...(areaAliases[area.group] || [])].some(alias => normalize(alias).startsWith(`${candidate} `))));
      areaLabelBuffer = partial || '';
      if (partial) { currentArea = -1; wrappedLabel = ''; continue; }
      // A recognized heading outside the configured catalog ends the previous area.
      if (Object.values(areaAliases).flat().some(alias => normalize(alias) === normalizedLabel) || /^(?:ingles(?: como lengua extranjera)?|educacion fisica|arte y cultura|educacion religiosa|educacion para el trabajo|castellano como segunda lengua|tutoria(?: y orientacion educativa)?)$/.test(normalizedLabel) || /^areas? curriculares?\b/.test(normalize(label))) {
        currentArea = -1; wrappedLabel = ''; continue;
      }
    }
    if (currentArea < 0) continue;
    const definition = settings.areas[currentArea];
    if (!gradeMatch) {
      // pdftotext can wrap a long competency over two or three lines.
      if (!/^\s*(?:(?:I|II|III|IV)\b|BIMESTRE|CALIFICACI|NIVEL|COMPETENCIAS?\b)/i.test(line)) {
        wrappedLabel = `${wrappedLabel} ${line}`.trim().slice(-700);
      }
      continue;
    }
    const sourceCells = gradeMatch[1].split(/[\s|;,]+/).map(cell => cell.toUpperCase());
    if (sourceCells.length !== 3 && sourceCells.length !== 4) { ambiguous++; wrappedLabel = ''; continue; }
    const candidates = [label, `${wrappedLabel} ${label}`.trim()];
    const competencyIndex = definition.competencies.findIndex(competency => candidates.some(candidate => matchesLabel(candidate, competency)));
    wrappedLabel = '';
    if (competencyIndex < 0) {
      ambiguous++;
      continue;
    }
    const key = `${currentArea}:${competencyIndex}`;
    let cells = sourceCells.slice(0, ACTIVE_BIMESTERS.length).map(cell => ['AD', 'A', 'B', 'C'].includes(cell) ? cell as Grade : '');
    if (gradeColumns.length === 4 && sourceCells.length === 3) {
      // An empty native column has no token. Map it by the printed header positions;
      // treating the three remaining tokens as I–III would shift the student's grades.
      const cellsOffset = (gradeMatch.index || 0) + gradeMatch[0].indexOf(gradeMatch[1]);
      const tokens = [...gradeMatch[1].matchAll(/AD|S\/D|A|B|C|[-–—?]/gi)].map(match => ({ value: match[0].toUpperCase(), column: cellsOffset + match.index }));
      const positions = tokens.map(token => {
        const distances = gradeColumns.map(heading => Math.abs(heading.column - token.column));
        const closest = distances.indexOf(Math.min(...distances));
        const gap = closest ? gradeColumns[closest].column - gradeColumns[closest - 1].column : gradeColumns[1].column - gradeColumns[0].column;
        return distances[closest] <= Math.max(1, gap / 3) ? closest : -1;
      });
      if (positions.some(position => position < 0) || new Set(positions).size !== positions.length) { ambiguous++; continue; }
      cells = emptyGrades();
      tokens.forEach((token, index) => { if (positions[index] < ACTIVE_BIMESTERS.length) cells[positions[index]] = ['AD', 'A', 'B', 'C'].includes(token.value) ? token.value as Grade : ''; });
    }
    if (seen.has(key)) {
      if (areas[currentArea].grades[competencyIndex].every((cell, index) => cell === cells[index])) continue;
      // Repeated differing versions cannot safely overwrite the first reading.
      areas[currentArea].grades[competencyIndex] = emptyGrades();
      warnings.push(`Competencia repetida en ${definition.name}: ${definition.competencies[competencyIndex]}. Revise la versión aplicable.`);
      continue;
    }
    seen.add(key);
    areas[currentArea].grades[competencyIndex] = cells;
  }
  warnings.push(...reportWarnings({ ...identity, areas }, settings));
  if (ambiguous) warnings.push(`${ambiguous} fila(s) con notas no pudieron vincularse con seguridad a una competencia del catálogo.`);
  return { ...identity, text, ocr: false, warnings, areas };
}

