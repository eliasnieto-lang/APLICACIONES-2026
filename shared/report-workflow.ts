import { createStudent } from './defaults.js';
import { cohortRecordApplies } from './calculations.js';
import { ACTIVE_BIMESTERS, normalizeCohort } from './policy.js';
import { applyFilenameIdentity, resolveReportIdentity } from './filename-identity.js';
import type { AppState, Grade, PdfRecord, Settings, Student } from './types.js';
import { reportWarnings, type ExtractedReport } from './pdf-parser.js';
import { activeAreas, hasActiveGrades, isAreaComplete } from './academic-policy.js';

type Identity = NonNullable<PdfRecord['confirmedIdentity']>;
const stamp = () => new Date().toISOString();
const codeKey = (code: string) => code.trim().toLocaleLowerCase();
const nameKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const audit = (student: Student, field: string, before: unknown, after: unknown) => student.history.push({ id: globalThis.crypto.randomUUID(), date: stamp(), field, before: typeof before === 'string' ? before : JSON.stringify(before), after: typeof after === 'string' ? after : JSON.stringify(after) });

export class ReportWorkflowError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function identityOf(pdf: PdfRecord): Identity {
  return { ...resolveReportIdentity(pdf), code: pdf.confirmedIdentity?.code ?? pdf.extractedCode };
}

function normalizeIdentity(input: Identity): Identity | null {
  if (!input || typeof input.code !== 'string' || typeof input.name !== 'string') return null;
  const code = input.code.trim(), name = input.name.trim().replace(/\s+/g, ' ');
  const cohort = normalizeCohort(input.grade, input.section);
  if (code.length > 100 || !name || name.length > 200 || !cohort) return null;
  return { code, name, grade: cohort.grade, section: cohort.section };
}

function sameNameAndCohort(student: Student, identity: Identity): boolean {
  const cohort = normalizeCohort(student.grade, student.section);
  return nameKey(student.name) === nameKey(identity.name) && cohort?.grade === identity.grade && cohort.section === identity.section;
}

function sameIdentity(student: Student, identity: Identity): boolean {
  return (!identity.code || codeKey(student.code) === codeKey(identity.code)) && sameNameAndCohort(student, identity);
}

function warn(pdf: PdfRecord, warning: string): void {
  if (!pdf.warnings.includes(warning)) pdf.warnings.push(warning);
}

function internalCode(state: AppState, pdf: PdfRecord): string {
  const base = `AUTO-${pdf.id}`.slice(0, 90);
  let code = base, suffix = 1;
  while (state.students.some(student => codeKey(student.code) === codeKey(code))) code = `${base}-${suffix++}`;
  return code;
}

function matchingStudents(state: AppState, identity: Identity): Student[] {
  return identity.code
    ? state.students.filter(candidate => codeKey(candidate.code) === codeKey(identity.code))
    : state.students.filter(candidate => sameNameAndCohort(candidate, identity));
}

/** Copies active periods and retains historical grades. Manual B/C records are retained. */
export function linkAcademic(student: Student, pdf: PdfRecord, settings: Settings, replace = true): void {
  const before = structuredClone(student.academic);
  student.academic = settings.areas.map(def => {
    const source = pdf.areas.find(area => area.areaId === def.id);
    const old = replace ? undefined : student.academic.find(area => area.areaId === def.id);
    return { areaId: def.id, grades: def.competencies.map((_, index) => Array.from({ length: Math.max(ACTIVE_BIMESTERS.length, source?.grades[index]?.length ?? 0, old?.grades[index]?.length ?? 0) }, (__, period) => {
      const value = source?.grades[index]?.[period] ?? old?.grades[index]?.[period] ?? '';
      return (['AD', 'A', 'B', 'C', ''].includes(value) ? value : '') as Grade;
    })), validated: false };
  });
  student.validated.academic = false;
  delete student.reportApproval;
  if (!student.pdfIds.includes(pdf.id)) student.pdfIds.push(pdf.id);
  student.updatedAt = stamp();
  audit(student, `Importación PDF: ${pdf.name}`, before, student.academic);
}

function detachReport(state: AppState, pdf: PdfRecord, targetId: string): void {
  const prior = state.students.find(student => student.id === pdf.studentId && student.id !== targetId);
  if (prior) {
    prior.pdfIds = prior.pdfIds.filter(id => id !== pdf.id);
    if (prior.reportApproval?.pdfId === pdf.id) {
      delete prior.reportApproval;
      prior.validated.academic = false;
      prior.academic.forEach(area => { area.validated = false; });
    }
    prior.updatedAt = stamp();
    audit(prior, 'Reasignación de PDF', pdf.name, targetId);
  }
}

function supersedeReports(state: AppState, pdf: PdfRecord, student: Student): void {
  const active = state.pdfs.filter(prior => prior.id !== pdf.id && prior.studentId === student.id && (prior.status === 'validated' || prior.status === 'review' || prior.status === 'pending'));
  for (const prior of active) prior.status = 'replaced';
  if (!pdf.replacesId && active.length) pdf.replacesId = active[active.length - 1].id;
}

/** Filename identity can create a provisional student without a student code or PDF text. */
export function registerImportedReport(state: AppState, pdf: PdfRecord): Student | null {
  applyFilenameIdentity(pdf);
  if (pdf.status === 'failed' || pdf.status === 'duplicate' || pdf.status === 'replaced') return null;
  const identity = normalizeIdentity(identityOf(pdf));
  if (!identity) {
    pdf.status = 'review';
    warn(pdf, 'Revise los apellidos y nombres y el aula. Solo se admiten 2.º F, 3.º F, 4.º F y 5.º F.');
    return null;
  }
  const linked = state.students.find(candidate => candidate.id === pdf.studentId);
  const matches = matchingStudents(state, identity);
  if (!linked && matches.length > 1) {
    warn(pdf, 'Hay varios expedientes con los mismos apellidos, nombres y aula. Seleccione el expediente correcto antes de confirmar.');
    return null;
  }
  let student = linked ?? matches[0];
  if (student && (!sameNameAndCohort(student, identity) || (identity.code && codeKey(student.code) !== codeKey(identity.code) && !student.code.startsWith('AUTO-')))) {
    warn(pdf, 'La identidad corresponde a un expediente con otros datos. Confirme la identidad antes de aplicar la libreta.');
    return null;
  }
  if (linked && matches.some(candidate => candidate.id !== linked.id)) {
    warn(pdf, 'La identidad corresponde a otro expediente. Revise el vínculo antes de confirmar la libreta.');
    return null;
  }
  if (!student) {
    student = createStudent({ ...identity, code: identity.code || internalCode(state, pdf) }, state.settings);
    audit(student, 'Creación desde PDF', '', { ...identity, code: student.code });
    state.students.push(student);
  }
  supersedeReports(state, pdf, student);
  pdf.studentId = student.id;
  pdf.status = 'review';
  linkAcademic(student, pdf, state.settings);
  return student;
}

/** Save an editable name independently of academic confirmation or a new OCR reading. */
export function identifyReport(state: AppState, pdfId: string, options: { name: string; grade?: string; section?: string }): PdfRecord {
  const pdf = state.pdfs.find(record => record.id === pdfId);
  if (!pdf) throw new ReportWorkflowError(404, 'PDF no encontrado.');
  if (!['pending', 'review'].includes(pdf.status)) throw new ReportWorkflowError(409, 'Esta versión no admite cambios de nombre pendientes.');
  if (typeof options.name !== 'string' || options.name.trim().length > 200) throw new ReportWorkflowError(400, 'Los apellidos y nombres deben tener como máximo 200 caracteres.');
  const name = options.name.trim().replace(/\s+/g, ' ');
  const beforeName = resolveReportIdentity(pdf).name;
  const linked = state.students.find(student => student.id === pdf.studentId);
  const current = identityOf(pdf);
  const cohort = normalizeCohort(options.grade ?? current.grade, options.section ?? current.section);
  if ((options.grade !== undefined || options.section !== undefined) && !cohort) throw new ReportWorkflowError(400, 'Solo se admiten 2.º F, 3.º F, 4.º F y 5.º F.');
  const draftMatches = !linked && name && cohort ? matchingStudents(state, { ...current, name, grade: cohort.grade, section: cohort.section }) : [];
  if (draftMatches.length > 1) throw new ReportWorkflowError(409, 'Hay varios expedientes con los mismos apellidos, nombres y aula. Seleccione el expediente correcto antes de confirmar.');
  pdf.manualName = name;
  if (cohort && (options.grade !== undefined || options.section !== undefined)) {
    if (name || current.name) pdf.confirmedIdentity = { code: linked?.code || draftMatches[0]?.code || current.code || internalCode(state, pdf), name: name || current.name, grade: cohort.grade, section: cohort.section };
    else { pdf.extractedGrade = cohort.grade; pdf.extractedSection = cohort.section; }
  }
  if (linked && name && linked.name !== name) {
    linked.name = name;
    linked.updatedAt = stamp();
    audit(linked, 'Corrección del nombre de la libreta', beforeName, name);
  } else if (!linked && name && cohort) registerImportedReport(state, pdf);
  return pdf;
}

/** Retry the retained original without changing its id, bytes or manual B/C records. */
export function applyReprocessedReport(state: AppState, pdfId: string, reading: ExtractedReport): PdfRecord {
  const pdf = state.pdfs.find(record => record.id === pdfId);
  if (!pdf) throw new ReportWorkflowError(404, 'PDF no encontrado.');
  if (!['pending', 'review', 'failed'].includes(pdf.status)) throw new ReportWorkflowError(409, 'Esta versión ya está confirmada, duplicada o reemplazada; su lectura se conserva.');
  const linked = state.students.find(student => student.id === pdf.studentId);
  const before = { code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade, section: pdf.extractedSection, status: pdf.status };
  Object.assign(pdf, structuredClone(reading), { status: 'review' });
  applyFilenameIdentity(pdf);
  const identity = normalizeIdentity(identityOf(pdf));
  // An automatic retry cannot silently move this report or overwrite a different student.
  if (linked && (!identity || !sameNameAndCohort(linked, identity) || (identity.code && codeKey(linked.code) !== codeKey(identity.code) && !linked.code.startsWith('AUTO-')))) {
    pdf.warnings.push('La lectura automática todavía no coincide completamente con la ficha vinculada. Se conservaron la ficha y sus registros; esta libreta sigue sin confirmar.');
  } else registerImportedReport(state, pdf);
  const student = state.students.find(candidate => candidate.id === pdf.studentId);
  if (student) {
    student.updatedAt = stamp();
    audit(student, 'Nueva lectura automática del PDF original', before, { code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade, section: pdf.extractedSection });
  }
  return pdf;
}

/** Refresh A from the retained original while preserving identity, approval and all manual B/C data. */
export function applyRescannedGrades(state: AppState, pdfId: string, reading: ExtractedReport): PdfRecord {
  const pdf = state.pdfs.find(record => record.id === pdfId);
  if (!pdf) throw new ReportWorkflowError(404, 'PDF no encontrado.');
  if (!['review', 'validated'].includes(pdf.status)) throw new ReportWorkflowError(409, 'Solo una libreta activa en revisión o validada permite actualizar sus notas.');
  const student = state.students.find(candidate => candidate.id === pdf.studentId);
  if (!student || !student.pdfIds.includes(pdf.id)) throw new ReportWorkflowError(409, 'La libreta debe estar vinculada a un expediente antes de actualizar sus notas.');
  if (student.reportApproval && student.reportApproval.pdfId !== pdf.id) throw new ReportWorkflowError(409, 'Las notas solo pueden actualizarse desde la libreta activa del expediente.');
  const before = structuredClone(student.academic);
  // The previous PDF reading is independent evidence. Manual academic edits are
  // deliberately excluded so a retry restores grades from the original document.
  let usedRetainedGrade = false;
  const priorOcr = pdf.ocr;
  const gradeFromDocument = (recognized: Grade | undefined, retained: Grade | undefined): Grade => {
    if (recognized && ['AD', 'A', 'B', 'C'].includes(recognized)) return recognized;
    if (retained && ['AD', 'A', 'B', 'C'].includes(retained)) { usedRetainedGrade = true; return retained; }
    return '';
  };
  pdf.areas = state.settings.areas.map(def => {
    const source = reading.areas.find(area => area.areaId === def.id);
    const previous = pdf.areas.find(area => area.areaId === def.id);
    const grades = def.competencies.map((_, index) => Array.from({ length: Math.max(ACTIVE_BIMESTERS.length, source?.grades[index]?.length ?? 0, previous?.grades[index]?.length ?? 0) }, (__, period) => {
      const recognized = source?.grades[index]?.[period];
      const retained = previous?.grades[index]?.[period];
      return gradeFromDocument(recognized, retained);
    }));
    return { areaId: def.id, grades, validated: isAreaComplete(def, { grades }) };
  });
  const supplemental = reading.supplementalAreas ?? [];
  const previousSupplemental = pdf.supplementalAreas ?? [];
  if (supplemental.length || previousSupplemental.length) {
    const definitions = [...supplemental, ...previousSupplemental.filter(previous => !supplemental.some(area => area.definition.id === previous.definition.id))];
    pdf.supplementalAreas = definitions.map(area => {
      const source = supplemental.find(candidate => candidate.definition.id === area.definition.id);
      const previous = previousSupplemental.find(candidate => candidate.definition.id === area.definition.id);
      return { definition: structuredClone(area.definition), grades: area.definition.competencies.map(competency => {
        const sourceIndex = source?.definition.competencies.indexOf(competency) ?? -1;
        const previousIndex = previous?.definition.competencies.indexOf(competency) ?? -1;
        return Array.from({ length: Math.max(ACTIVE_BIMESTERS.length, sourceIndex >= 0 ? source?.grades[sourceIndex]?.length ?? 0 : 0, previousIndex >= 0 ? previous?.grades[previousIndex]?.length ?? 0 : 0) }, (_, period) => gradeFromDocument(sourceIndex >= 0 ? source?.grades[sourceIndex]?.[period] : undefined, previousIndex >= 0 ? previous?.grades[previousIndex]?.[period] : undefined));
      }) };
    });
  }
  pdf.text = reading.text;
  pdf.ocr = reading.ocr || usedRetainedGrade && priorOcr;
  const initialSummary = new Set([...reportWarnings(reading, state.settings), ...reportWarnings(reading, state.settings, student)]);
  pdf.warnings = [...new Set([...reading.warnings.filter(warning => !initialSummary.has(warning)), ...reportWarnings(pdf, state.settings, student)])];
  student.academic = structuredClone(pdf.areas);
  for (const area of student.academic) {
    const previous = before.find(candidate => candidate.areaId === area.areaId);
    area.grades.forEach((row, competency) => {
      for (let period = ACTIVE_BIMESTERS.length; period < (previous?.grades[competency]?.length ?? 0); period++) {
        row[period] ??= previous!.grades[competency][period];
      }
    });
  }
  const eligible = activeAreas(student, state.settings);
  student.validated.academic = eligible.length > 0 && eligible.every(def => student.academic.find(area => area.areaId === def.id)?.validated === true);
  student.updatedAt = stamp();
  audit(student, 'Actualización automática de notas desde el PDF original', before, student.academic);
  return pdf;
}

export function confirmReport(state: AppState, pdfId: string, options: { identity?: Identity; name?: string; grade?: string; section?: string; confirmMismatch?: boolean } = {}): { pdf: PdfRecord; student: Student } {
  const pdf = state.pdfs.find(record => record.id === pdfId);
  if (!pdf) throw new ReportWorkflowError(404, 'PDF no encontrado.');
  if (pdf.status === 'failed' || pdf.status === 'duplicate' || pdf.status === 'replaced') throw new ReportWorkflowError(400, 'Un PDF fallido, duplicado o reemplazado no puede confirmarse.');
  applyFilenameIdentity(pdf);
  const linked = state.students.find(student => student.id === pdf.studentId);
  const base = options.identity ?? identityOf(pdf);
  const identity = normalizeIdentity({ ...base, name: options.name ?? base.name, grade: options.grade ?? base.grade, section: options.section ?? base.section });
  if (!identity) throw new ReportWorkflowError(400, 'Complete los apellidos y nombres y un aula habilitada para confirmar la libreta.');
  const matches = matchingStudents(state, identity);
  if (!linked && matches.length > 1) throw new ReportWorkflowError(409, 'Hay varios expedientes con los mismos apellidos, nombres y aula. Seleccione el expediente correcto antes de confirmar.');
  const existing = matches[0];
  const explicitIdentity = options.identity !== undefined || options.name !== undefined || options.grade !== undefined || options.section !== undefined || pdf.manualName !== undefined || pdf.confirmedIdentity !== undefined;
  let student = linked ?? existing;
  // A name edit applies to the linked student; only an explicitly supplied code can reassign it.
  if (existing && existing.id !== linked?.id && (!linked || Boolean(identity.code))) {
    if ((!sameIdentity(existing, identity) || linked) && options.confirmMismatch !== true) throw new ReportWorkflowError(409, 'La identidad corresponde a otro expediente. Confirme la reasignación antes de aplicar la libreta.');
    student = existing;
  }
  if (linked && !explicitIdentity && (!sameNameAndCohort(linked, identity) || (identity.code && codeKey(linked.code) !== codeKey(identity.code) && !linked.code.startsWith('AUTO-'))) && options.confirmMismatch !== true) throw new ReportWorkflowError(409, 'La identidad extraída no coincide. Revise y confirme la reasignación.');
  if (!student) {
    student = createStudent({ ...identity, code: identity.code || internalCode(state, pdf) }, state.settings);
    state.students.push(student);
    audit(student, 'Creación desde PDF confirmado', '', { ...identity, code: student.code });
  }
  // Codes are an internal persistence key; correcting a name never asks the user for one.
  identity.code = options.identity?.code?.trim() || student.code;
  if (options.name !== undefined) pdf.manualName = identity.name;
  const preserveAcademic = student.id === linked?.id && pdf.status === 'validated' && student.reportApproval?.pdfId === pdf.id;
  const priorIdentity = { code: student.code, name: student.name, grade: student.grade, section: student.section };
  detachReport(state, pdf, student.id);
  Object.assign(student, identity);
  const priorCommitments = { institutional: structuredClone(student.institutional), family: structuredClone(student.family) };
  let detachedCommitment = false;
  for (const kind of ['institutional', 'family'] as const) for (const record of student[kind]) {
    if (!record.catalogId) continue;
    const criterion = state.settings.cohortRecords?.find(candidate => candidate.id === record.catalogId && candidate.kind === kind && cohortRecordApplies(candidate, student));
    if (!criterion) { delete record.catalogId; record.validated = false; detachedCommitment = true; }
  }
  if (detachedCommitment) {
    student.validated.commitment = false;
    audit(student, 'Desvinculación de pauta tras confirmar identidad', priorCommitments, { institutional: student.institutional, family: student.family });
  }
  pdf.confirmedIdentity = identity;
  supersedeReports(state, pdf, student);
  pdf.studentId = student.id;
  if (!preserveAcademic) {
    linkAcademic(student, pdf, state.settings);
    for (const area of student.academic) {
      const definition = state.settings.areas.find(candidate => candidate.id === area.areaId);
      area.validated = Boolean(definition && isAreaComplete(definition, area));
    }
    const eligibleAreas = activeAreas(student, state.settings);
    student.validated.academic = eligibleAreas.length > 0 && eligibleAreas.every(def => student!.academic.find(area => area.areaId === def.id)?.validated === true);
  }
  for (const area of student.academic) if (!hasActiveGrades(area)) area.validated = false;
  pdf.status = 'validated';
  student.reportApproval = { pdfId: pdf.id, approvedAt: stamp() };
  student.updatedAt = stamp();
  if (JSON.stringify(priorIdentity) !== JSON.stringify(identity)) audit(student, 'Identidad del PDF confirmada', priorIdentity, identity);
  audit(student, 'Lectura PDF confirmada', pdf.name, { identity, academic: student.validated.academic });
  return { pdf, student };
}

/** Delete an explicitly selected student, including every owned version and unowned duplicate. */
export function deleteStudentAndReports(state: AppState, studentId: string): { studentId: string; deletedPdfIds: string[] } {
  const student = state.students.find(candidate => candidate.id === studentId);
  if (!student) throw new ReportWorkflowError(404, 'Estudiante no encontrado.');
  const ids = state.pdfs.filter(record => record.studentId === student.id || (!record.studentId && student.pdfIds.includes(record.id))).map(record => record.id);
  return { ...removeReportsAndStudent(state, student, ids), studentId: student.id };
}

/** Uses explicit links only; a code found in PDF text never selects a student for deletion. */
export function deleteReportAndStudent(state: AppState, pdfId: string): { studentId: string | null; deletedPdfIds: string[] } {
  const pdf = state.pdfs.find(record => record.id === pdfId);
  if (!pdf) throw new ReportWorkflowError(404, 'PDF no encontrado.');
  const student = state.students.find(candidate => candidate.id === pdf.studentId);
  if (student) return deleteStudentAndReports(state, student.id);
  return removeReportsAndStudent(state, undefined, [pdf.id]);
}

function removeReportsAndStudent(state: AppState, student: Student | undefined, initialIds: string[]): { studentId: string | null; deletedPdfIds: string[] } {
  const ids = new Set(initialIds);
  let changed = true;
  while (changed) {
    changed = false;
    const selected = state.pdfs.filter(record => ids.has(record.id));
    const hashes = new Set(selected.map(record => record.hash).filter(Boolean));
    const predecessors = new Set(selected.map(record => record.replacesId).filter(Boolean));
    for (const record of state.pdfs) {
      if (ids.has(record.id)) continue;
      const sameOwner = !record.studentId || record.studentId === student?.id;
      const duplicate = record.status === 'duplicate' && hashes.has(record.hash);
      const version = predecessors.has(record.id) || Boolean(record.replacesId && ids.has(record.replacesId));
      if (sameOwner && (duplicate || version)) { ids.add(record.id); changed = true; }
    }
  }
  state.pdfs = state.pdfs.filter(record => !ids.has(record.id));
  if (student) state.students = state.students.filter(candidate => candidate.id !== student.id);
  for (const remaining of state.students) {
    remaining.pdfIds = remaining.pdfIds.filter(id => !ids.has(id));
    if (remaining.reportApproval && ids.has(remaining.reportApproval.pdfId)) {
      delete remaining.reportApproval;
      remaining.validated.academic = false;
      remaining.academic.forEach(area => { area.validated = false; });
      remaining.updatedAt = stamp();
    }
  }
  for (const remaining of state.pdfs) if (remaining.replacesId && ids.has(remaining.replacesId)) delete remaining.replacesId;
  return { studentId: student?.id ?? null, deletedPdfIds: [...ids] };
}
