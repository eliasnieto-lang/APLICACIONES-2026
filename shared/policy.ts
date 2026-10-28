import type { Student } from './types';

export const ACTIVE_BIMESTERS = ['I', 'II', 'III'] as const;
export const ALLOWED_COHORTS = [
  { grade: '2.º de secundaria', section: 'F', label: '2.º F' },
  { grade: '3.º de secundaria', section: 'F', label: '3.º F' },
  { grade: '4.º de secundaria', section: 'F', label: '4.º F' },
] as const;
export type AllowedCohort = typeof ALLOWED_COHORTS[number];

/** Whole grade expressions only: a 2 inside 12 or 25 is never a match. */
export function normalizeCohort(grade: string, section: string): AllowedCohort | null {
  if (typeof grade !== 'string' || typeof section !== 'string' || section.trim().toUpperCase() !== 'F') return null;
  const value = grade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const suffix = '(?:\\s+grado)?(?:\\s+(?:de\\s+)?(?:educacion\\s+)?secundaria)?';
  const forms = [
    new RegExp(`^(?:2(?:\\s*\\.?(?:º|°|o|do))?|segundo)${suffix}$`),
    new RegExp(`^(?:3(?:\\s*\\.?(?:º|°|o|ro|ero|er))?|tercero|tercer)${suffix}$`),
    new RegExp(`^(?:4(?:\\s*\\.?(?:º|°|o|to))?|cuarto)${suffix}$`),
  ];
  return ALLOWED_COHORTS.find((_, index) => forms[index].test(value)) ?? null;
}

export const cohortKey = (grade: string, section: string): string => normalizeCohort(grade, section)?.label ?? '';

/** PDF existence/status is additionally checked by persistence/API boundaries. */
export function isReportApproved(student: Pick<Student, 'reportApproval' | 'pdfIds'>): boolean {
  const approval = student.reportApproval;
  return Boolean(approval && typeof approval.pdfId === 'string' && approval.pdfId.trim() && typeof approval.approvedAt === 'string' && approval.approvedAt.trim() && Number.isFinite(Date.parse(approval.approvedAt)) && student.pdfIds?.includes(approval.pdfId));
}
