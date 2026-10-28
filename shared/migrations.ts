import type { AppState, PdfRecord, Student } from './types';
import { isReportApproved, normalizeCohort } from './policy';

const identityKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
const validTimestamp = (value: string | undefined): value is string => Boolean(value?.trim() && Number.isFinite(Date.parse(value)));

/** A legacy confirmation can be trusted only while its document and identity still agree. */
function matchesApprovedReport(student: Student, pdf: PdfRecord, pdfs: PdfRecord[]): boolean {
  if (pdf.status !== 'validated' || pdf.studentId !== student.id || !student.pdfIds.includes(pdf.id)) return false;
  if (pdfs.some(other => other.replacesId === pdf.id && other.studentId === student.id && other.status === 'validated')) return false;
  const identity = pdf.confirmedIdentity ?? { code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade, section: pdf.extractedSection };
  const studentCohort = normalizeCohort(student.grade, student.section);
  const reportCohort = normalizeCohort(identity.grade, identity.section);
  return Boolean(studentCohort && reportCohort && studentCohort.label === reportCohort.label && identityKey(identity.code) && identityKey(identity.name) && identityKey(identity.code) === identityKey(student.code) && identityKey(identity.name) === identityKey(student.name));
}

/** Normalize the three-period workflow without deleting historical grades or manual B/C data. */
export function migrateState(state: AppState): AppState {
  const result = structuredClone(state);
  const upgrading = result.settings.workflowVersion !== 2 || result.settings.progressionComparison !== 'first_two_vs_third';
  result.settings.workflowVersion = 2;
  result.settings.progressionComparison = 'first_two_vs_third';
  // The changed academic comparison must be reviewed and closed again under I–III.
  if (upgrading) { result.settings.criteriaApproved = false; result.settings.closed = false; }

  for (const record of result.settings.cohortRecords ?? []) {
    const cohort = normalizeCohort(record.grade, record.section || 'F');
    if (cohort) {
      record.grade = cohort.grade;
      if (record.section.trim()) record.section = cohort.section;
    }
  }
  for (const pdf of result.pdfs) {
    if (pdf.confirmedIdentity) {
      const confirmedCohort = normalizeCohort(pdf.confirmedIdentity.grade, pdf.confirmedIdentity.section);
      if (confirmedCohort) { pdf.confirmedIdentity.grade = confirmedCohort.grade; pdf.confirmedIdentity.section = confirmedCohort.section; }
    }
    if (pdf.studentId && !result.students.some(student => student.id === pdf.studentId)) pdf.studentId = null;
  }
  for (const student of result.students) {
    const cohort = normalizeCohort(student.grade, student.section);
    if (cohort) { student.grade = cohort.grade; student.section = cohort.section; }
    student.pdfIds = [...new Set([...student.pdfIds, ...result.pdfs.filter(pdf => pdf.studentId === student.id).map(pdf => pdf.id)])].filter(id => result.pdfs.some(pdf => pdf.id === id && pdf.studentId === student.id));
    if (upgrading) student.validated.academic = false;

    const existing = student.reportApproval && result.pdfs.find(pdf => pdf.id === student.reportApproval!.pdfId);
    if (!isReportApproved(student) || !existing || !matchesApprovedReport(student, existing, result.pdfs)) delete student.reportApproval;
    if (upgrading && !student.reportApproval) {
      const candidates = result.pdfs.filter(pdf => matchesApprovedReport(student, pdf, result.pdfs)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.id.localeCompare(b.id));
      const pdf = candidates[0];
      if (!pdf) continue;
      const confirmation = student.history.filter(entry => entry.field === 'Lectura PDF confirmada' && entry.before === pdf.name).map(entry => entry.date).filter(validTimestamp).sort().at(-1);
      const approvedAt = confirmation ?? (validTimestamp(student.updatedAt) ? student.updatedAt : validTimestamp(pdf.uploadedAt) ? pdf.uploadedAt : undefined);
      if (approvedAt) student.reportApproval = { pdfId: pdf.id, approvedAt };
    }
  }
  return result;
}
