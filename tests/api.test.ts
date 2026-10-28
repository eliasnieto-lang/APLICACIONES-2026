import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { createApp } from '../server/index.js';
import type { AppState, Student } from '../shared/types.js';
import { createStudent, defaultSettings } from '../shared/defaults.js';

function reportPdf(code:string,name:string,omitArea='',grade='3',section='F') {
  const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[()\\]/g,'\\$&');
  const lines=[`Codigo estudiante: ${code}`,`Estudiante: ${name}`,`Grado: ${grade}`,`Seccion: ${section}`,'Periodo: 2026'];
  for(const area of defaultSettings.areas.filter(area=>area.id!==omitArea)){lines.push(area.name,...area.competencies.map(c=>`${c} A A A`));}
  const stream=`BT /F1 9 Tf 40 790 Td 12 TL ${lines.map((s,i)=>`${i?'T* ':''}(${normalize(s)}) Tj`).join('\n')} ET`;
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

test('Identidades ausentes o aulas ajenas permanecen en revisión; la corrección explícita conserva la extracción',async()=>{
  const h=await harness();try{
    for(const [grade,section] of [['1','F'],['5','F'],['12','F'],['25','F'],['3xyz','F'],['3','A']]){
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
    assert.equal(missing.studentId,null);assert.equal((await readState(h)).students.length,1);
    await confirm(h,missing.id,{identity:{code:'COR-2',name:'Sin Codigo Corregido',grade:'4.º',section:'F'}});
    assert.equal((await readState(h)).students.length,2);
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
    assert.equal(student.reportApproval?.pdfId,replacement.id);assert.equal(student.validated.academic,false);
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
