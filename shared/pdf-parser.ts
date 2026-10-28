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

function matchesLabel(line: string, label: string): boolean {
  const a = normalize(line);
  const b = normalize(label);
  if (!b) return false;
  return a === b || a.startsWith(`${b} `) || (b.length > 22 && a.includes(b));
}

/** Parse only identifiable rows; uncertain cells remain empty until a person reviews the source. */
export function parseReportText(text: string, settings: Settings): ExtractedReport {
  const lines = text.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const warnings: string[] = ['Lectura provisional: confirme identidad, áreas, competencias y orden I–III comparando con el PDF original.'];
  const find = (patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/\s+/g, ' ');
    }
    return '';
  };
  // A school's código modular and a DNI are not the student's own code.
  // Require the student label so a nearby institutional identifier cannot become an identity.
  const extractedCode = find([
    /\bc[oó]digo[ \t]*(?:de(?:l)?[ \t]*)?(?:estudiante|alumno(?:\(a\))?)[ \t]*[:#=][ \t]*([A-Z0-9][A-Z0-9_-]{1,29})(?![A-Z0-9_-]|[ \t]*[:=])/i,
    /\bc[oó]d\.?[ \t]*(?:est(?:udiante)?|alum(?:no)?)\.?[ \t]*[:#=][ \t]*([A-Z0-9][A-Z0-9_-]{1,29})(?![A-Z0-9_-]|[ \t]*[:=])/i,
  ]);
  const cleanName = (value: string): string => value
    .split(/(?:^|\s+)(?:(?:c[oó]digo|c[oó]d\.?|grado|secci[oó]n|DNI|sexo|nivel|a[ñn]o|fecha(?:\s+de\s+nacimiento)?|apellidos?|nombres)\b[^:=\n]{0,30}[:=])/i)[0]
    .trim().replace(/\s+/g, ' ');
  const combinedName = find([
    /^[ \t]*(?:(?:apellidos[ \t]*(?:y|,)[ \t]*nombres|nombres[ \t]*(?:y|,)[ \t]*apellidos)(?:[ \t]+del?[ \t]+estudiante)?|estudiante|alumno(?:\(a\))?)[ \t]*[:=][ \t]*([^\n\r]+)/im,
  ]);
  const surnames = cleanName(find([/^[ \t]*apellidos[ \t]*[:=][ \t]*([^\n\r]+)/im]));
  const paternalSurname = cleanName(find([/^[ \t]*apellido[ \t]+paterno[ \t]*[:=][ \t]*([^\n\r]+)/im]));
  const maternalSurname = cleanName(find([/(?:^|[ \t]{2,})apellido[ \t]+materno[ \t]*[:=][ \t]*([^\n\r]+)/im]));
  const givenNames = cleanName(find([/(?:^|[ \t]{2,})nombres[ \t]*[:=][ \t]*([^\n\r]+)/im]));
  const extractedSurnames = surnames || [paternalSurname, maternalSurname].filter(Boolean).join(' ');
  const extractedName = cleanName(combinedName) || (extractedSurnames && givenNames ? `${extractedSurnames} ${givenNames}` : '');
  // Accept labelled fields and a combined “Grado y sección: 3.º F”.
  const gradeValue = /(?:[1-6](?:\s*\.?(?:[°ºo]|do|ro|to))?|primero|segundo|tercero|cuarto|quinto|sexto)(?:\s+(?:grado\s+)?(?:de\s+)?(?:educaci[oó]n\s+)?(?:secundaria|primaria))?/.source;
  const combinedCohort = text.match(new RegExp(`\\bgrado\\s*(?:y|/|-)\\s*secci[oó]n\\s*[:=]\\s*(${gradeValue})[\\s,;|/\\-]*["']?([A-Z])(?:["']|\\b)`, 'i'));
  const separateGrade = text.match(/\bgrado[ \t]*[:=][ \t]*([^\n\r]+)/i)?.[1]
    ?.split(/[ \t]{2,}|[ \t]+(?:[-–—|][ \t]*)?(?:secci[oó]n|nivel|a[ñn]o|DNI|c[oó]digo)\b[ \t]*[:=]/i)[0]
    ?.trim().replace(/\s+/g, ' ') || '';
  const extractedGrade = separateGrade || combinedCohort?.[1]?.trim().replace(/\s+/g, ' ') || '';
  const extractedSection = find([/\bsecci[oó]n\s*[:=]\s*["']?([A-Z])(?:["']|\b)/i]) || combinedCohort?.[2]?.toUpperCase() || '';
  const period = find([/(?:a[ñn]o\s*(?:escolar|lectivo|acad[eé]mico)?|periodo|per[ií]odo)\s*[:=]\s*(20\d{2})/i]);
  const emptyGrades = (): Grade[] => ACTIVE_BIMESTERS.map(() => '');
  const areas: AcademicArea[] = settings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(emptyGrades), validated: false }));
  let currentArea = -1;
  let wrappedLabel = '';
  let ambiguous = 0;
  const seen = new Set<string>();
  // Native reports have three or four bimesters. Keep only I–III; explicit blanks preserve positions.
  const suffix = /(?:^|[\s|;,])((?:AD|A|B|C|[-–—?]|S\/D)(?:[\s|;,]+(?:AD|A|B|C|[-–—?]|S\/D)){2,})\s*$/i;
  for (const line of lines) {
    const gradeMatch = line.match(suffix);
    const label = gradeMatch ? line.slice(0, gradeMatch.index).trim() : line;
    const normalizedLabel = normalize(label);
    const areaIndex = settings.areas.findIndex(area => {
      const aliases = [area.name, ...(areaAliases[area.group] || [])];
      return aliases.some(alias => normalizedLabel === normalize(alias) || normalizedLabel === `area ${normalize(alias)}` || normalizedLabel.startsWith(`${normalize(alias)} competencia `));
    });
    if (areaIndex >= 0) {
      currentArea = areaIndex;
      wrappedLabel = '';
      if (!gradeMatch) continue;
    }
    if (currentArea < 0) continue;
    const definition = settings.areas[currentArea];
    if (!gradeMatch) {
      // pdftotext can wrap a long competency over two or three lines.
      if (!/^(I|II|III|IV|BIMESTRE|CALIFICACI|NIVEL|COMPETENCIAS?\b)/i.test(line)) {
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
    const cells = sourceCells.slice(0, ACTIVE_BIMESTERS.length).map(cell => ['AD', 'A', 'B', 'C'].includes(cell) ? cell as Grade : '');
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
  if (!extractedCode) warnings.push('Código de estudiante no reconocido: complete la identidad antes de vincular.');
  if (!extractedName) warnings.push('Apellidos y nombres completos no reconocidos: complételos comparando con el PDF original.');
  if (!extractedGrade || !extractedSection) warnings.push('Grado o sección no reconocidos: confirme el aula comparando con el PDF original.');
  else if (!normalizeCohort(extractedGrade, extractedSection)) warnings.push('El aula reconocida no corresponde a 2.º F, 3.º F o 4.º F. Revise el PDF original antes de confirmar.');
  if (!period) warnings.push('Año de la libreta no reconocido; confirme que corresponde al periodo de evaluación.');
  else if (Number(period) !== settings.year - 1) warnings.push(`La libreta indica ${period}; se esperaba ${settings.year - 1}. Revise el periodo.`);
  const expected = settings.areas.reduce((sum, area) => sum + area.competencies.length * ACTIVE_BIMESTERS.length, 0);
  const recognized = areas.reduce((sum, area) => sum + area.grades.reduce((total, row) => total + row.filter(Boolean).length, 0), 0);
  if (recognized < expected) warnings.push(`Se reconocieron ${recognized} de ${expected} casillas del catálogo. Las restantes requieren transcripción o revisión manual.`);
  if (ambiguous) warnings.push(`${ambiguous} fila(s) con notas no pudieron vincularse con seguridad a una competencia del catálogo.`);
  return { extractedCode, extractedName, extractedGrade, extractedSection, period, text, ocr: false, warnings, areas };
}

