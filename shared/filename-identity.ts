import { normalizeCohort } from './policy.js';
import type { PdfRecord } from './types.js';

export interface ReportIdentity { name: string; grade: string; section: string }

const ordinal = '(?:[0-9]{1,2}(?:\\s*\\.?\\s*(?:ero|do|ro|to|er|º|°|o))?|primero|primer|segundo|tercero|tercer|cuarto|quinto|sexto)';
const gradeUnit = `(?:(grado)\\s*[:.-]?\\s*)?(${ordinal})(?:\\s+(grado|año))?(?:\\s+(?:de\\s+)?(?:educaci[oó]n\\s+)?(secundaria|primaria|inicial))?(?:\\s*(?:[,;:-]\\s*)?(?:(secci[oó]n)\\s*[:.-]?\\s*)?["'«“]?([A-Z])["'»”]?)?`;
const boundary = '[\\s,;:–—-]';
const reportLabel = '(?:boletas?|libretas?|informes?|reportes?|reports?)(?:\\s+de\\s+(?:notas|calificaciones|progreso(?:\\s+del\\s+estudiante)?|aprendizaje|rendimiento))?';
const reportStart = new RegExp(`^${reportLabel}(?=$|${boundary})`, 'iu');
const reportEnd = new RegExp(`(?:^|${boundary})${reportLabel}$`, 'iu');
const levelStart = /^(?:(?:nivel|educaci[oó]n)\s+)?(secundaria|primaria|inicial)(?=$|[\s,;:–—-])/iu;
const levelEnd = /(?:^|[\s,;:–—-])(?:(?:nivel|educaci[oó]n)\s+)?(secundaria|primaria|inicial)$/iu;
const explicitYear = '(?:año(?:\\s+(?:escolar|lectivo))?|periodo|período|gesti[oó]n)\\s*[:.-]?\\s*(?:19|20)[0-9]{2}';
const yearStart = new RegExp(`^${explicitYear}(?=$|${boundary})`, 'iu');
const yearEnd = new RegExp(`(?:^|${boundary})${explicitYear}$`, 'iu');
const gradeStart = new RegExp(`^${gradeUnit}(?=$|${boundary})`, 'iu');
const gradeEnd = new RegExp(`(?:^|${boundary})${gradeUnit}$`, 'iu');
const cleanEdge = (value: string): string => value.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/gu, '').trim();

/** The filename supplies the written name in its original order and capitalization. */
export function parseReportFilename(filename: string): ReportIdentity {
  let remaining = cleanEdge(String(filename).split(/[\\/]/u).pop()!.replace(/\.[^.]*$/u, '').normalize('NFC').replace(/_+/gu, ' ').replace(/\s+/gu, ' '));
  let grade = '', section = '', level = '', report = false, conflicting = false;

  const setGrade = (value: string): void => {
    if (grade && grade.toLocaleLowerCase() !== value.toLocaleLowerCase()) { grade = `${grade} / ${value}`; conflicting = true; }
    else grade = value;
  };
  const setSection = (value: string): void => {
    const upper = value.toUpperCase();
    if (section && section !== upper) { section = `${section} / ${upper}`; conflicting = true; }
    else section = upper;
  };
  const setLevel = (value: string): void => {
    const lower = value.toLocaleLowerCase();
    if (level && level !== lower) { level = `${level} / ${lower}`; conflicting = true; }
    else level = lower;
  };

  // Metadata is removed only at the filename's edges, leaving surnames intact.
  for (let pass = 0; pass < 20 && remaining; pass++) {
    let changed = false;
    for (const side of ['start', 'end'] as const) {
      const strip = (match: RegExpMatchArray): void => {
        remaining = cleanEdge(side === 'start' ? remaining.slice(match[0].length) : remaining.slice(0, match.index));
        changed = true;
      };
      const label = remaining.match(side === 'start' ? reportStart : reportEnd);
      if (label) { report = true; strip(label); continue; }
      const year = remaining.match(side === 'start' ? yearStart : yearEnd);
      if (year) { strip(year); continue; }
      const schoolLevel = remaining.match(side === 'start' ? levelStart : levelEnd);
      if (schoolLevel) { setLevel(schoolLevel[1]); strip(schoolLevel); continue; }
      const classroom = remaining.match(side === 'start' ? gradeStart : gradeEnd);
      // A surname such as SEGUNDO is not a grade without classroom context.
      if (classroom && (classroom[1] || classroom[3] || classroom[4] || classroom[5] || classroom[6] || (/^[0-9]/u.test(classroom[2]) && /[a-zº°]/iu.test(classroom[2])))) {
        setGrade(classroom[2].replace(/\s+/gu, ' ').trim());
        if (classroom[4]) setLevel(classroom[4]);
        if (classroom[6]) setSection(classroom[6]);
        strip(classroom);
        continue;
      }
      const explicitSection = remaining.match(side === 'start'
        ? /^secci[oó]n\s*[:.-]?\s*["'«“]?([A-Z])["'»”]?(?=$|[\s,;:–—-])/iu
        : /(?:^|[\s,;:–—-])secci[oó]n\s*[:.-]?\s*["'«“]?([A-Z])["'»”]?$/iu);
      if (explicitSection) { setSection(explicitSection[1]); strip(explicitSection); continue; }
      // A section separated from its grade by a level label is still explicit.
      const bareSection = grade && remaining.match(side === 'start' ? /^["'«“]?([A-Z])["'»”]?(?=$|[\s,;:–—-])/iu : /(?:^|[\s,;:–—-])["'«“]?([A-Z])["'»”]?$/iu);
      if (bareSection) { setSection(bareSection[1]); strip(bareSection); continue; }
      // Bare years are reporting metadata only when a report label established context.
      const reportYear = report && remaining.match(side === 'start' ? /^(?:19|20)[0-9]{2}(?=$|[\s,;:–—-])/u : /(?:^|[\s,;:–—-])(?:19|20)[0-9]{2}$/u);
      if (reportYear) { strip(reportYear); continue; }
    }
    if (!changed) break;
  }

  const rawGrade = grade ? `${grade}${level ? ` de ${level}` : ''}` : '';
  const cohort = !conflicting && normalizeCohort(rawGrade, section);
  const candidate = remaining.replace(/\s+/gu, ' ').trim();
  const humanName = /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*(?:\s+[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*)+$/u.test(candidate)
    && !/^(?:original(?:[\s-]+(?:review|failed|pending|duplicate))?|review|fuera[\s-]+de[\s-]+aula)$/iu.test(candidate)
    && !/\b(?:documento|sin[-\s]+identidad|boleta|libreta|informe|reporte|report|foto|imagen|archivo|escaneo|scan|document|untitled|sin[-\s]+nombre|notas|calificaciones|secundaria|primaria|inicial)\b/iu.test(candidate);
  return { name: humanName ? candidate : '', grade: cohort ? cohort.grade : rawGrade, section };
}

type FilenameFields = Pick<PdfRecord, 'name' | 'extractedName' | 'extractedGrade' | 'extractedSection'>;
type IdentitySource = FilenameFields & Pick<PdfRecord, 'confirmedIdentity'> & { manualName?: string };

/** Confirmed/manual corrections survive later reads; the filename precedes PDF text. */
export function resolveReportIdentity(pdf: IdentitySource): ReportIdentity {
  const filename = parseReportFilename(pdf.name);
  return {
    name: pdf.manualName !== undefined ? pdf.manualName.trim().replace(/\s+/gu, ' ') : pdf.confirmedIdentity?.name ?? (filename.name || pdf.extractedName),
    grade: pdf.confirmedIdentity?.grade ?? (filename.grade || pdf.extractedGrade),
    section: pdf.confirmedIdentity?.section ?? (filename.section || pdf.extractedSection),
  };
}

/** Keep extracted source fields useful for callers that display them directly. */
export function applyFilenameIdentity<T extends FilenameFields>(pdf: T): T {
  const identity = parseReportFilename(pdf.name);
  if (identity.name) pdf.extractedName = identity.name;
  if (identity.grade) pdf.extractedGrade = identity.grade;
  if (identity.section) pdf.extractedSection = identity.section;
  return pdf;
}
