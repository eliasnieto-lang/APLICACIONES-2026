import ExcelJS from 'exceljs';
import type { AppState } from '../shared/types.js';
import { calculateStudent, rankStudents } from '../shared/calculations.js';
import { ACTIVE_BIMESTERS, normalizeCohort } from '../shared/policy.js';
import { CONTEST_SCOPE_OPTIONS } from '../shared/contests.js';
import { hasActiveGrades } from '../shared/academic-policy.js';

export async function buildWorkbook(state: AppState, filters: {grade?:string;section?:string} = {}) {
  const workbook=new ExcelJS.Workbook();
  workbook.creator='Colegio Albert Einstein · Círculos';
  workbook.created=new Date();
  const requestedCohort=filters.grade?normalizeCohort(filters.grade,filters.section||'F'):null;
  const students=state.students.filter(s=>{const cohort=normalizeCohort(s.grade,s.section);return cohort&&(!filters.grade||cohort.grade===requestedCohort?.grade)&&(!filters.section||cohort.section===filters.section.trim().toUpperCase());});
  const ranked=rankStudents(students,state.settings);
  const ranking=workbook.addWorksheet('RANKING');
  ranking.addRow(['Puesto','Código','Estudiante','Grado','Sección','Académico A','Desempeño B','Compromiso C','Promedio TOTAL','Avance (%)','Estado','Cohorte']);
  for (const {student:s,result:r,position,cohort} of ranked) ranking.addRow([position,s.code,s.name,s.grade,s.section,r.a,r.b,r.c,r.total,r.progress,r.status,cohort]);
  const detail=workbook.addWorksheet('DETALLE');
  detail.addRow(['Código','Estudiante','G','R','P','Ciencias (1–4)','Letras (1–4)','Promedio I–II','Promedio III','Asistencia (%)','Puntualidad (%)','AP','Disciplina','Participación PI','Familia CF','Peso G','Peso R','Peso P','Peso AP','Peso D','Peso PI','Peso CF','Origen académico','Asistencia registrada','Incidencias verificadas','Participación registrada','Familia registrada','Historial de ajustes',...ACTIVE_BIMESTERS.map(period=>`Calificaciones ${period}`),'Puesto en concursos','Representación del colegio','Notas adicionales de la libreta']);
  for (const s of students) {
    const r=calculateStudent(s,state.settings);
    const pdfs=state.pdfs.filter(p=>s.pdfIds.includes(p.id));
    detail.addRow([s.code,s.name,r.g,r.r,r.p,r.science,r.letters,r.s1,r.s2,r.attendance,r.punctuality,r.ap,r.discipline,r.participation,r.family,
      state.settings.academicWeights.general,state.settings.academicWeights.specialized,state.settings.academicWeights.progress,
      state.settings.performanceWeights.attendance,state.settings.performanceWeights.discipline,state.settings.commitmentWeights.participation,state.settings.commitmentWeights.family,
      pdfs.length?pdfs.map(p=>`${p.name} | SHA-256 ${p.hash} | ${p.status}`).join('\n'):'Registro manual revisado',
      JSON.stringify(s.attendance),JSON.stringify(s.discipline),JSON.stringify(s.institutional),JSON.stringify(s.family),JSON.stringify(s.history),
      ...ACTIVE_BIMESTERS.map((_,period)=>JSON.stringify(s.academic.filter(hasActiveGrades).map(area=>({areaId:area.areaId,grades:area.grades.map(row=>row[period]??'')})))),
      JSON.stringify(s.institutional.map(record=>({id:record.id,name:record.name,placement:record.placement??''}))),
      JSON.stringify(s.institutional.map(record=>({id:record.id,name:record.name,representingSchool:record.representingSchool??null}))),JSON.stringify(pdfs.flatMap(pdf=>pdf.supplementalAreas??[]).filter(hasActiveGrades))]);
  }
  const pending=workbook.addWorksheet('PENDIENTES');
  pending.addRow(['Código','Estudiante','Grado','Sección','Avance (%)','PA (%)','PB (%)','PC (%)','Estado','Dimensiones y validaciones pendientes']);
  for (const s of students) {
    const r=calculateStudent(s,state.settings);
    if (!r.eligible) pending.addRow([s.code,s.name,s.grade,s.section,r.progress,r.pa,r.pb,r.pc,r.status,r.pending.join('; ')]);
  }
  const config=workbook.addWorksheet('CONFIGURACIÓN');
  config.addRow(['Parámetro','Valor']);
  const configRows: unknown[][]=[
    ['Año',state.settings.year],['Fecha de generación',new Date().toISOString()],['Versión del cálculo',state.settings.version],
    ['Fórmula total','(A + B + C) / 3; sin sustitución de dimensiones faltantes'],
    ['Regla de empate','Posición compartida al coincidir el total presentado con dos decimales'],
    ['Cohorte comparable','Grado y sección; posiciones independientes por cohorte'],
    ['Salones admitidos','2.º F, 3.º F y 4.º F'],['Bimestres evaluados','I, II y III'],['Áreas aplicables','Solo áreas con al menos una nota válida de I–III; las totalmente vacías o con solo IV se excluyen.'],['Validación manual académica','Confirma las notas reconocidas de las áreas aplicables completas; no agrega calificaciones.'],['Mínimo de incidencia','Categoría, fecha y descripción. Medida y evidencia opcionales.'],['Mínimo de compromiso familiar','Actividad, fecha y estado. Observación y evidencia opcionales.'],['Progresión','Promedio I–II comparado con III'],
    ['Filtro grado',filters.grade||'Todos'],['Filtro sección',filters.section||'Todas'],
    ['Criterios institucionales aprobados',state.settings.criteriaApproved?'Sí':'No'],
    ['Evaluación cerrada',state.settings.closed?'Sí':'No'],
    ['Peso académico G',state.settings.academicWeights.general],['Peso académico R',state.settings.academicWeights.specialized],['Peso académico P',state.settings.academicWeights.progress],
    ['Peso Ciencias en R',state.settings.scienceWeight],['Peso Letras en R',1-state.settings.scienceWeight],
    ['Peso asistencia y puntualidad',state.settings.performanceWeights.attendance],['Peso disciplina',state.settings.performanceWeights.discipline],
    ['Peso participación',state.settings.commitmentWeights.participation],['Peso familiar',state.settings.commitmentWeights.family],
    ['Regla No aplica',state.settings.naPolicy],['Regla No aplica aprobada',state.settings.naPolicyApproved?'Sí':'No'],
    ['Catálogo de áreas y competencias',JSON.stringify(state.settings.areas)],['Categorías y descuentos disciplinarios',JSON.stringify(state.settings.disciplineTypes)],
    ['Participación institucional','CONCURSOS ACADÉMICOS'],['Puntajes por alcance',JSON.stringify(CONTEST_SCOPE_OPTIONS)],['Cálculo PI','Mejor resultado registrado: Local40, Regional70, Nacional100; el ranking requiere validación.'],['Datos obligatorios del concurso','Tipo de evento (alcance), fecha y ubicación/puesto. Los demás campos son opcionales.'],['Catálogo de convocatorias',JSON.stringify(state.settings.activityTypes)],['Catálogo familiar',JSON.stringify(state.settings.familyTypes)],
    ['Criterios comunes por cohorte',JSON.stringify(state.settings.cohortRecords??[])],
    ['Estudiantes incluidos',ranked.length],['Expedientes pendientes',students.length-ranked.length],
    ['Decisión institucional','Los resultados no constituyen una decisión automática de exclusión.'],
  ];
  for (const row of configRows) config.addRow(row);
  for (const sheet of workbook.worksheets) {
    sheet.views=[{state:'frozen',ySplit:1}];
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
    sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFA72035'}};
    sheet.getRow(1).height=28;
    sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:sheet.columnCount}};
    sheet.columns.forEach((column,index)=>{column.width=index===2?35:24;});
    sheet.eachRow((row,index)=>{ if(index>1) row.eachCell(cell=>{if(typeof cell.value==='number') cell.numFmt='0.00'; cell.alignment={vertical:'top',wrapText:true};});});
  }
  // Keep legacy import identifiers available internally without showing them in reports.
  ranking.getColumn(2).hidden=true;
  detail.getColumn(1).hidden=true;
  pending.getColumn(1).hidden=true;
  ranking.getColumn(1).numFmt='0';
  config.getColumn(2).width=100;
  return workbook;
}
