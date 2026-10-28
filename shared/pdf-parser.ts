import type { AcademicArea, Grade, Settings } from './types.js';

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
  const warnings: string[] = ['Lectura provisional: confirme identidad, áreas, competencias y orden I–IV comparando con el PDF original.'];
  const find = (patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/\s+/g, ' ');
    }
    return '';
  };
  const extractedCode = find([
    /(?:c[oó]digo\s*(?:de(?:l)?\s*)?(?:estudiante|alumno)?|c[oó]d\.?\s*est\.?|c[oó]digo\s*modular\s*del\s*estudiante)\s*[:#=]\s*([A-Z0-9][A-Z0-9_-]{1,29})/i,
    /\bDNI\s*[:#=]\s*(\d{8})/i,
  ]);
  const extractedName = find([
    /^\s*(?:apellidos\s*y\s*nombres|nombres\s*y\s*apellidos|estudiante|alumno(?:\(a\))?)\s*[:=]\s*([^\n\r]+)/im,
  ]).split(/\s{2,}|\s+(?:c[oó]digo|grado|secci[oó]n|DNI)\s*[:=]/i)[0].trim();
  const extractedGrade = find([/\bgrado\s*[:=]\s*([1-6](?:\s*[°ºo]|\s*(?:primero|segundo|tercero|cuarto|quinto|sexto))?)/i]);
  const extractedSection = find([/\bsecci[oó]n\s*[:=]\s*["']?([A-Z0-9]{1,3})/i]);
  const period = find([/(?:a[ñn]o\s*(?:escolar|lectivo|acad[eé]mico)?|periodo|per[ií]odo)\s*[:=]\s*(20\d{2})/i]);
  const areas: AcademicArea[] = settings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(() => ['', '', '', '']), validated: false }));
  let currentArea = -1;
  let wrappedLabel = '';
  let recognized = 0;
  let ambiguous = 0;
  const seen = new Set<string>();
  // The suffix must contain exactly four explicit cells. Missing placeholders preserve their position.
  const suffix = /(?:^|[\s|;,])((?:AD|A|B|C|[-–—?]|S\/D)(?:[\s|;,]+(?:AD|A|B|C|[-–—?]|S\/D)){3})\s*$/i;
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
    const candidates = [label, `${wrappedLabel} ${label}`.trim()];
    const competencyIndex = definition.competencies.findIndex(competency => candidates.some(candidate => matchesLabel(candidate, competency)));
    wrappedLabel = '';
    if (competencyIndex < 0) {
      ambiguous++;
      continue;
    }
    const key = `${currentArea}:${competencyIndex}`;
    if (seen.has(key)) {
      // Repeated differing versions cannot safely overwrite the first reading.
      areas[currentArea].grades[competencyIndex] = ['', '', '', ''];
      warnings.push(`Competencia repetida en ${definition.name}: ${definition.competencies[competencyIndex]}. Revise la versión aplicable.`);
      continue;
    }
    seen.add(key);
    const cells = gradeMatch[1].split(/[\s|;,]+/).map(cell => cell.toUpperCase());
    areas[currentArea].grades[competencyIndex] = cells.map(cell => ['AD', 'A', 'B', 'C'].includes(cell) ? cell as Grade : '');
    recognized += cells.filter(cell => ['AD', 'A', 'B', 'C'].includes(cell)).length;
  }
  if (!extractedCode) warnings.push('Código de estudiante no reconocido: complete la identidad antes de vincular.');
  if (!extractedName) warnings.push('Nombre de estudiante no reconocido.');
  if (!period) warnings.push('Año de la libreta no reconocido; confirme que corresponde al periodo de evaluación.');
  else if (Number(period) !== settings.year - 1) warnings.push(`La libreta indica ${period}; se esperaba ${settings.year - 1}. Revise el periodo.`);
  const expected = settings.areas.reduce((sum, area) => sum + area.competencies.length * 4, 0);
  if (recognized < expected) warnings.push(`Se reconocieron ${recognized} de ${expected} casillas del catálogo. Las restantes requieren transcripción o revisión manual.`);
  if (ambiguous) warnings.push(`${ambiguous} fila(s) con notas no pudieron vincularse con seguridad a una competencia del catálogo.`);
  return { extractedCode, extractedName, extractedGrade, extractedSection, period, text, ocr: false, warnings, areas };
}

