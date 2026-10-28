import { z } from 'zod';
import type { Student, Settings, AppState } from '../shared/types.js';

const text = z.string().max(2000);
const id = z.string().min(1).max(150);
const count = z.number().int().min(0).max(10000).nullable();
const grade = z.enum(['AD', 'A', 'B', 'C', '']);
const academic = z.object({ areaId: id, grades: z.array(z.array(grade).length(4)).max(100), validated: z.boolean() });
const attendance = z.object({ required: count, attended: count, punctual: count, exempted: count, validated: z.boolean() });
const incident = z.object({ id, typeId: id, date: text, description: text, measure: text, evidence: text, verified: z.boolean() });
const commitment = z.object({ id, catalogId: id.optional(), name: text, date: text, required: z.boolean(), status: z.enum(['pending','fulfilled','missed','justified','na']), justification: text, evidence: text, validated: z.boolean() });
const history = z.object({ id, date: text, field: text, before: z.string().max(100000), after: z.string().max(100000) });
export const studentSchema = z.object({
  id, code: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200), grade: z.string().trim().min(1).max(60), section: z.string().trim().min(1).max(20),
  academic: z.array(academic).max(100), attendance, discipline: z.object({ confirmed: z.boolean(), incidents: z.array(incident).max(1000) }),
  institutional: z.array(commitment).max(2000), family: z.array(commitment).max(2000),
  validated: z.object({ academic: z.boolean(), performance: z.boolean(), commitment: z.boolean() }),
  history: z.array(history).max(100000), pdfIds: z.array(id).max(1000), createdAt: text, updatedAt: text,
});
export const newStudentSchema = studentSchema.pick({ code: true, name: true, grade: true, section: true });
const weight = z.number().min(0).max(1);
export const settingsSchema = z.object({
  year: z.number().int().min(2000).max(2200), version: z.string().min(1).max(100),
  areas: z.array(z.object({ id, name: z.string().min(1).max(200), group: z.enum(['math','science','communication','social','dpcc','other']), competencies: z.array(z.string().min(1).max(500)).min(1).max(100), eligible: z.boolean() })).min(1).max(100),
  academicWeights: z.object({general:weight,specialized:weight,progress:weight}), scienceWeight: weight,
  performanceWeights: z.object({attendance:weight,discipline:weight}), commitmentWeights:z.object({participation:weight,family:weight}),
  criteriaApproved:z.boolean(),naPolicy:z.enum(['pending','other_component']),naPolicyApproved:z.boolean(),
  disciplineTypes:z.array(z.object({id,name:z.string().min(1).max(200),discount:z.number().min(0).max(100).nullable(),punctuality:z.boolean()})).max(100),
  activityTypes:z.array(z.string().min(1).max(200)).max(200),familyTypes:z.array(z.string().min(1).max(200)).max(200),
  cohortRecords:z.array(z.object({id,kind:z.enum(['institutional','family']),name:z.string().trim().min(1).max(200),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),grade:z.string().trim().max(60),section:z.string().trim().max(20),required:z.boolean()})).max(2000).optional(),closed:z.boolean(),
});
const pdfSchema = z.object({
  id, name:z.string().min(1).max(300),hash:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(0).max(20*1024*1024),uploadedAt:text,
  status:z.enum(['pending','review','validated','failed','duplicate','replaced']),studentId:id.nullable(),
  extractedCode:text,extractedName:text,extractedGrade:text,extractedSection:text,period:text,text:z.string().max(4_194_304),ocr:z.boolean(),
  warnings:z.array(text).max(1000),areas:z.array(academic).max(100),replacesId:id.optional(),
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
    if (area.validated && area.grades.some(row=>row.some(v=>!v))) errors.push('No se puede validar un área con calificaciones vacías.');
  }
  if (new Set(student.discipline.incidents.map(v=>v.id)).size !== student.discipline.incidents.length) errors.push('Hay incidencias duplicadas.');
  for (const incident of student.discipline.incidents) {
    const type=settings.disciplineTypes.find(v=>v.id===incident.typeId);
    if (!type) errors.push('La categoría disciplinaria no existe en el catálogo.');
    if (incident.verified && (!/^\d{4}-\d{2}-\d{2}$/.test(incident.date) || !incident.description.trim() || !incident.measure.trim() || !incident.evidence.trim())) errors.push('Una incidencia verificada necesita fecha, descripción, medida y evidencia.');
  }
  for (const record of [...student.institutional,...student.family]) {
    if (record.validated && (record.status==='pending' || !record.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !record.evidence.trim())) errors.push('Un compromiso validado necesita nombre, fecha, estado y evidencia documental.');
    if (record.validated && (!record.required || ['justified','na'].includes(record.status)) && !record.justification.trim()) errors.push('Los registros justificados, no exigibles o No aplica requieren justificación.');
    if(record.catalogId){
      const criterion=settings.cohortRecords?.find(c=>c.id===record.catalogId);
      if(!criterion)errors.push('El registro está vinculado a un criterio de cohorte inexistente.');
      else {
        if(record.name.trim()!==criterion.name.trim()||record.date!==criterion.date||record.required!==criterion.required)errors.push('El nombre, fecha y condición exigible de un criterio común solo pueden modificarse en Parámetros.');
        const correctKind=criterion.kind==='institutional'?student.institutional:student.family;
        if(!correctKind.includes(record))errors.push('El criterio de cohorte está registrado en un ámbito incorrecto.');
        if((criterion.grade.trim()&&criterion.grade.trim()!==student.grade.trim())||(criterion.section.trim()&&criterion.section.trim()!==student.section.trim()))errors.push('El criterio de cohorte no corresponde al grado y sección del estudiante.');
      }
    }
  }
  const linked=[...student.institutional,...student.family].map(r=>r.catalogId).filter(Boolean);
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
  for (const pdf of state.pdfs) if(pdf.studentId && !ids.has(pdf.studentId)) errors.push('Un PDF apunta a un estudiante inexistente.');
  for (const student of state.students) {
    if(student.pdfIds.some(id=>!pdfIds.has(id))) errors.push('Un estudiante apunta a un PDF inexistente.');
    errors.push(...semanticStudentErrors(student,state.settings));
  }
  return [...new Set(errors)];
}
