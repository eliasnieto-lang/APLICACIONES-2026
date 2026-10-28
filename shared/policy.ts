import type { Student } from './types';

export const ACTIVE_BIMESTERS = ['I', 'II', 'III'] as const;
export interface AllowedCohort { grade: string; section: string; label: string }
export const ALLOWED_COHORTS: readonly AllowedCohort[] = [1, 2, 3, 4, 5].flatMap(grade =>
  Array.from({ length: 5 }, (_, index) => {
    const section = String.fromCharCode(65 + index);
    return { grade: `${grade}.º de secundaria`, section, label: `${grade}.º ${section}` };
  }));

/** Normalize retained classrooms without invalidating records from earlier editions. */
export function normalizeCohort(grade: string, section: string): AllowedCohort | null {
  if (typeof grade !== 'string' || typeof section !== 'string' || !/^[A-Z]$/.test(section.trim().toUpperCase())) return null;
  const normalizedSection = section.trim().toUpperCase();
  const value = grade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const suffix = '(?:\\s+(?:grado|ano))?(?:\\s+(?:de\\s+)?(?:educacion\\s+)?secundaria)?';
  const forms = [
    new RegExp(`^(?:1(?:\\s*\\.?(?:º|°|o|ro|ero|er))?|primero|primer)${suffix}$`),
    new RegExp(`^(?:2(?:\\s*\\.?(?:º|°|o|do))?|segundo)${suffix}$`),
    new RegExp(`^(?:3(?:\\s*\\.?(?:º|°|o|ro|ero|er))?|tercero|tercer)${suffix}$`),
    new RegExp(`^(?:4(?:\\s*\\.?(?:º|°|o|to))?|cuarto)${suffix}$`),
    new RegExp(`^(?:5(?:\\s*\\.?(?:º|°|o|to))?|quinto)${suffix}$`),
  ];
  const index = forms.findIndex(form => form.test(value));
  return index < 0 ? null : { grade: `${index + 1}.º de secundaria`, section: normalizedSection, label: `${index + 1}.º ${normalizedSection}` };
}

/** Only A–E are offered in current classroom selectors. */
export function isOfferedCohort(grade: string, section: string): boolean {
  const cohort = normalizeCohort(grade, section);
  return Boolean(cohort && ALLOWED_COHORTS.some(item => item.label === cohort.label));
}

export const cohortKey = (grade: string, section: string): string => normalizeCohort(grade, section)?.label ?? '';

/** PDF existence/status is additionally checked by persistence/API boundaries. */
export function isReportApproved(student: Pick<Student, 'reportApproval' | 'pdfIds'>): boolean {
  const approval = student.reportApproval;
  return Boolean(approval && typeof approval.pdfId === 'string' && approval.pdfId.trim() && typeof approval.approvedAt === 'string' && approval.approvedAt.trim() && Number.isFinite(Date.parse(approval.approvedAt)) && student.pdfIds?.includes(approval.pdfId));
}
