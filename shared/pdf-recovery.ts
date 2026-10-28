import { REPORT_REVIEW_WARNING, reportWarnings, type ExtractedReport } from './pdf-parser.js';
import { normalizeCohort } from './policy.js';
import type { Settings } from './types.js';

const metadataFields = ['extractedCode', 'extractedName', 'extractedGrade', 'extractedSection', 'period'] as const;

/** Image recognition is useful only while a labelled field or a catalog cell is missing. */
export function needsPdfRecovery(report: ExtractedReport): boolean {
  return metadataFields.some(field => !report[field].trim())
    || report.areas.some(area => area.grades.some(row => row.some(cell => !cell)));
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
  };
  const recoveryWarnings: string[] = [];
  if (conflicts.length) {
    recoveryWarnings.push('La lectura OCR difiere de la identidad o el periodo del texto nativo. Se conservó la lectura nativa sin combinar datos incompatibles; vuelva a procesar una copia más legible del PDF.');
  } else {
    for (const field of metadataFields) if (!result[field]) result[field] = recognized[field];
    for (const area of result.areas) {
      const source = recognized.areas.find(candidate => candidate.areaId === area.areaId);
      if (!source) continue;
      for (const [index, row] of area.grades.entries()) {
        const sourceRow = source.grades[index];
        if (!sourceRow) continue;
        if (row.some((cell, column) => cell && sourceRow[column] && cell !== sourceRow[column])) {
          recoveryWarnings.push('Una fila OCR difiere de sus notas nativas. Se conservaron las casillas nativas sin combinar esa fila.');
          continue;
        }
        row.forEach((cell, column) => { if (!cell) row[column] = sourceRow[column] || ''; });
      }
    }
  }
  // Recreate summary warnings from the final fields, retaining source-specific ambiguity.
  const summaryWarnings = new Set([REPORT_REVIEW_WARNING, ...reportWarnings(native, settings), ...reportWarnings(recognized, settings)]);
  const sourceWarnings = [...native.warnings, ...recognized.warnings].filter(warning => !summaryWarnings.has(warning));
  result.warnings = [...new Set([REPORT_REVIEW_WARNING, ...reportWarnings(result, settings), ...sourceWarnings, ...recoveryWarnings])];
  return result;
}
