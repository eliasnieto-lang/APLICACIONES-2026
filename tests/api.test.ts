import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { createApp } from '../server/index.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AppState, Student } from '../shared/types.js';
import { createStudent, defaultSettings } from '../shared/defaults.js';
import { SUPPLEMENTAL_REPORT_AREAS } from '../shared/report-catalog.js';
import { applyRescannedGrades, deleteStudentAndReports } from '../shared/report-workflow.js';
import type { ExtractedReport } from '../shared/pdf-parser.js';
import { calculateStudent } from '../shared/calculations.js';
import { hasActiveGrades } from '../shared/academic-policy.js';

const { makeCompactPdf } = createRequire(import.meta.url)('./compact-report-fixture.cjs') as { makeCompactPdf: (settings: AppState['settings'], options: { code: string; name: string; grade: string; grades?: string[]; gradesByArea?: Record<string,string[][]> }) => Buffer };

function reportPdf(code:string,name:string,omitArea='',grade='3',section='F',identityLayout:'inline'|'stacked'|'none'|'classroom'='inline',includeSupplemental=false) {
  const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[()\\]/g,'\\$&');
  const lines=identityLayout==='none' ? ['BIMESTRES I II III'] : identityLayout==='classroom' ? [`Grado: ${grade}`,`Seccion: ${section}`,'BIMESTRES I II III'] : identityLayout==='stacked'
    ? ['INFORME DE PROGRESO DEL ESTUDIANTE','Codigo modular: 1234567','Codigo del estudiante',code,'Apellidos y nombres del estudiante',name,'Grado',grade,'Seccion',section,'Periodo: 2026']
    : [`Codigo estudiante: ${code}`,`Estudiante: ${name}`,`Grado: ${grade}`,`Seccion: ${section}`,'Periodo: 2026'];
  for(const area of [...defaultSettings.areas,...(includeSupplemental?SUPPLEMENTAL_REPORT_AREAS:[])].filter(area=>area.id!==omitArea)){lines.push(area.name,...area.competencies.map(c=>`${c} A A A`));}
  const stream=`BT /F1 ${includeSupplemental?5:9} Tf 40 790 Td 12 TL ${lines.map((s,i)=>`${i?'T* ':''}(${normalize(s)}) Tj`).join('\n')} ET`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let text='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(text);
  text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(v=>`${String(v).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}

async function harness() {
  const dir=await mkdtemp(path.join(os.tmpdir(),'circulos-api-test-'));
  const app=createApp({dataDir:dir});
  const server:Server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const request=async(route:string,method='GET',body?:unknown)=>fetch(base+route,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const close=async(remove=true)=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));app.locals.store.close();if(remove)await rm(dir,{recursive:true,force:true});};
  return{dir,app,server,base,request,close};
}

type Harness = Awaited<ReturnType<typeof harness>>;
async function upload(h:Harness,bytes:Buffer,name='libreta.pdf') {
  const form=new FormData();form.append('files',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),name);
  const response=await fetch(h.base+'/api/pdfs',{method:'POST',body:form});
  assert.equal(response.status,201,await response.clone().text());
  return (await response.json()).pdfs[0] as AppState['pdfs'][number];
}
const readState=async(h:Harness)=>await(await h.request('/api/state')).json() as AppState;
async function confirm(h:Harness,pdfId:string,body:Record<string,unknown>={}) {
  const response=await h.request(`/api/pdfs/${pdfId}`,'PUT',{action:'validate',...body});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}

test('La libreta crea el expediente real, exige confirmación y autovalida solo I–III sin rellenar B/C',async()=>{
  const h=await harness();try{
    const initial=await readState(h);assert.equal(initial.students.length,0);assert.equal(initial.settings.workflowVersion,2);
    const pdf=await upload(h,reportPdf('REAL-1','Estudiante Real'));
    let state=await readState(h),student=state.students[0];
    assert.equal(student.code,'REAL-1');assert.equal(student.grade,'3.º de secundaria');assert.equal(student.section,'F');
    assert.equal(student.reportApproval,undefined);assert.equal(student.validated.academic,false);
    assert(student.academic.every(area=>area.grades.every(row=>row.length===3&&row.every(value=>value==='A'))));
    assert.deepEqual(student.attendance,{required:null,attended:null,punctual:null,exempted:null,validated:false});
    assert.deepEqual(student.discipline,{confirmed:false,incidents:[]});assert.deepEqual(student.institutional,[]);assert.deepEqual(student.family,[]);
    const forged={...student,reportApproval:{pdfId:pdf.id,approvedAt:new Date().toISOString()},attendance:{...student.attendance,required:200}};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',forged)).status,409);
    const form=new FormData();form.append('file',new Blob(['codigo,dias,eximidos,asistencias,puntuales\nREAL-1,200,10,180,170\n'],{type:'text/csv'}),'asistencia.csv');
    let response=await fetch(h.base+'/api/records/import',{method:'POST',body:form});assert.equal((await response.json()).updated,0);
    await confirm(h,pdf.id);
    state=await readState(h);student=state.students[0];assert.equal(student.reportApproval?.pdfId,pdf.id);
    assert.equal(student.validated.academic,true);assert(student.academic.every(area=>area.validated));
    assert.equal(student.validated.performance,false);assert.equal(student.validated.commitment,false);
    const imported=new FormData();imported.append('file',new Blob(['codigo,dias,eximidos,asistencias,puntuales\nREAL-1,200,10,180,170\nINEXISTENTE,200,0,190,180\n'],{type:'text/csv'}),'asistencia.csv');
    response=await fetch(h.base+'/api/records/import',{method:'POST',body:imported});const result=await response.json();assert.equal(result.updated,1);assert.equal(result.errors.length,1);
    student=(await readState(h)).students[0];assert.equal(student.attendance.exempted,10);
    response=await h.request(`/api/students/${student.id}`,'PUT',{...student,reportApproval:{pdfId:'inventado',approvedAt:'falso'},discipline:{confirmed:false,incidents:[{id:'draft',typeId:'',date:'',description:'',measure:'',evidence:'',verified:false}]}});
    assert.equal(response.status,200);student=await response.json() as Student;assert.equal(student.reportApproval?.pdfId,pdf.id);
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,name:'Identidad alterada'})).status,409);
    const invalid={...student,attendance:{...student.attendance,attended:201}};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',invalid)).status,400);
  }finally{await h.close();}
});

test('El PDF nativo con rótulos sin dos puntos reconoce automáticamente código propio, nombre y aula',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('00000000123456','PEREZ RAMOS Lucia Elena','','TERCERO','F','stacked'),'nombre_sin_identidad.pdf');
    assert.equal(pdf.extractedCode,'00000000123456');assert.notEqual(pdf.extractedCode,'1234567');
    assert.equal(pdf.extractedName,'PEREZ RAMOS Lucia Elena');assert.equal(pdf.extractedSection,'F');assert.equal(pdf.ocr,false);
    let state=await readState(h);assert.equal(state.students.length,1);assert.equal(state.students[0].grade,'3.º de secundaria');
    assert.equal(state.students[0].reportApproval,undefined);assert.equal(state.students[0].validated.academic,false);
    await confirm(h,pdf.id);
    state=await readState(h);assert.equal(state.students[0].reportApproval?.pdfId,pdf.id);assert.equal(state.students[0].validated.academic,true);
  }finally{await h.close();}
});

test('El nombre del archivo identifica la libreta antes de confirmar, sin código ni periodo extraído',async()=>{
  const h=await harness();try{
    const filename='BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf';
    const pdf=await upload(h,reportPdf('','','','3','F','none'),filename);
    assert.equal(pdf.name,filename);assert.equal(pdf.extractedName,'SEGURA CAMONES ANDRES ADRIAN');
    assert.equal(pdf.extractedCode,'');assert.equal(pdf.period,'');assert.equal(pdf.ocr,false);
    assert.equal(pdf.extractedGrade,'2.º de secundaria');assert.equal(pdf.extractedSection,'F');
    assert.equal(pdf.areas.flatMap(area=>area.grades).flat().length,45);
    let state=await readState(h),student=state.students[0];
    assert.equal(state.students.length,1);assert.equal(student.name,'SEGURA CAMONES ANDRES ADRIAN');
    assert.equal(student.grade,'2.º de secundaria');assert.equal(student.section,'F');assert(student.code);
    assert.equal(student.reportApproval,undefined);assert.equal(student.validated.academic,false);
    const studentId=student.id,internalCode=student.code;
    await confirm(h,pdf.id);
    state=await readState(h);student=state.students[0];
    assert.equal(student.id,studentId);assert.equal(student.code,internalCode);assert.equal(student.reportApproval?.pdfId,pdf.id);
    assert.equal(student.validated.academic,true);assert(student.academic.every(area=>area.grades.every(row=>row.length===3)));
    assert.deepEqual(student.attendance,{required:null,attended:null,punctual:null,exempted:null,validated:false});
    assert.deepEqual(student.discipline,{confirmed:false,incidents:[]});assert.deepEqual(student.institutional,[]);assert.deepEqual(student.family,[]);
  }finally{await h.close();}
});

test('El nombre del archivo prevalece sobre otro nombre leído dentro del PDF',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('TEXT-OTHER','Nombre Contradictorio','','4','F'),'BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf');
    assert.equal(pdf.extractedName,'SEGURA CAMONES ANDRES ADRIAN');assert.equal(pdf.ocr,false);
    assert.equal((await readState(h)).students[0].name,'SEGURA CAMONES ANDRES ADRIAN');
    await confirm(h,pdf.id);
    assert.equal((await readState(h)).students[0].name,'SEGURA CAMONES ANDRES ADRIAN');
  }finally{await h.close();}
});

test('Una libreta sin nombre permite confirmarlo manualmente sin exigir código ni año',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('','','','4','F','classroom'),'documento-sin-nombre.pdf');
    assert.equal(pdf.extractedName,'');assert.equal(pdf.extractedCode,'');assert.equal(pdf.period,'');assert.equal(pdf.ocr,false);
    assert.equal(pdf.studentId,null);assert.equal((await readState(h)).students.length,0);
    assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'validate'})).status,400);
    await confirm(h,pdf.id,{name:'APELLIDOS Y NOMBRES INGRESADOS'});
    const state=await readState(h),student=state.students[0];
    assert.equal(state.students.length,1);assert.equal(student.name,'APELLIDOS Y NOMBRES INGRESADOS');
    assert.equal(student.grade,'4.º de secundaria');assert.equal(student.section,'F');assert.equal(student.reportApproval?.pdfId,pdf.id);
    assert.equal(student.validated.academic,true);assert.equal(state.pdfs[0].extractedCode,'');assert.equal(state.pdfs[0].period,'');
  }finally{await h.close();}
});

test('Confirmar por nombre de archivo abre la ficha y mantiene A pendiente si faltan notas',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('','','matematica','3','F','none'),'BOLETA_3ro año F_Secundaria_RIVERA_SOTO_ALBA.pdf');
    assert.equal(pdf.extractedName,'RIVERA SOTO ALBA');assert.equal(pdf.extractedCode,'');assert.equal(pdf.period,'');
    const partial=await readState(h);partial.pdfs[0].areas.find(area=>area.areaId==='matematica')!.grades[0][0]='A';h.app.locals.store.save('real',partial);
    await confirm(h,pdf.id);
    const student=(await readState(h)).students[0];assert.equal(student.reportApproval?.pdfId,pdf.id);
    assert.equal(student.validated.academic,false);assert.equal(student.academic.find(area=>area.areaId==='matematica')!.validated,false);
    assert.equal(student.validated.performance,false);assert.equal(student.validated.commitment,false);
  }finally{await h.close();}
});

test('Los cursos totalmente vacíos se ignoran al confirmar, guardar la validación manual y actualizar notas',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('ACTIVE-ONLY','Estudiante Cursos Cursados','matematica'),pdf=await upload(h,bytes);
    let student=(await readState(h)).students[0];
    const forged={...student,reportApproval:{pdfId:pdf.id,approvedAt:new Date().toISOString()},validated:{...student.validated,academic:true}};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',forged)).status,409);
    await confirm(h,pdf.id);
    let state=await readState(h);student=state.students[0];
    assert.equal(student.validated.academic,true);assert.equal(student.academic.find(area=>area.areaId==='matematica')!.validated,false);
    assert.equal(calculateStudent(student,state.settings).a,75);
    const settings={...state.settings,areas:[...state.settings.areas,{id:'extra-empty',name:'Curso no estudiado',group:'other',eligible:true,competencies:['Competencia adicional']} ]};
    assert.equal((await h.request('/api/settings','PUT',settings)).status,200);
    state=await readState(h);student=state.students[0];
    const before=structuredClone(student.academic.map(area=>({areaId:area.areaId,grades:area.grades})));
    for(const area of student.academic)area.validated=hasActiveGrades(area);
    student.validated.academic=true;
    let response=await h.request(`/api/students/${student.id}`,'PUT',student);
    assert.equal(response.status,200,await response.clone().text());student=await response.json() as Student;
    assert.equal(student.validated.academic,true);assert(student.academic.filter(hasActiveGrades).every(area=>area.validated));
    assert(student.academic.filter(area=>!hasActiveGrades(area)).every(area=>!area.validated));
    assert.deepEqual(student.academic.map(area=>({areaId:area.areaId,grades:area.grades})),before);
    response=await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'rescan-grades'});assert.equal(response.status,200,await response.clone().text());
    state=await readState(h);student=state.students[0];assert.equal(student.validated.academic,true);
    assert.equal(student.academic.find(area=>area.areaId==='extra-empty')!.validated,false);
    assert.equal(calculateStudent(student,state.settings).a,75);
    assert.deepEqual(Buffer.from(await(await h.request(`/api/pdfs/${pdf.id}/file`)).arrayBuffer()),bytes);
    state.students[0].academic.find(area=>area.areaId==='extra-empty')!.validated=true;h.app.locals.store.save('real',state);
    student=(await readState(h)).students[0];assert.equal(student.academic.find(area=>area.areaId==='extra-empty')!.validated,false,'Una validación histórica vacía se normaliza sin perder notas ni bloquear A.');
    student.academic.find(area=>area.areaId==='comunicacion')!.grades[0][1]='';student.validated.academic=false;
    student.academic.find(area=>area.areaId==='comunicacion')!.validated=false;
    state=await readState(h);state.students[0]=student;h.app.locals.store.save('real',state);
    const finalOnly={...student,validated:{...student.validated,academic:true}};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',finalOnly)).status,400,'Un curso con notas parciales impide la validación final.');
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,academic:student.academic.map(area=>({...area,validated:hasActiveGrades(area)}))})).status,400,'Las notas parciales tampoco permiten validar el curso.');
  }finally{await h.close();}
});

test('Indaga vacía en 4.º F y 5.º F admite validación manual, conserva el blanco y calcula con las competencias cursadas',async()=>{
  const h=await harness();try{
    const science=defaultSettings.areas.find(area=>area.group==='science')!,indaga=science.competencies.findIndex(label=>/^Indaga\b/i.test(label));assert(indaga>=0);
    for(const grade of ['4','5']){
      const code=`INDAGA-${grade}-F`,name=`ESTUDIANTE INDAGA ${grade==='4'?'CUARTO':'QUINTO'}`,rows=science.competencies.map((_,index)=>index===indaga?['','','']:['A','A','A']);
      const bytes=makeCompactPdf(defaultSettings,{code,name,grade,grades:['A','A','A'],gradesByArea:{[science.id]:rows}});
      const pdf=await upload(h,bytes,`BOLETA_${grade}to año F_Secundaria_${name.replaceAll(' ','_')}.pdf`);
      assert.deepEqual(pdf.areas.find(area=>area.areaId===science.id)!.grades[indaga],['','','']);
      await confirm(h,pdf.id);
      let state=await readState(h),student=state.students.find(value=>value.code===code)!;
      assert.equal(student.grade,`${grade}.º de secundaria`);assert.equal(student.academic.find(area=>area.areaId===science.id)!.validated,false,'Confirmar la libreta no sustituye la revisión manual de Indaga no cursada.');
      assert.equal(student.validated.academic,false);
      const before=structuredClone(student.academic.map(area=>({areaId:area.areaId,grades:area.grades}))),provisional=calculateStudent(student,state.settings);
      assert.equal(provisional.areaAverages[science.id],3);assert.equal(provisional.a,75);assert(provisional.pa<100);
      student.academic.find(area=>area.areaId===science.id)!.validated=true;student.validated.academic=true;
      const response=await h.request(`/api/students/${student.id}`,'PUT',student);
      assert.equal(response.status,200,await response.clone().text());student=await response.json() as Student;
      assert.equal(student.validated.academic,true);assert.equal(calculateStudent(student,state.settings).pa,100);assert.equal(calculateStudent(student,state.settings).a,75);
      assert.deepEqual(student.academic.map(area=>({areaId:area.areaId,grades:area.grades})),before);
      state=await readState(h);student=state.students.find(value=>value.code===code)!;
      assert.equal(student.academic.find(area=>area.areaId===science.id)!.validated,true);assert.equal(student.validated.academic,true);
      assert.deepEqual(state.pdfs.find(value=>value.id===pdf.id)!.areas.find(area=>area.areaId===science.id)!.grades[indaga],['','','']);
      assert.deepEqual(Buffer.from(await(await h.request(`/api/pdfs/${pdf.id}/file`)).arrayBuffer()),bytes);
    }
    for(const [grade,mode] of [['2','blank'],['3','blank'],['4','partial-indaga'],['5','missing-other']] as const){
      const rows=science.competencies.map((_,index)=>index===indaga?(mode==='partial-indaga'?['A','','']:['','','']):['A','A','A']);
      if(mode==='missing-other')rows[(indaga+1)%rows.length][1]='';
      const pdf=await upload(h,makeCompactPdf(defaultSettings,{code:`STRICT-${grade}`,name:'ESTUDIANTE ESTRICTO PRUEBA',grade,grades:['A','A','A'],gradesByArea:{[science.id]:rows}}));
      assert.deepEqual(pdf.areas.find(area=>area.areaId===science.id)!.grades,rows,`La libreta conserva los vacíos de ${grade} ${mode}`);
      await confirm(h,pdf.id);
      const student=(await readState(h)).students.find(value=>value.code===`STRICT-${grade}`)!;
      student.academic.find(area=>area.areaId===science.id)!.validated=true;
      const response=await h.request(`/api/students/${student.id}`,'PUT',student);
      assert.equal(response.status,400,`Se rechaza la validación con notas obligatorias faltantes: ${grade} ${mode}`);
    }
  }finally{await h.close();}
});

test('Una incidencia se verifica con categoría, fecha y descripción; medida y evidencia son opcionales',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('INC-MIN','Estudiante Incidencias'));await confirm(h,pdf.id);
    let state=await readState(h),student=state.students[0];
    const category=state.settings.disciplineTypes.find(type=>!type.punctuality&&type.discount===null)!;assert(category);
    const incident={id:'minimal-incident',typeId:category.id,date:'2026-10-18',description:'Descripción de la incidencia',verified:true};
    let response=await h.request(`/api/students/${student.id}`,'PUT',{...student,discipline:{confirmed:true,incidents:[incident]}});
    assert.equal(response.status,200,await response.clone().text());student=await response.json() as Student;
    assert.equal(student.discipline.incidents[0].verified,true);assert.equal(student.discipline.incidents[0].measure,'');assert.equal(student.discipline.incidents[0].evidence,'');
    state=await readState(h);assert.equal(state.settings.criteriaApproved,false);assert.equal(state.settings.disciplineTypes.find(type=>type.id===category.id)!.discount,null);
    assert.equal(calculateStudent(student,state.settings).discipline,null,'Verificar el registro no aprueba el descuento pendiente.');
    for(const invalid of [{...incident,typeId:''},{...incident,typeId:'unknown'},{...incident,date:''},{...incident,date:'2026-02-30'},{...incident,description:'  '}]){
      response=await h.request(`/api/students/${student.id}`,'PUT',{...student,discipline:{confirmed:true,incidents:[invalid]}});
      assert.equal(response.status,400,`Incidencia sin datos mínimos: ${JSON.stringify(invalid)}`);
    }
  }finally{await h.close();}
});

test('La familia valida nombre, fecha y estado sin exigir evidencia, observación ni condición exigible',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('FAM-MIN','Estudiante Familia'));await confirm(h,pdf.id);
    let student=(await readState(h)).students[0];
    for(const status of ['fulfilled','missed','justified','na'] as const){
      const family={id:`family-${status}`,name:'Reunión de familias',date:'2026-10-18',status,validated:true};
      const response=await h.request(`/api/students/${student.id}`,'PUT',{...student,family:[family]});
      assert.equal(response.status,200,await response.clone().text());student=await response.json() as Student;
      assert.equal(student.family[0].validated,true);assert.equal(student.family[0].status,status);assert.equal(student.family[0].required,true);
      assert.equal(student.family[0].evidence,'');assert.equal(student.family[0].justification,'');
    }
    const valid=student.family[0];
    for(const invalid of [{...valid,name:''},{...valid,date:''},{...valid,date:'2026-02-30'},{...valid,status:'pending'}]){
      assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,family:[invalid]})).status,400,`Compromiso sin datos mínimos: ${JSON.stringify(invalid)}`);
    }
  }finally{await h.close();}
});

test('Reprocesar libretas antiguas sin identidad usa el original y conserva id, hash y confirmación pendiente',async()=>{
  const h=await harness();try{
    for(const status of ['review','failed'] as const){
      const code=`REC-${status}`,bytes=reportPdf(code,`Estudiante Recuperado ${status}`,'','4','F','stacked');
      const uploaded=await upload(h,bytes,`original_${status}.pdf`);
      const stale=await readState(h),pdf=stale.pdfs.find(value=>value.id===uploaded.id)!;
      stale.students=stale.students.filter(student=>student.id!==pdf.studentId);
      Object.assign(pdf,{status,studentId:null,extractedCode:'',extractedName:'',extractedGrade:'',extractedSection:'',text:'',areas:[],warnings:['Lectura antigua incompleta']});
      delete pdf.confirmedIdentity;h.app.locals.store.save('real',stale);
      const response=await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'reprocess'});
      assert.equal(response.status,200,await response.clone().text());
      const recovered=await response.json() as AppState['pdfs'][number];
      assert.equal(recovered.id,uploaded.id);assert.equal(recovered.hash,uploaded.hash);assert.equal(recovered.size,uploaded.size);assert.equal(recovered.uploadedAt,uploaded.uploadedAt);
      assert.equal(recovered.extractedCode,code);assert.equal(recovered.extractedName,`Estudiante Recuperado ${status}`);assert.equal(recovered.status,'review');
      assert.deepEqual(Buffer.from(await(await h.request(`/api/pdfs/${pdf.id}/file`)).arrayBuffer()),bytes);
      let state=await readState(h),student=state.students.find(value=>value.id===recovered.studentId)!;
      assert(student);assert.equal(student.reportApproval,undefined);assert.equal(student.validated.academic,false);
      assert(student.academic.every(area=>!area.validated&&area.grades.every(row=>row.join(',')==='A,A,A')));
      assert.deepEqual(student.attendance,{required:null,attended:null,punctual:null,exempted:null,validated:false});
      await confirm(h,pdf.id);state=await readState(h);student=state.students.find(value=>value.id===recovered.studentId)!;
      assert.equal(student.reportApproval?.pdfId,pdf.id);assert.equal(student.validated.academic,true);
      assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'reprocess'})).status,409,'Una libreta ya confirmada no se vuelve a aplicar al revisar.');
    }
    const backup=await(await h.request('/api/backup')).json();assert.equal(backup.state.pdfs.length,2);assert.equal(backup.files.length,2);
  }finally{await h.close();}
});

test('Reprocesar una libreta enlazada conserva el expediente y B/C manuales hasta confirmar A',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('REC-MANUAL','Estudiante Con Registros'),pdf=await upload(h,bytes);await confirm(h,pdf.id);
    let state=await readState(h),student=state.students[0];
    student.attendance={required:200,exempted:10,attended:180,punctual:170,validated:true};student.discipline={confirmed:true,incidents:[]};
    student.institutional=[{id:'contest',name:'Olimpiada',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Acta',validated:true,placement:'Segundo puesto',representingSchool:true}];
    student.family=[{id:'meeting',name:'Reunión',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Firma',validated:true}];
    let response=await h.request(`/api/students/${student.id}`,'PUT',student);assert.equal(response.status,200);student=await response.json() as Student;
    const manual={attendance:student.attendance,discipline:student.discipline,institutional:student.institutional,family:student.family};
    state=await readState(h);student=state.students[0];const legacy=state.pdfs[0];
    Object.assign(legacy,{status:'review',extractedCode:'',extractedName:'',extractedGrade:'',extractedSection:'',text:'',areas:[]});delete legacy.confirmedIdentity;
    delete student.reportApproval;student.validated.academic=false;student.academic.forEach(area=>{area.validated=false;});
    h.app.locals.store.save('real',state);
    response=await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'reprocess'});assert.equal(response.status,200,await response.clone().text());
    const recovered=await response.json() as AppState['pdfs'][number];state=await readState(h);const pending=state.students[0];
    assert.equal(state.students.length,1);assert.equal(pending.id,student.id);assert.equal(recovered.studentId,student.id);assert.equal(recovered.hash,pdf.hash);
    assert.equal(pending.reportApproval,undefined);assert.equal(pending.validated.academic,false);assert(pending.academic.every(area=>!area.validated));
    assert.deepEqual({attendance:pending.attendance,discipline:pending.discipline,institutional:pending.institutional,family:pending.family},manual);
    assert.deepEqual(Buffer.from(await(await h.request(`/api/pdfs/${pdf.id}/file`)).arrayBuffer()),bytes);
    await confirm(h,pdf.id);state=await readState(h);const confirmed=state.students[0];
    assert.equal(confirmed.id,student.id);assert.equal(confirmed.reportApproval?.pdfId,pdf.id);assert.equal(confirmed.validated.academic,true);
    assert.deepEqual({attendance:confirmed.attendance,discipline:confirmed.discipline,institutional:confirmed.institutional,family:confirmed.family},manual);
  }finally{await h.close();}
});

test('Un concurso académico se valida con tipo, fecha y ubicación y conserva opcionales vacíos',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('CONCURSO-3','Estudiante Concursos'));await confirm(h,pdf.id);
    let student=(await readState(h)).students[0];
    for(const scope of ['local','regional','national'] as const){
      const record={id:`contest-${scope}`,eventType:'academic_contest',scope,date:'2026-10-18',placement:'Segundo puesto',validated:true};
      const response=await h.request(`/api/students/${student.id}`,'PUT',{...student,institutional:[record]});
      assert.equal(response.status,200,await response.clone().text());student=await response.json() as Student;
      const saved=student.institutional[0];
      assert.equal(saved.eventType,'academic_contest');assert.equal(saved.scope,scope);assert.equal(saved.validated,true);
      assert.equal(saved.name,'');assert.equal(saved.evidence,'');assert.equal(saved.justification,'');assert.equal(saved.required,false);assert.equal(saved.status,'pending');
    }
    assert.deepEqual((await readState(h)).settings.activityTypes,['CONCURSOS ACADÉMICOS']);
    const valid=student.institutional[0];
    for(const invalid of [{...valid,scope:undefined},{...valid,scope:'international'},{...valid,eventType:'sports'},{...valid,date:''},{...valid,date:'2026-02-30'},{...valid,placement:'   '},{...valid,placement:'x'.repeat(2001)}]){
      const response=await h.request(`/api/students/${student.id}`,'PUT',{...student,institutional:[invalid]});
      assert.equal(response.status,400,`Debe impedir el concurso inválido: ${JSON.stringify(invalid)}`);
    }
    const family={...valid,id:'family',name:'',evidence:'',justification:'',required:false,status:'pending'};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,family:[family]})).status,400,'Las obligaciones familiares requieren nombre, fecha y estado.');
    const legacy={...family,id:'legacy',eventType:undefined,scope:undefined};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,institutional:[legacy]})).status,400,'Los registros antiguos conservan sus reglas hasta su clasificación.');
    const settings=(await readState(h)).settings;
    settings.cohortRecords=[{id:'old-common',kind:'institutional',name:'Convocatoria anterior',date:'2026-10-10',grade:'3.º de secundaria',section:'F',required:true}];
    assert.equal((await h.request('/api/settings','PUT',settings)).status,200);student=(await readState(h)).students[0];
    const classified={...valid,catalogId:'old-common',name:'',date:'2026-10-19',required:false};
    const response=await h.request(`/api/students/${student.id}`,'PUT',{...student,institutional:[classified]});
    assert.equal(response.status,200,await response.clone().text());
    const saved=await response.json() as Student;assert.equal(saved.institutional[0].date,'2026-10-19');assert.equal(saved.institutional[0].name,'');assert.equal(saved.institutional[0].catalogId,'old-common');
  }finally{await h.close();}
});

test('Actualizar las notas de una libreta confirmada rescata A y conserva identidad, aprobación, B/C e historial',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('RESCAN-1','Nombre Dentro Del Documento');
    const pdf=await upload(h,bytes,'BOLETA_3ro año F_Secundaria_NOMBRE_DEL_ARCHIVO.pdf');
    await confirm(h,pdf.id,{name:'APELLIDOS CORREGIDOS MANUALMENTE'});
    let state=await readState(h),student=state.students[0];
    student.attendance={required:200,exempted:10,attended:180,punctual:170,validated:true};student.discipline={confirmed:true,incidents:[]};
    student.institutional=[{id:'contest',eventType:'academic_contest',scope:'regional',name:'',date:'2026-10-10',required:false,status:'pending',justification:'',evidence:'',validated:true,placement:'Segundo puesto'}];
    student.family=[{id:'meeting',name:'Reunión',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Firma',validated:true}];
    student.validated.performance=true;student.validated.commitment=true;
    student.academic.forEach(area=>{area.validated=false;area.grades.forEach(row=>row.fill(''));});
    student.academic[0].grades[0][0]='AD';student.validated.academic=false;
    state.pdfs[0].areas.forEach(area=>{area.validated=false;area.grades.forEach(row=>row.fill(''));});
    h.app.locals.store.save('real',state);
    const preserved=structuredClone({id:student.id,code:student.code,name:student.name,grade:student.grade,section:student.section,attendance:student.attendance,discipline:student.discipline,institutional:student.institutional,family:student.family,reportApproval:student.reportApproval,performance:student.validated.performance,commitment:student.validated.commitment,history:student.history});
    const beforePdf=structuredClone(state.pdfs[0]);
    const store=h.app.locals.store,originalRead=store.read.bind(store);let reads=0;
    const concurrentHistory={id:'other-tab-edit',date:new Date().toISOString(),field:'attendance',before:'170',after:'168'};
    store.read=(dataset:'real'|'demo')=>{
      const latest=originalRead(dataset) as AppState;
      if(dataset==='real'&&++reads===2){latest.students[0].attendance.punctual=168;latest.students[0].history.push(concurrentHistory);store.save(dataset,latest);}
      return latest;
    };
    let response:Response;
    try{response=await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'rescan-grades'});}finally{store.read=originalRead;}
    preserved.attendance.punctual=168;preserved.history.push(concurrentHistory);
    assert.equal(response.status,200,await response.clone().text());
    const updated=await response.json() as AppState['pdfs'][number];state=await readState(h);student=state.students[0];
    assert.equal(updated.id,pdf.id);assert.equal(updated.hash,pdf.hash);assert.equal(updated.size,pdf.size);assert.equal(updated.uploadedAt,pdf.uploadedAt);assert.equal(updated.status,'validated');
    assert.equal(updated.manualName,beforePdf.manualName);assert.deepEqual(updated.confirmedIdentity,beforePdf.confirmedIdentity);assert.equal(updated.studentId,student.id);
    assert.deepEqual({id:student.id,code:student.code,name:student.name,grade:student.grade,section:student.section,attendance:student.attendance,discipline:student.discipline,institutional:student.institutional,family:student.family,reportApproval:student.reportApproval,performance:student.validated.performance,commitment:student.validated.commitment,history:student.history.slice(0,preserved.history.length)},preserved);
    assert.equal(student.validated.academic,true);assert(student.academic.every(area=>area.validated&&area.grades.every(row=>row.length===3&&row.every(value=>value==='A'))));
    assert.equal(student.history.at(-1)?.field,'Actualización automática de notas desde el PDF original');
    assert.deepEqual(Buffer.from(await(await h.request(`/api/pdfs/${pdf.id}/file`)).arrayBuffer()),bytes);
    for(const status of ['duplicate','replaced','failed'] as const){
      state=await readState(h);state.pdfs[0].status=status;delete state.students[0].reportApproval;h.app.locals.store.save('real',state);
      assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'rescan-grades'})).status,409);
    }
  }finally{await h.close();}
});

test('Las asignaturas adicionales sobreviven a actualizar notas y restaurar sin cambiar las cinco áreas evaluables',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('ALL-NOTES-1','Estudiante Todas Las Notas','','3','F','inline',true),pdf=await upload(h,bytes);await confirm(h,pdf.id);
    const first=await readState(h),scoringAreas=structuredClone(first.settings.areas);
    assert.equal(first.pdfs[0].supplementalAreas?.length,5);
    assert.equal(first.pdfs[0].supplementalAreas?.flatMap(area=>area.grades).flat().length,33);
    assert(first.pdfs[0].supplementalAreas?.every(area=>area.grades.every(row=>row.every(value=>value==='A'))));
    assert.equal(first.students[0].academic.length,5);assert.equal(first.students[0].validated.academic,true);
    const response=await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'rescan-grades'});assert.equal(response.status,200,await response.clone().text());
    const updated=await response.json() as AppState['pdfs'][number];assert.deepEqual(updated.supplementalAreas,first.pdfs[0].supplementalAreas);
    const backup=await(await h.request('/api/backup')).json();assert.equal(backup.state.pdfs[0].supplementalAreas.length,5);
    assert.equal((await h.request('/api/restore','POST',backup)).status,200);
    const restored=await readState(h);assert.deepEqual(restored.pdfs[0].supplementalAreas,updated.supplementalAreas);assert.deepEqual(restored.settings.areas,scoringAreas);assert.equal(restored.students[0].academic.length,5);
  }finally{await h.close();}
});

test('Una nueva lectura parcial conserva notas del mismo original y descarta ajustes manuales de A',async()=>{
  const h=await harness();try{
    const uploaded=await upload(h,reportPdf('PARTIAL-1','Estudiante Lectura Parcial','','3','F','inline',true));await confirm(h,uploaded.id);
    const state=await readState(h),pdf=state.pdfs[0],student=state.students[0],scoringAreas=structuredClone(state.settings.areas);
    const reading:ExtractedReport={extractedCode:pdf.extractedCode,extractedName:pdf.extractedName,extractedGrade:pdf.extractedGrade,extractedSection:pdf.extractedSection,period:pdf.period,text:pdf.text,ocr:false,warnings:[],areas:structuredClone(pdf.areas),supplementalAreas:structuredClone(pdf.supplementalAreas)};
    student.academic[0].grades[0][0]='AD';student.academic[0].grades[0].push('B');
    reading.areas[0].grades[0][0]='';reading.areas[0].grades[0][1]='B';pdf.areas[1].grades[0].push('C');pdf.ocr=true;
    const extra=reading.supplementalAreas![0];extra.definition.competencies.reverse();extra.grades=extra.definition.competencies.map(()=>['','','']);extra.grades[0][1]='B';
    applyRescannedGrades(state,pdf.id,reading);
    assert.deepEqual(student.academic[0].grades[0],['A','B','A','B']);assert.equal(student.validated.academic,true);assert.equal(pdf.ocr,true);
    assert.equal(pdf.areas[1].grades[0][3],'C');assert.equal(student.academic[1].grades[0][3],'C','Actualizar I–III conserva la cuarta nota histórica en fuente y expediente.');
    assert.deepEqual(pdf.supplementalAreas![0].grades[0],['A','B','A']);assert(pdf.supplementalAreas!.every(area=>area.grades.every(row=>row.every(Boolean))),JSON.stringify(pdf.supplementalAreas));
    assert.deepEqual(state.settings.areas,scoringAreas);assert.equal(student.academic.length,5);
  }finally{await h.close();}
});

test('Las aulas ajenas permanecen en revisión; el código ausente no bloquea una identidad y aula reconocidas',async()=>{
  const h=await harness();try{
    for(const [grade,section] of [['1','F'],['6','F'],['12','F'],['25','F'],['3xyz','F'],['3','A']]){
      assert.equal((await h.request('/api/students','POST',{code:`BAD-${grade}-${section}`,name:'No permitido',grade,section})).status,400);
    }
    const pdf=await upload(h,reportPdf('COR-1','Identidad Leida','','3','A'),'fuera_de_aula.pdf');
    assert.equal(pdf.studentId,null);assert.equal((await readState(h)).students.length,0);
    assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'PUT',{action:'validate'})).status,400);
    await confirm(h,pdf.id,{identity:{code:'COR-1',name:'Identidad Corregida',grade:'tercero de secundaria',section:'f'}});
    const state=await readState(h);assert.equal(state.students.length,1);assert.equal(state.students[0].name,'Identidad Corregida');
    assert.equal(state.students[0].grade,'3.º de secundaria');assert.equal(state.pdfs[0].extractedName,'Identidad Leida');assert.equal(state.pdfs[0].extractedSection,'A');
    assert.equal(state.pdfs[0].confirmedIdentity?.section,'F');assert.equal(state.students[0].reportApproval?.pdfId,pdf.id);
    const missing=await upload(h,reportPdf('','Sin Codigo','','4','F'),'sin_codigo.pdf');
    assert(missing.studentId);assert.equal(missing.extractedCode,'');assert.equal((await readState(h)).students.length,2);
    await confirm(h,missing.id,{name:'Sin Codigo Corregido'});
    assert.equal((await readState(h)).students.length,2);
    assert.equal((await readState(h)).students.find(student=>student.id===missing.studentId)!.name,'Sin Codigo Corregido');
  }finally{await h.close();}
});

test('Reconfirmar identidad conserva ajustes académicos; reemplazar reinicia A y aprobación y conserva B/C manuales',async()=>{
  const h=await harness();try{
    const prior=await upload(h,reportPdf('REPL-1','Estudiante Reemplazo'),'original.pdf');await confirm(h,prior.id);
    let student=(await readState(h)).students[0];
    student.academic[0].grades[0][0]='AD';
    student.attendance={required:200,exempted:10,attended:180,punctual:170,validated:true};
    student.discipline={confirmed:true,incidents:[]};
    student.institutional=[{id:'contest',name:'Olimpiada',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Acta',validated:true,placement:'Segundo puesto',representingSchool:true}];
    student.family=[{id:'meeting',name:'Reunión',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Firma',validated:true}];
    let response=await h.request(`/api/students/${student.id}`,'PUT',student);assert.equal(response.status,200);student=await response.json() as Student;
    assert.equal(student.academic[0].validated,false);assert.equal(student.validated.academic,false);
    await confirm(h,prior.id,{identity:{code:student.code,name:'Estudiante Corregido',grade:student.grade,section:student.section}});
    student=(await readState(h)).students[0];assert.equal(student.academic[0].grades[0][0],'AD');assert.equal(student.academic[0].validated,false);assert.equal(student.validated.academic,false);
    const manual={attendance:student.attendance,discipline:student.discipline,institutional:student.institutional,family:student.family};
    const replacement=await upload(h,reportPdf('REPL-1','Estudiante Corregido','matematica'),'nueva.pdf');
    let state=await readState(h);student=state.students[0];
    assert.equal(student.reportApproval,undefined);assert.equal(student.validated.academic,false);
    assert(student.academic.find(area=>area.areaId==='matematica')!.grades.every(row=>row.every(value=>value==='')));
    assert.equal(student.academic.find(area=>area.areaId==='ciencia')!.grades[0][0],'A');
    assert.deepEqual({attendance:student.attendance,discipline:student.discipline,institutional:student.institutional,family:student.family},manual);
    assert.equal(state.pdfs.find(pdf=>pdf.id===prior.id)!.status,'replaced');
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',{...student,discipline:{...student.discipline,confirmed:false}})).status,409);
    assert.equal((await h.request(`/api/pdfs/${prior.id}`,'PUT',{action:'validate'})).status,400);
    response=await h.request(`/api/pdfs/${replacement.id}`,'PUT',{action:'replace',studentId:student.id,replacesId:prior.id});assert.equal(response.status,200);
    await confirm(h,replacement.id);state=await readState(h);student=state.students[0];
    assert.equal(student.reportApproval?.pdfId,replacement.id);assert.equal(student.validated.academic,true);
    assert.equal(student.academic.find(area=>area.areaId==='matematica')!.validated,false);assert.equal(student.academic.find(area=>area.areaId==='ciencia')!.validated,true);
    assert.deepEqual(student.institutional,manual.institutional);assert.deepEqual(student.family,manual.family);
    assert.equal((await h.request(`/api/pdfs/${prior.id}/file`)).status,200);
  }finally{await h.close();}
});

test('Eliminar libreta borra expediente, todas las versiones y copias, permite reimportar y nunca busca por texto',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('DEL-1','Estudiante Eliminable');
    const original=await upload(h,bytes,'original.pdf');await confirm(h,original.id);
    const other=await upload(h,reportPdf('SAFE-1','Estudiante Conservado'),'otro.pdf');await confirm(h,other.id);
    const copy=await upload(h,bytes,'copia.pdf');assert.equal(copy.status,'duplicate');
    const replacement=await upload(h,reportPdf('DEL-1','Estudiante Eliminable','matematica'),'version.pdf');
    let state=await readState(h);const deletedStudentId=state.students.find(student=>student.code==='DEL-1')!.id;
    assert.equal(state.pdfs.length,4);assert.equal((await(await h.request('/api/backup')).json()).files.length,4);
    const response=await h.request(`/api/pdfs/${copy.id}`,'DELETE');assert.equal(response.status,200);
    const deletion=await response.json();assert.equal(deletion.studentId,deletedStudentId);assert.deepEqual(new Set(deletion.deletedPdfIds),new Set([original.id,copy.id,replacement.id]));
    state=await readState(h);assert.equal(state.students.length,1);assert.equal(state.students[0].code,'SAFE-1');assert.equal(state.pdfs.length,1);
    for(const id of deletion.deletedPdfIds)assert.equal((await h.request(`/api/pdfs/${id}/file`)).status,404);
    assert.equal((await(await h.request('/api/backup')).json()).files.length,1);
    const again=await upload(h,bytes,'reimportada.pdf');assert.equal(again.status,'review');assert(again.studentId);assert.notEqual(again.studentId,deletedStudentId);
    const unlinked=await upload(h,reportPdf('SAFE-1','Estudiante Conservado','','3','A'),'sin_vinculo.pdf');assert.equal(unlinked.studentId,null);
    assert.equal((await h.request(`/api/pdfs/${unlinked.id}`,'DELETE')).status,200);
    state=await readState(h);assert.equal(state.students.length,2);assert(state.students.some(student=>student.code==='SAFE-1'));
  }finally{await h.close();}
});

test('La eliminación de originales y del estado comparte una transacción atómica',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('ATOMIC-1','Estudiante Atomico'));
    const store=h.app.locals.store,save=store.save;
    store.save=()=>{throw new Error('Fallo de persistencia simulado');};
    try{assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'DELETE')).status,500);}finally{store.save=save;}
    assert.equal((await readState(h)).students.length,1);assert.equal((await readState(h)).pdfs.length,1);
    assert.equal((await h.request(`/api/pdfs/${pdf.id}/file`)).status,200);
    assert.equal((await(await h.request('/api/backup')).json()).files.length,1);
  }finally{await h.close();}
});

test('Eliminar una copia antigua no elimina el original reasignado y aprobado de otro estudiante',async()=>{
  const h=await harness();try{
    const source=await upload(h,reportPdf('OWNER-A','Estudiante Origen'),'origen.pdf');await confirm(h,source.id);
    const duplicate=await upload(h,reportPdf('OWNER-A','Estudiante Origen'),'copia_origen.pdf');assert.equal(duplicate.status,'duplicate');
    const other=await upload(h,reportPdf('OWNER-B','Estudiante Destino'),'destino.pdf');await confirm(h,other.id);
    const before=await readState(h),target=before.students.find(student=>student.code==='OWNER-B')!;
    const identity={code:target.code,name:target.name,grade:target.grade,section:target.section};
    assert.equal((await h.request(`/api/pdfs/${source.id}`,'PUT',{action:'validate',identity})).status,409);
    await confirm(h,source.id,{identity,confirmMismatch:true});
    const response=await h.request(`/api/pdfs/${duplicate.id}`,'DELETE');assert.equal(response.status,200);
    const deletion=await response.json();assert.deepEqual(deletion.deletedPdfIds,[duplicate.id]);
    const after=await readState(h);assert.equal(after.students.length,1);assert.equal(after.students[0].id,target.id);
    assert.equal(after.students[0].reportApproval?.pdfId,source.id);assert.equal(after.pdfs.find(pdf=>pdf.id===source.id)?.status,'validated');
    assert.equal((await h.request(`/api/pdfs/${source.id}/file`)).status,200);assert.equal((await h.request(`/api/pdfs/${other.id}/file`)).status,200);
    assert.equal((await(await h.request('/api/backup')).json()).files.length,2);
  }finally{await h.close();}
});

test('Corregir aula en la libreta desvincula solo la pauta no aplicable y conserva los datos manuales',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('COHORT-1','Estudiante Cambio'));await confirm(h,pdf.id);
    const state=await readState(h),settings={...state.settings,cohortRecords:[
      {id:'only-third',kind:'institutional',name:'Concurso de Tercero',date:'2026-10-10',grade:'3.º de secundaria',section:'F',required:true},
      {id:'all-families',kind:'family',name:'Reunión de Familias',date:'2026-10-10',grade:'',section:'F',required:true},
    ]};
    assert.equal((await h.request('/api/settings','PUT',settings)).status,200);
    let student=(await readState(h)).students[0];
    student.institutional=[{id:'manual-contest',catalogId:'only-third',name:'Concurso de Tercero',date:'2026-10-10',required:true,status:'fulfilled',justification:'Anotación manual',evidence:'Acta manual',validated:true,placement:'Segundo puesto',representingSchool:true}];
    student.family=[{id:'manual-family',catalogId:'all-families',name:'Reunión de Familias',date:'2026-10-10',required:true,status:'fulfilled',justification:'Firma presencial',evidence:'Lista firmada',validated:true}];
    let response=await h.request(`/api/students/${student.id}`,'PUT',student);assert.equal(response.status,200);student=await response.json() as Student;
    response=await h.request(`/api/students/${student.id}`,'PUT',{...student,validated:{...student.validated,commitment:true}});assert.equal(response.status,200);student=await response.json() as Student;
    const priorContest=structuredClone(student.institutional[0]),priorFamily=structuredClone(student.family[0]);
    await confirm(h,pdf.id,{identity:{code:student.code,name:student.name,grade:'4',section:'F'}});
    student=(await readState(h)).students[0];assert.equal(student.grade,'4.º de secundaria');assert.equal(student.validated.commitment,false);
    const {catalogId:_,validated:__,...manualBefore}=priorContest;
    const {catalogId:removed,validated:reviewed,...manualAfter}=student.institutional[0];
    assert.equal(removed,undefined);assert.equal(reviewed,false);assert.deepEqual(manualAfter,manualBefore);
    assert.deepEqual(student.family[0],priorFamily);assert(student.history.some(entry=>entry.field==='Desvinculación de pauta tras confirmar identidad'));
    assert.equal(student.reportApproval?.pdfId,pdf.id);assert.equal((await readState(h)).pdfs[0].extractedGrade,'3');
  }finally{await h.close();}
});

test('Respaldo: integridad, referencias, migración de cuatro periodos y persistencia tras reinicio',async()=>{
  const h=await harness();let closed=false;try{
    const pdf=await upload(h,reportPdf('BACK-1','Estudiante Respaldo'));await confirm(h,pdf.id);
    const backup=await(await h.request('/api/backup')).json();
    const corrupted=structuredClone(backup);corrupted.files[0].content=Buffer.from('alterado').toString('base64');
    assert.equal((await h.request('/api/restore','POST',corrupted)).status,400);
    const badReference=structuredClone(backup);badReference.state.students[0].pdfIds=[];
    assert.equal((await h.request('/api/restore','POST',badReference)).status,400);
    const malformed=structuredClone(backup);malformed.state.students[0].academic[0].grades[0][0]='E';
    assert.throws(()=>h.app.locals.store.save('real',malformed.state));assert.equal((await h.request('/api/restore','POST',malformed)).status,400);
    assert.equal((await h.request('/api/restore','POST',{...backup,dataset:'demo'})).status,400);
    assert.equal((await h.request('/api/restore','POST',backup)).status,200);
    const legacy=structuredClone(backup);delete legacy.state.settings.workflowVersion;delete legacy.state.settings.progressionComparison;
    legacy.state.settings.criteriaApproved=true;legacy.state.settings.closed=true;delete legacy.state.students[0].reportApproval;
    for(const area of legacy.state.students[0].academic)for(const row of area.grades)row.push('C');
    assert.equal((await h.request('/api/restore','POST',legacy)).status,200);
    const migrated=await readState(h);assert.equal(migrated.settings.workflowVersion,2);assert.equal(migrated.settings.criteriaApproved,false);assert.equal(migrated.settings.closed,false);
    assert.equal(migrated.students[0].validated.academic,false);assert.equal(migrated.students[0].reportApproval?.pdfId,pdf.id);
    assert.equal(migrated.students[0].academic[0].grades[0][3],'C','La cuarta nota histórica se conserva sin evaluarse');
    await h.close(false);closed=true;
    const reopened=createApp({dataDir:h.dir});try{const restored=reopened.locals.store.read('real') as AppState;assert.equal(restored.students[0].code,'BACK-1');assert.equal(restored.students[0].reportApproval?.pdfId,pdf.id);}finally{reopened.locals.store.close();}
    await rm(h.dir,{recursive:true,force:true});
  }finally{if(!closed)await h.close();}
});

test('Excel exporta solo F admitidos, tres periodos y los campos manuales del concurso; catálogo no crea registros',async()=>{
  const h=await harness();try{
    const pdf=await upload(h,reportPdf('EXPORT-1','Estudiante Exportado'));await confirm(h,pdf.id);
    let state=await readState(h),student=state.students[0];
    student.institutional=[{id:'contest',name:'Olimpiada Nacional',date:'2026-10-10',required:true,status:'fulfilled',justification:'',evidence:'Acta',validated:true,placement:'Primer puesto',representingSchool:true}];
    const response=await h.request(`/api/students/${student.id}`,'PUT',student);assert.equal(response.status,200);
    state=await readState(h);
    const settings={...state.settings,criteriaApproved:true,cohortRecords:[{id:'template',kind:'institutional',name:'Plantilla de referencia',date:'2026-10-10',grade:'3.º de secundaria',section:'F',required:true}]};
    assert.equal((await h.request('/api/settings','PUT',settings)).status,200);
    state=await readState(h);assert.equal(state.students[0].institutional.length,1);assert.equal(state.students[0].family.length,0);
    state.students.push(createStudent({code:'OLD-A',name:'Historico otra aula',grade:'3',section:'A'},state.settings));h.app.locals.store.save('real',state);
    const exported=await h.request('/api/export');assert.equal(exported.status,200);
    const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await exported.arrayBuffer()) as never);
    assert.deepEqual(book.worksheets.map(sheet=>sheet.name),['RANKING','DETALLE','PENDIENTES','CONFIGURACIÓN']);
    const detail=book.getWorksheet('DETALLE')!;assert.equal(detail.rowCount,2);assert.equal(detail.getCell('A2').value,'EXPORT-1');
    const headers=detail.getRow(1).values as string[];
    assert.deepEqual(headers.filter(value=>String(value).startsWith('Calificaciones ')),['Calificaciones I','Calificaciones II','Calificaciones III']);
    const placement=headers.indexOf('Puesto en concursos'),representation=headers.indexOf('Representación del colegio');
    assert.match(String(detail.getRow(2).getCell(placement).value),/Primer puesto/);assert.match(String(detail.getRow(2).getCell(representation).value),/true/);
    assert.equal(book.getWorksheet('PENDIENTES')!.rowCount,2);
    assert.equal((await h.request('/api/settings','PUT',{...settings,closed:true})).status,200);
    assert.equal((await h.request(`/api/pdfs/${pdf.id}`,'DELETE')).status,423);
    assert.equal((await h.request('/api/settings','PUT',{...settings,closed:false})).status,423);
    assert.equal((await h.request('/api/settings','PUT',{...settings,closed:false,confirmReopen:true})).status,200);
  }finally{await h.close();}
});


test('Eliminar un expediente sin PDF exige su nombre exacto y funciona con la evaluación abierta o cerrada',async()=>{
  for(const closed of [false,true]){
    const h=await harness();try{
      const state=await readState(h),student=createStudent({code:'EMPTY-DELETE',name:'Estudiante Sin Libreta',grade:'3.º de secundaria',section:'F'},state.settings);
      state.students.push(student);state.settings.closed=closed;state.settings.criteriaApproved=closed;h.app.locals.store.save('real',state);
      const settings=structuredClone(state.settings),route=`/api/students/${student.id}?dataset=real`;
      for(const body of [undefined,{}, {confirmation:true}, {confirmation:'Otro estudiante'}, {confirmation:student.name.toLowerCase()}])assert.equal((await h.request(route,'DELETE',body)).status,400);
      assert.equal((await readState(h)).students.length,1);
      if(closed)assert.equal((await h.request(route,'DELETE',{confirmation:student.name})).status,423);
      assert.equal((await h.request(route,'DELETE',{confirmation:student.name,allowClosed:true,expectedUpdatedAt:'anterior'})).status,409);
      const response=await h.request(route,'DELETE',{confirmation:student.name,allowClosed:true,expectedUpdatedAt:student.updatedAt});
      assert.equal(response.status,200,await response.clone().text());
      assert.deepEqual(await response.json(),{deleted:true,studentId:student.id,deletedPdfIds:[],students:1,pdfs:0});
      const after=await readState(h);assert.deepEqual(after.students,[]);assert.deepEqual(after.pdfs,[]);assert.deepEqual(after.settings,settings);
    }finally{await h.close();}
  }
});

test('Eliminar desde la ficha borra versiones y copias propias, conserva otros propietarios del mismo hash y permite reimportar',async()=>{
  const h=await harness();try{
    const bytes=reportPdf('FILE-DELETE','Estudiante A Eliminar'),original=await upload(h,bytes,'original.pdf');await confirm(h,original.id);
    const copy=await upload(h,bytes,'copia.pdf');
    const version=await upload(h,reportPdf('FILE-DELETE','Estudiante A Eliminar','matematica'),'nueva-version.pdf');
    const other=await upload(h,reportPdf('FILE-KEEP','Estudiante Conservado'),'conservado.pdf');await confirm(h,other.id);
    const store=h.app.locals.store,state=await readState(h),student=state.students.find(value=>value.id===original.studentId)!,remaining=state.students.find(value=>value.id===other.studentId)!;
    const unownedCopy=state.pdfs.find(value=>value.id===copy.id)!;unownedCopy.studentId=null;student.pdfIds=student.pdfIds.filter(id=>id!==copy.id);
    const foreignCopy={...structuredClone(original),id:randomUUID(),studentId:remaining.id,status:'duplicate' as const};
    state.pdfs.push(foreignCopy);remaining.pdfIds.push(foreignCopy.id);
    const unrelated={...structuredClone(original),id:randomUUID(),studentId:null,status:'failed' as const,hash:'a'.repeat(64),name:'fallido-que-menciona-el-codigo.pdf',text:student.code};
    state.pdfs.push(unrelated);
    store.transaction(()=>{store.putFile('real',foreignCopy.id,bytes);store.putFile('real',unrelated.id,bytes);store.save('real',state);});
    // Even malformed historical links cannot select a document explicitly owned by somebody else.
    const malformed=structuredClone(state);malformed.students.find(value=>value.id===student.id)!.pdfIds.push(other.id,foreignCopy.id);
    const preview=deleteStudentAndReports(malformed,student.id);
    assert.deepEqual(new Set(preview.deletedPdfIds),new Set([original.id,copy.id,version.id]));
    assert(malformed.students.some(value=>value.id===remaining.id));assert(malformed.pdfs.some(value=>value.id===foreignCopy.id));
    const response=await h.request(`/api/students/${student.id}?dataset=real`,'DELETE',{confirmation:student.name,expectedUpdatedAt:student.updatedAt});
    assert.equal(response.status,200,await response.clone().text());
    const deletion=await response.json();assert.equal(deletion.students,1);assert.equal(deletion.pdfs,3);assert.deepEqual(new Set(deletion.deletedPdfIds),new Set([original.id,copy.id,version.id]));
    const after=await readState(h);assert.deepEqual(after.students,[remaining]);assert.deepEqual(new Set(after.pdfs.map(value=>value.id)),new Set([other.id,foreignCopy.id,unrelated.id]));
    for(const id of deletion.deletedPdfIds)assert.equal(store.file('real',id),null);
    assert.equal(store.files('real').length,3);assert.deepEqual(store.file('real',foreignCopy.id),bytes);
    const reimported=await upload(h,bytes,'reimportado.pdf');assert.equal(reimported.status,'review');assert(reimported.studentId);assert.notEqual(reimported.studentId,student.id);
  }finally{await h.close();}
});

test('Vaciar la evaluación limpia todos los registros y originales huérfanos solo de la base seleccionada, preserva parámetros y es idempotente',async()=>{
  for(const dataset of ['real','demo'] as const)for(const closed of [false,true]){
    const h=await harness();try{
      const store=h.app.locals.store,otherDataset=dataset==='real'?'demo':'real',bytes=Buffer.from('original conservado');
      const state:AppState=store.read(dataset),legacy=createStudent({code:'LEGACY-CLEAR',name:'Estudiante de aula antigua',grade:'5.º de secundaria',section:'A'},state.settings);
      state.students.push(legacy);
      state.settings={...state.settings,closed,year:2031,version:'Parámetros conservados',criteriaApproved:true,naPolicy:'other_component',naPolicyApproved:true,academicWeights:{general:0.5,specialized:0.3,progress:0.2},performanceWeights:{attendance:0.6,discipline:0.4},scienceWeight:0.35,familyTypes:['Reunión personalizada'],cohortRecords:[{id:'keep-catalog',kind:'family',name:'Criterio institucional conservado',date:'2031-06-01',grade:'',section:'F',required:true}],disciplineTypes:state.settings.disciplineTypes.map((type,index)=>({...type,discount:index+1})),areas:[...state.settings.areas,{id:'keep-area',name:'Área configurada',group:'other',eligible:true,competencies:['Competencia configurada']}]};
      const pdfBase:AppState['pdfs'][number]={id:randomUUID(),name:'original-antiguo.pdf',hash:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,uploadedAt:new Date().toISOString(),status:'failed',studentId:null,extractedCode:'LEGACY-CLEAR',extractedName:'',extractedGrade:'5.º de secundaria',extractedSection:'A',period:'',text:'',ocr:false,warnings:[],areas:[]};
      const records=[pdfBase,{...structuredClone(pdfBase),id:randomUUID(),status:'duplicate' as const},{...structuredClone(pdfBase),id:randomUUID(),status:'review' as const},{...structuredClone(pdfBase),id:randomUUID(),status:'replaced' as const,replacesId:pdfBase.id}];
      state.pdfs.push(...records);
      const orphanId=randomUUID(),otherOrphanId=randomUUID();
      store.transaction(()=>{for(const record of records)store.putFile(dataset,record.id,bytes);store.putFile(dataset,orphanId,bytes);store.save(dataset,state);store.putFile(otherDataset,otherOrphanId,bytes);});
      const before=store.read(dataset),otherBefore={state:store.read(otherDataset),files:store.files(otherDataset)},route=`/api/evaluation?dataset=${dataset}`,expectedCounts={students:before.students.length,pdfs:before.pdfs.length};
      assert.equal((await h.request('/api/evaluation','DELETE',{confirmation:'ELIMINAR TODO',allowClosed:true})).status,400);
      for(const confirmation of [undefined,true,'eliminar todo',' ELIMINAR TODO','OTRA BASE'])assert.equal((await h.request(route,'DELETE',{confirmation,allowClosed:true})).status,400);
      assert.equal((await h.request(route,'DELETE',{confirmation:'ELIMINAR TODO',allowClosed:true,expectedCounts:{...expectedCounts,pdfs:expectedCounts.pdfs+1}})).status,409);
      assert.equal((await h.request(route,'DELETE',{confirmation:'ELIMINAR TODO',allowClosed:true,expectedCounts:{students:-1,pdfs:0}})).status,400);
      if(closed)assert.equal((await h.request(route,'DELETE',{confirmation:'ELIMINAR TODO'})).status,423);
      assert.deepEqual(store.read(dataset),before);assert.equal(store.files(dataset).length,5);
      const response=await h.request(route,'DELETE',{confirmation:'ELIMINAR TODO',allowClosed:true,expectedCounts});
      assert.equal(response.status,200,await response.clone().text());assert.deepEqual(await response.json(),{deleted:true,...expectedCounts,files:5});
      assert.deepEqual(store.read(dataset),{students:[],pdfs:[],settings:{...before.settings,closed:false}});assert.deepEqual(store.files(dataset),[]);assert.equal(store.file(dataset,orphanId),null);
      assert.deepEqual({state:store.read(otherDataset),files:store.files(otherDataset)},otherBefore);
      const repeated=await h.request(route,'DELETE',{confirmation:'ELIMINAR TODO',expectedCounts:{students:0,pdfs:0}});assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),{deleted:true,students:0,pdfs:0,files:0});
    }finally{await h.close();}
  }
});

test('La eliminación de expediente y la limpieza total revierten también los archivos si falla el guardado',async()=>{
  const h=await harness();try{
    const original=await upload(h,reportPdf('ROLLBACK-DELETE','Estudiante Conservado Ante Fallo'));
    const store=h.app.locals.store,student=(await readState(h)).students[0],orphanId=randomUUID();store.putFile('real',orphanId,Buffer.from('huérfano'));
    const before={state:store.read('real'),files:store.files('real')},save=store.save;
    for(const [route,body] of [[`/api/students/${student.id}?dataset=real`,{confirmation:student.name}],['/api/evaluation?dataset=real',{confirmation:'ELIMINAR TODO'}]] as const){
      store.save=()=>{throw new Error('Fallo de persistencia simulado al eliminar');};
      try{assert.equal((await h.request(route,'DELETE',body)).status,500);}finally{store.save=save;}
      assert.deepEqual({state:store.read('real'),files:store.files('real')},before);
      assert.equal((await h.request(`/api/pdfs/${original.id}/file`)).status,200);assert(store.file('real',orphanId));
    }
  }finally{await h.close();}
});
