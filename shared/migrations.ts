import type { AppState, PdfRecord, Student } from './types';
import { isReportApproved, normalizeCohort } from './policy';
import { applyFilenameIdentity, parseReportFilename, resolveReportIdentity } from './filename-identity';
import { registerImportedReport } from './report-workflow';
import { ACADEMIC_CONTEST_LABEL, isAcademicContest } from './contests';
import { hasActiveGrades } from './academic-policy';
import { DEFAULT_BIMESTER_WEIGHTS, DEFAULT_DIMENSION_WEIGHTS } from './evaluation-policy';

const identityKey = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
const validTimestamp = (value: string | undefined): value is string => Boolean(value?.trim() && Number.isFinite(Date.parse(value)));

/** A legacy confirmation can be trusted only while its document and identity still agree. */
function matchesApprovedReport(student: Student, pdf: PdfRecord, pdfs: PdfRecord[]): boolean {
  if (pdf.status !== 'validated' || pdf.studentId !== student.id || !student.pdfIds.includes(pdf.id)) return false;
  if (pdfs.some(other => other.replacesId === pdf.id && other.studentId === student.id && other.status === 'validated')) return false;
  const identity = { ...resolveReportIdentity(pdf), code: pdf.confirmedIdentity?.code ?? pdf.extractedCode };
  const studentCohort = normalizeCohort(student.grade, student.section);
  const reportCohort = normalizeCohort(identity.grade, identity.section);
  return Boolean(studentCohort && reportCohort && studentCohort.label === reportCohort.label && identityKey(identity.name) && (!identityKey(identity.code) || identityKey(identity.code) === identityKey(student.code)) && identityKey(identity.name) === identityKey(student.name));
}

/** Normalize the three-period workflow without deleting historical grades or manual B/C data. */
export function migrateState(state: AppState): AppState {
  const result = structuredClone(state);
  const upgrading = result.settings.workflowVersion !== 2 || result.settings.progressionComparison !== 'first_two_vs_third';
  result.settings.workflowVersion = 2;
  result.settings.progressionComparison = 'first_two_vs_third';
  result.settings.activityTypes = [ACADEMIC_CONTEST_LABEL];
  if (!result.settings.dimensionWeights) {
    result.settings.dimensionWeights = { ...DEFAULT_DIMENSION_WEIGHTS };
    result.settings.criteriaApproved = false;
  }
  const scoringUpgrade = result.settings.academicScoringPolicy !== 'weighted_bimesters_common_progression';
  if (scoringUpgrade || !result.settings.bimesterWeights) {
    result.settings.bimesterWeights = { ...DEFAULT_BIMESTER_WEIGHTS };
    result.settings.criteriaApproved = false;
  }
  result.settings.academicScoringPolicy = 'weighted_bimesters_common_progression';
  // The changed academic comparison must be reviewed and closed again under I–III.
  if (upgrading) { result.settings.criteriaApproved = false; result.settings.closed = false; }

  for (const record of result.settings.cohortRecords ?? []) {
    const cohort = normalizeCohort(record.grade, record.section || 'F');
    if (cohort) {
      record.grade = cohort.grade;
      if (record.section.trim()) record.section = cohort.section;
    }
  }
  for (const student of result.students) {
    student.commitmentEnabled ??= true;
    student.noContestParticipation ??= false;
    student.circleStatus ??= 'pending';
    const cohort = normalizeCohort(student.grade, student.section);
    if (cohort) { student.grade = cohort.grade; student.section = cohort.section; }
  }
  for (const pdf of result.pdfs) {
    for (const area of pdf.areas) if (!hasActiveGrades(area)) area.validated = false;
    const priorName = pdf.extractedName;
    applyFilenameIdentity(pdf);
    const filename = parseReportFilename(pdf.name);
    const linked = result.students.find(student => student.id === pdf.studentId);
    const linkedCohort = linked && normalizeCohort(linked.grade, linked.section);
    const filenameCohort = normalizeCohort(filename.grade, filename.section);
    // Repair the automatic provisional label without changing a manual correction or its classroom.
    if (linked && ['pending', 'review'].includes(pdf.status) && !pdf.confirmedIdentity && pdf.manualName === undefined && filename.name && identityKey(linked.name) === identityKey(priorName) && linkedCohort?.label === filenameCohort?.label) linked.name = filename.name;
    if (pdf.confirmedIdentity) {
      const confirmedCohort = normalizeCohort(pdf.confirmedIdentity.grade, pdf.confirmedIdentity.section);
      if (confirmedCohort) { pdf.confirmedIdentity.grade = confirmedCohort.grade; pdf.confirmedIdentity.section = confirmedCohort.section; }
    }
    if (pdf.studentId && !result.students.some(student => student.id === pdf.studentId)) pdf.studentId = null;
  }
  // A retained filename is enough to restore a missing provisional record; OCR is unnecessary.
  for (const pdf of result.pdfs) {
    const filename = parseReportFilename(pdf.name);
    if (!pdf.studentId && ['pending', 'review'].includes(pdf.status) && filename.name && normalizeCohort(filename.grade, filename.section)) registerImportedReport(result, pdf);
  }
  for (const student of result.students) {
    for (const area of student.academic) if (!hasActiveGrades(area)) area.validated = false;
    for (const incident of student.discipline.incidents) {
      incident.measure ??= '';
      incident.evidence ??= '';
    }
    for (const record of [...student.institutional, ...student.family]) {
      record.justification ??= '';
      record.evidence ??= '';
      record.required ??= isAcademicContest(record) ? false : true;
    }
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
