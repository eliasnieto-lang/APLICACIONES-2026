import { z } from 'zod';
import type { Student, Settings, AppState } from '../shared/types.js';
import { normalizeCohort } from '../shared/policy.js';
import { resolveReportIdentity } from '../shared/filename-identity.js';
import { contestRequiredFields, isAcademicContest } from '../shared/contests.js';
import { hasActiveGrades, isAreaComplete } from '../shared/academic-policy.js';
import { commitmentRequiredFields, incidentRequiredFields } from '../shared/record-validation.js';
import { isCommitmentEnabled } from '../shared/evaluation-policy.js';

const text = z.string().max(2000);
const id = z.string().min(1).max(150);
const count = z.number().int().min(0).max(10000).nullable();
const grade = z.enum(['AD', 'A', 'B', 'C', '']);
const areaDefinition = z.object({ id, name: z.string().min(1).max(200), group: z.enum(['math','science','communication','social','dpcc','other']), competencies: z.array(z.string().min(1).max(500)).min(1).max(100), eligible: z.boolean() });
const academic = z.object({ areaId: id, grades: z.array(z.array(grade).min(3).max(4)).max(100), validated: z.boolean() });
const attendance = z.object({ required: count, attended: count, punctual: count, exempted: count, validated: z.boolean() });
const incident = z.object({ id, typeId: z.string().max(150), date: text, description: text, measure: text.default(''), evidence: text.default(''), verified: z.boolean() });
const commitment = z.object({ id, catalogId: id.optional(), name: text, date: text, required: z.boolean().default(true), status: z.enum(['pending','fulfilled','missed','justified','na']), justification: text.default(''), evidence: text.default(''), validated: z.boolean(), placement: text.optional(), representingSchool: z.boolean().optional(), eventType: z.literal('academic_contest').optional(), scope: z.enum(['local','regional','national']).optional() });
const contestCommitment = commitment.extend({ eventType: z.literal('academic_contest'), name: text.default(''), required: z.boolean().default(false), status: z.enum(['pending','fulfilled','missed','justified','na']).default('pending'), justification: text.default(''), evidence: text.default('') });
const history = z.object({ id, date: text, field: text, before: z.string().max(100000), after: z.string().max(100000) });
export const studentSchema = z.object({
  id, code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200), grade: z.string().trim().min(1).max(60), section: z.string().trim().min(1).max(20),
  academic: z.array(academic).max(100), attendance, discipline: z.object({ confirmed: z.boolean(), incidents: z.array(incident).max(1000) }),
  institutional: z.array(z.union([contestCommitment, commitment])).max(2000), family: z.array(commitment).max(2000),
  validated: z.object({ academic: z.boolean(), performance: z.boolean(), commitment: z.boolean() }),
  history: z.array(history).max(100000), pdfIds: z.array(id).max(1000), createdAt: text, updatedAt: text,
  reportApproval: z.object({ pdfId: id, approvedAt: z.string().datetime() }).optional(),
  commitmentEnabled: z.boolean().optional(),
  circleStatus: z.enum(['pending','remains','does_not_remain']).optional(),
});
export const newStudentSchema = studentSchema.pick({ code: true, name: true, grade: true, section: true });
const weight = z.number().min(0).max(1);
export const settingsSchema = z.object({
  year: z.number().int().min(2000).max(2200), version: z.string().min(1).max(100),
  areas: z.array(areaDefinition).min(1).max(100),
  academicWeights: z.object({general:weight,specialized:weight,progress:weight}), scienceWeight: weight,
  dimensionWeights: z.object({academic:weight,performance:weight,commitment:weight}).optional(),
  performanceWeights: z.object({attendance:weight,discipline:weight}), commitmentWeights:z.object({participation:weight,family:weight}),
  criteriaApproved:z.boolean(),naPolicy:z.enum(['pending','other_component']),naPolicyApproved:z.boolean(),
  disciplineTypes:z.array(z.object({id,name:z.string().min(1).max(200),discount:z.number().min(0).max(100).nullable(),punctuality:z.boolean()})).max(100),
  activityTypes:z.array(z.string().min(1).max(200)).max(200),familyTypes:z.array(z.string().min(1).max(200)).max(200),
  cohortRecords:z.array(z.object({id,kind:z.enum(['institutional','family']),name:z.string().trim().min(1).max(200),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),grade:z.string().trim().max(60),section:z.string().trim().max(20),required:z.boolean()})).max(2000).optional(),closed:z.boolean(),
  workflowVersion:z.literal(2).optional(), progressionComparison:z.literal('first_two_vs_third').optional(),
});
const pdfSchema = z.object({
  id, name:z.string().min(1).max(300),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(0).max(20*1024*1024),uploadedAt:text,
  status:z.enum(['pending','review','validated','failed','duplicate','replaced']),studentId:id.nullable(),
  extractedCode:text,extractedName:text,extractedGrade:text,extractedSection:text,period:text,text:z.string().max(4_194_304),ocr:z.boolean(),
  warnings:z.array(text).max(1000),areas:z.array(academic).max(100),replacesId:id.optional(),
  supplementalAreas:z.array(z.object({definition:areaDefinition,grades:z.array(z.array(grade).min(3).max(4)).max(100)}).refine(area=>area.grades.length===area.definition.competencies.length,'Las competencias adicionales deben corresponder a sus notas.')).max(100).optional(),
  manualName:z.string().max(200).optional(),
  confirmedIdentity:z.object({code:z.string().trim().min(1).max(100),name:z.string().trim().min(1).max(200),grade:z.string().trim().min(1).max(60),section:z.string().trim().min(1).max(20)}).optional(),
});
export const stateSchema = z.object({ students: z.array(studentSchema).max(10000),settings:settingsSchema,pdfs:z.array(pdfSchema).max(10000) });
export const backupSchema = z.object({
  format:z.literal('circulos-backup'),version:z.literal(1),dataset:z.enum(['real','demo']),createdAt:text,state:stateSchema,
  files:z.array(z.object({id,content:z.string().max(28_000_000)})).max(10000),
});

export function semanticStudentErrors(student: Student, settings: Settings): string[] {
  const errors: string[] = [];
  const a = student.attendance;
  const days = a.required === null || a.exempted === null ? null : a.required - a.exempted;
  if (days !== null && days < 0) errors.push('Los días eximidos no pueden superar los días lectivos.');
  if (days !== null && a.attended !== null && a.attended > days) errors.push('Las asistencias no pueden superar los días exigibles.');
  if (a.attended !== null && a.punctual !== null && a.punctual > a.attended) errors.push('Los ingresos puntuales no pueden superar las asistencias.');
  if (new Set(student.academic.map(v=>v.areaId)).size !== student.academic.length) errors.push('Hay áreas académicas duplicadas.');
  for (const area of student.academic) {
    const def = settings.areas.find(v=>v.id===area.areaId);
    if (!def || def.competencies.length !== area.grades.length) errors.push('Las áreas y competencias deben corresponder al catálogo vigente.');
    if (def && hasActiveGrades(area) && area.validated && !isAreaComplete(def, area, student)) errors.push('No se puede validar un área con calificaciones vacías en I, II o III, salvo Indaga completamente vacía y no cursada.');
  }
  if (new Set(student.discipline.incidents.map(v=>v.id)).size !== student.discipline.incidents.length) errors.push('Hay incidencias duplicadas.');
  for (const incident of student.discipline.incidents) {
    const type=settings.disciplineTypes.find(v=>v.id===incident.typeId);
    if (!type && (incident.typeId.trim() || incident.verified)) errors.push('La categoría disciplinaria no existe en el catálogo.');
    const missing = incidentRequiredFields(incident, settings.disciplineTypes);
    if (incident.verified && missing.length) errors.push(`Una incidencia verificada necesita ${missing.join(', ')}.`);
  }
  for (const record of isCommitmentEnabled(student) ? [...student.institutional,...student.family] : []) {
    const contest = student.institutional.includes(record) && isAcademicContest(record);
    if (contest) {
      const missing = contestRequiredFields(record);
      if (record.validated && missing.length) errors.push(`Un concurso académico validado necesita ${missing.join(', ')}.`);
    } else {
      const missing = commitmentRequiredFields(record);
      if (record.validated && missing.length) errors.push(`Un compromiso validado necesita ${missing.join(', ')}.`);
    }
    if(record.catalogId && !contest){
      const criterion=settings.cohortRecords?.find(c=>c.id===record.catalogId);
      if(!criterion)errors.push('El registro está vinculado a un criterio de cohorte inexistente.');
      else {
        if(record.name.trim()!==criterion.name.trim()||record.date!==criterion.date||record.required!==criterion.required)errors.push('El nombre, fecha y condición exigible de un criterio común solo pueden modificarse en Parámetros.');
        const correctKind=criterion.kind==='institutional'?student.institutional:student.family;
        if(!correctKind.includes(record))errors.push('El criterio de cohorte está registrado en un ámbito incorrecto.');
        const target=normalizeCohort(criterion.grade,criterion.section||student.section);
        const studentCohort=normalizeCohort(student.grade,student.section);
        if((criterion.grade.trim()&&(!target||target.grade!==studentCohort?.grade))||(criterion.section.trim()&&criterion.section.trim().toUpperCase()!==student.section.trim().toUpperCase()))errors.push('El criterio de cohorte no corresponde al grado y sección del estudiante.');
      }
    }
  }
  const linked=(isCommitmentEnabled(student) ? [...student.institutional,...student.family] : []).map(r=>r.catalogId).filter(Boolean);
  if(new Set(linked).size!==linked.length)errors.push('Hay registros duplicados para un mismo criterio de cohorte.');
  return [...new Set(errors)];
}
export function stateReferenceErrors(state: AppState): string[] {
  const errors: string[]=[];
  if (new Set(state.students.map(s=>s.id)).size!==state.students.length) errors.push('IDs de estudiante duplicados.');
  if (new Set(state.students.map(s=>s.code.toLocaleLowerCase())).size!==state.students.length) errors.push('Códigos de estudiante duplicados.');
  if (new Set(state.pdfs.map(p=>p.id)).size!==state.pdfs.length) errors.push('IDs de PDF duplicados.');
  const ids=new Set(state.students.map(s=>s.id));
  const pdfIds=new Set(state.pdfs.map(s=>s.id));
  for (const pdf of state.pdfs) {
    if(pdf.studentId && !ids.has(pdf.studentId)) errors.push('Un PDF apunta a un estudiante inexistente.');
    if(pdf.studentId && !state.students.find(s=>s.id===pdf.studentId)?.pdfIds.includes(pdf.id)) errors.push('El vínculo del PDF no aparece en el expediente del estudiante.');
    if(pdf.replacesId && (!pdfIds.has(pdf.replacesId)||pdf.replacesId===pdf.id)) errors.push('La versión anterior de un PDF no existe o se refiere a sí misma.');
  }
  for (const student of state.students) {
    if(student.pdfIds.some(id=>!pdfIds.has(id))) errors.push('Un estudiante apunta a un PDF inexistente.');
    if(new Set(student.pdfIds).size!==student.pdfIds.length)errors.push('Un expediente contiene vínculos PDF duplicados.');
    if(student.pdfIds.some(id=>state.pdfs.find(pdf=>pdf.id===id)?.studentId!==student.id))errors.push('Un expediente contiene un PDF vinculado a otro estudiante.');
    if(student.reportApproval){
      const pdf=state.pdfs.find(record=>record.id===student.reportApproval!.pdfId);
      const identity=pdf?{...resolveReportIdentity(pdf),code:pdf.confirmedIdentity?.code??pdf.extractedCode}:null;
      const cohort=identity?normalizeCohort(identity.grade,identity.section):null;
      const studentCohort=normalizeCohort(student.grade,student.section);
      const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase();
      if(!pdf||pdf.status!=='validated'||pdf.studentId!==student.id||!student.pdfIds.includes(pdf.id)||!identity||!cohort||cohort.label!==studentCohort?.label||(Boolean(normalize(identity.code))&&normalize(identity.code)!==normalize(student.code))||normalize(identity.name)!==normalize(student.name))errors.push('La aprobación de libreta no corresponde a un PDF validado y a la identidad del estudiante.');
    }
    errors.push(...semanticStudentErrors(student,state.settings));
  }
  return [...new Set(errors)];
}
