import { REPORT_REVIEW_WARNING, reportWarnings, type ExtractedReport } from './pdf-parser.js';
import { ACTIVE_BIMESTERS, normalizeCohort } from './policy.js';
import { hasActiveGrades } from './academic-policy.js';
import type { Grade, Settings } from './types.js';

const metadataFields = ['extractedCode', 'extractedName', 'extractedGrade', 'extractedSection', 'period'] as const;
const gradeTables = (report: ExtractedReport) => [...report.areas, ...(report.supplementalAreas || [])];
const labelKey = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Empty courses are not taken; an entirely unread report still needs recovery. */
function needsGradeRecovery(report: ExtractedReport): boolean {
  const tables = gradeTables(report);
  const active = tables.filter(hasActiveGrades);
  return (active.length ? active : tables).some(area => area.grades.some(row =>
    ACTIVE_BIMESTERS.some((_, index) => !['AD', 'A', 'B', 'C'].includes(row[index] || ''))));
}

export interface PositionedPdfText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep physical columns and cell boundaries when PDF.js returns small drawing fragments. */
export function layoutPdfText(items: PositionedPdfText[]): string {
  const words = items.filter(item => item.text.trim()).map(item => ({ ...item, height: Math.max(4, item.height) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { y: number; height: number; words: PositionedPdfText[] }[] = [];
  for (const word of words) {
    const previous = rows.at(-1);
    if (previous && Math.abs(previous.y - word.y) <= Math.max(1, Math.min(previous.height, word.height) * .3)) previous.words.push(word);
    else rows.push({ y: word.y, height: word.height, words: [word] });
  }
  const left = words.reduce((value, word) => Math.min(value, word.x), Infinity);
  const widths = words.map(word => word.width / Math.max(1, word.text.length)).filter(width => width > .5 && width < 20).sort((a, b) => a - b);
  // A lower quartile leaves room for proportional-font labels while keeping the
  // same x coordinate at the same character column on every row.
  const characterWidth = widths[Math.floor(widths.length / 4)] || 3;
  return rows.map(row => {
    row.words.sort((a, b) => a.x - b.x);
    let line = '';
    let previous: PositionedPdfText | undefined;
    for (const word of row.words) {
      const target = Math.max(0, Math.round((word.x - left) / characterWidth));
      const gap = previous ? word.x - previous.x - previous.width : 0;
      const separateGrades = previous && /^(?:AD|A|B|C)$/i.test(previous.text.trim()) && /^(?:AD|A|B|C)$/i.test(word.text.trim());
      const completeAd = previous?.text === 'A' && word.text === 'D' && Math.abs(gap) <= Math.max(.5, word.height * .12);
      const separator = previous && (separateGrades || gap > Math.max(.35, word.height * .08)) ? 1 : 0;
      if (!completeAd) line += ' '.repeat(Math.min(2000, Math.max(separator, target - line.length)));
      line += word.text;
      previous = word;
    }
    return line.trimEnd();
  }).join('\n');
}

/** Image recognition is useful only while a labelled field or a catalog cell is missing. */
export function needsPdfRecovery(report: ExtractedReport, requireMetadata = true): boolean {
  return requireMetadata && metadataFields.some(field => !report[field].trim())
    || needsGradeRecovery(report);
}

/** Vector outlines and unusable font mappings can hide grades without any raster image. */
export function needsRenderedGradeRecovery(report: ExtractedReport, settings: Settings, forceGrades = false): boolean {
  if (!needsGradeRecovery(report)) return false;
  if (forceGrades) return true;
  const text = report.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  const hasTable = /\b(?:bimestres?|calificaciones?)\b/.test(text) && /\bcompetencias?\b/.test(text);
  const definitions = [...settings.areas, ...(report.supplementalAreas || []).map(area => area.definition)];
  return hasTable && definitions.some(area => area.competencies.some(competency => {
    const label = competency.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    return label.length > 12 && text.includes(label);
  }));
}

function comparable(field: typeof metadataFields[number], value: string): string {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (field !== 'extractedGrade') return normalized;
  return normalizeCohort(value, 'F')?.grade || normalized;
}

/** Keep independent readings independent: repeated OCR rows cannot erase native evidence. */
export function mergePdfReadings(native: ExtractedReport, recognized: ExtractedReport, settings: Settings): ExtractedReport {
  const conflicts = metadataFields.filter(field => native[field] && recognized[field] && comparable(field, native[field]) !== comparable(field, recognized[field]));
  const result: ExtractedReport = {
    ...native,
    text: [native.text, recognized.text].filter(text => text.trim()).join('\n\f\n'),
    ocr: true,
    warnings: [],
    areas: native.areas.map(area => ({ ...area, validated: false, grades: area.grades.map(row => [...row]) })),
    ...(native.supplementalAreas ? { supplementalAreas: structuredClone(native.supplementalAreas) } : {}),
  };
  const recoveryWarnings: string[] = [];
  const mergeRow = (row: Grade[], sourceRow: Grade[] | undefined) => {
    if (!sourceRow) return;
    if (row.some((cell, column) => cell && sourceRow[column] && cell !== sourceRow[column])) {
      recoveryWarnings.push('Una fila OCR difiere de sus notas nativas. Se conservaron las casillas nativas sin combinar esa fila.');
      return;
    }
    row.forEach((cell, column) => { if (!cell) row[column] = sourceRow[column] || ''; });
  };
  if (conflicts.length) {
    recoveryWarnings.push('La lectura OCR difiere de la identidad o el periodo del texto nativo. Se conservó la lectura nativa sin combinar datos incompatibles; vuelva a procesar una copia más legible del PDF.');
  } else {
    for (const field of metadataFields) if (!result[field]) result[field] = recognized[field];
    for (const area of result.areas) {
      const source = recognized.areas.find(candidate => candidate.areaId === area.areaId);
      if (!source) continue;
      area.grades.forEach((row, index) => mergeRow(row, source.grades[index]));
    }
    for (const source of recognized.supplementalAreas || []) {
      const area = result.supplementalAreas?.find(candidate => candidate.definition.id === source.definition.id);
      if (!area) {
        if (!settings.areas.some(definition => definition.id === source.definition.id)) (result.supplementalAreas ||= []).push(structuredClone(source));
        continue;
      }
      area.definition.competencies.forEach((competency, index) => {
        const sourceIndex = source.definition.competencies.findIndex(label => labelKey(label) === labelKey(competency));
        if (sourceIndex >= 0) mergeRow(area.grades[index], source.grades[sourceIndex]);
      });
    }
  }
  // Recreate summary warnings from the final fields, retaining source-specific ambiguity.
  const summaryWarnings = new Set([REPORT_REVIEW_WARNING, ...reportWarnings(native, settings), ...reportWarnings(recognized, settings)]);
  const sourceWarnings = [...native.warnings, ...recognized.warnings].filter(warning => !summaryWarnings.has(warning));
  result.warnings = [...new Set([REPORT_REVIEW_WARNING, ...reportWarnings(result, settings), ...sourceWarnings, ...recoveryWarnings])];
  return result;
}
