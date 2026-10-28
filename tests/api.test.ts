import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { createApp } from '../server/index.js';
import type { AppState, Student } from '../shared/types.js';
import { defaultSettings } from '../shared/defaults.js';

function reportPdf(code:string,name:string,omitArea='') {
  const normalize=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[()\\]/g,'\\$&');
  const lines=[`Codigo: ${code}`,`Estudiante: ${name}`,'Grado: 3','Seccion: A','Periodo: 2026'];
  for(const area of defaultSettings.areas.filter(area=>area.id!==omitArea)){lines.push(area.name,...area.competencies.map(c=>`${c} A A A A`));}
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

test('SQLite: datos reales aislados, validación, importación CSV y persistencia tras reinicio',async()=>{
  const h=await harness();let closed=false;
  try{
    const initial=await (await h.request('/api/state')).json() as AppState;
    assert.equal(initial.students.length,0);assert.equal(initial.settings.criteriaApproved,false);
    const demo=await (await h.request('/api/state?dataset=demo')).json() as AppState;assert(demo.students.length>=8);
    let response=await h.request('/api/students','POST',{code:'AL-001',name:'Estudiante de prueba',grade:'3',section:'A'});assert.equal(response.status,201);
    let student=await response.json() as Student;
    response=await h.request('/api/students','POST',{code:'al-001',name:'Duplicado',grade:'3',section:'A'});assert.equal(response.status,409);
    const invalid={...student,attendance:{required:100,exempted:0,attended:101,punctual:90,validated:false}};
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',invalid)).status,400);
    const form=new FormData();form.append('file',new Blob(['codigo,dias,eximidos,asistencias,puntuales\nAL-001,200,10,180,170\nINEXISTENTE,200,0,190,180\n'],{type:'text/csv'}),'asistencia.csv');
    response=await fetch(h.base+'/api/records/import',{method:'POST',body:form});assert.equal(response.status,200);
    const imported=await response.json();assert.equal(imported.updated,1);assert.equal(imported.errors.length,1);
    const state=await (await h.request('/api/state')).json() as AppState;
    student=state.students[0];assert.equal(student.attendance.exempted,10);assert.equal(student.attendance.validated,false);assert(student.history.some(v=>v.field==='Asistencia importada'));
    await h.close(false);closed=true;
    const reopened=createApp({dataDir:h.dir});const restored=reopened.locals.store.read('real') as AppState;
    assert.equal(restored.students[0].code,'AL-001');assert.equal(restored.students[0].attendance.attended,180);
    reopened.locals.store.close();await rm(h.dir,{recursive:true,force:true});
  }finally{if(!closed)await h.close();}
});

test('PDF múltiple: diez fichas, duplicados, originales, respaldo íntegro y restauración atómica',async()=>{
  const h=await harness();try{
    const form=new FormData();for(let i=1;i<=10;i++)form.append('files',new Blob([reportPdf(`PDF-${i}`,`Estudiante Prueba ${i}`)],{type:'application/pdf'}),`libreta_${i}.pdf`);
    let response=await fetch(h.base+'/api/pdfs',{method:'POST',body:form});assert.equal(response.status,201);
    const result=await response.json();assert.equal(result.pdfs.length,10);assert(result.pdfs.every((p:{studentId:string})=>p.studentId));
    let state=await (await h.request('/api/state')).json() as AppState;
    assert.equal(state.students.length,10);assert.equal(state.pdfs.length,10);assert(state.students.every(s=>!s.validated.academic));
    assert.equal(state.students[0].academic[0].grades[0][0],'A');
    response=await h.request(`/api/pdfs/${state.pdfs[0].id}/file`);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');
    const source=Buffer.from(await response.arrayBuffer());assert(source.subarray(0,5).equals(Buffer.from('%PDF-')));
    const duplicateForm=new FormData();duplicateForm.append('files',new Blob([reportPdf('PDF-1','Estudiante Prueba 1')],{type:'application/pdf'}),'copia.pdf');
    const dup=await (await fetch(h.base+'/api/pdfs',{method:'POST',body:duplicateForm})).json();assert.equal(dup.pdfs[0].status,'duplicate');
    state=await (await h.request('/api/state')).json() as AppState;assert.equal(state.students.length,10);
    const backup=await (await h.request('/api/backup')).json();assert.equal(backup.files.length,11);
    const corrupted=structuredClone(backup);corrupted.files[0].content=Buffer.from('alterado').toString('base64');
    assert.equal((await h.request('/api/restore','POST',corrupted)).status,400);
    assert.equal((await (await h.request('/api/state')).json()).students.length,10);
    assert.equal((await h.request('/api/restore','POST',backup)).status,200);
    response=await h.request(`/api/pdfs/${state.pdfs[0].id}/file`);assert(Buffer.from(await response.arrayBuffer()).equals(source));
    const wrongDataset={...backup,dataset:'demo'};assert.equal((await h.request('/api/restore','POST',wrongDataset)).status,400);
  }finally{await h.close();}
});

test('Excel con cuatro hojas: ranking descendente y pendientes separados; cierre bloquea cambios',async()=>{
  const h=await harness();try{
    let response=await h.request('/api/export?dataset=demo');assert.equal(response.status,200);
    const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as never);
    assert.deepEqual(book.worksheets.map(s=>s.name),['RANKING','DETALLE','PENDIENTES','CONFIGURACIÓN']);
    const ranking=book.getWorksheet('RANKING')!;assert(ranking.rowCount>2);
    const cohortScores=new Map<string,number>();
    ranking.eachRow((row,index)=>{if(index===1)return;const cohort=String(row.getCell(12).value);const score=Number(row.getCell(9).value);if(cohortScores.has(cohort))assert(score<=cohortScores.get(cohort)!);cohortScores.set(cohort,score);});
    const pending=book.getWorksheet('PENDIENTES')!;assert(pending.rowCount>1);
    const rankedCodes=new Set<string>();ranking.eachRow((row,index)=>{if(index>1)rankedCodes.add(String(row.getCell(2).value));});
    pending.eachRow((row,index)=>{if(index>1)assert(!rankedCodes.has(String(row.getCell(1).value)));});
    const state=await (await h.request('/api/state?dataset=demo')).json() as AppState;
    response=await h.request('/api/settings?dataset=demo','PUT',{...state.settings,closed:true});assert.equal(response.status,200);
    const afterClose=await (await h.request('/api/state?dataset=demo')).json() as AppState;
    assert.equal(afterClose.students[0].validated.academic,state.students[0].validated.academic,'Cerrar sin cambiar criterios conserva las validaciones');
    assert.equal((await h.request('/api/students?dataset=demo','POST',{code:'X',name:'No',grade:'3',section:'A'})).status,423);
    assert.equal((await h.request('/api/settings?dataset=demo','PUT',{...state.settings,closed:false})).status,423);
    assert.equal((await h.request('/api/settings?dataset=demo','PUT',{...state.settings,closed:false,confirmReopen:true})).status,200);
    assert.equal((await h.request('/api/state?dataset=invalid')).status,400);
  }finally{await h.close();}
});

test('Reemplazar una libreta deja en blanco las áreas que no se reconocen en la nueva versión',async()=>{
  const h=await harness();try{
    const upload=async(bytes:Buffer,name:string)=>{
      const form=new FormData();form.append('files',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),name);
      const response=await fetch(h.base+'/api/pdfs',{method:'POST',body:form});assert.equal(response.status,201);
      return (await response.json()).pdfs[0];
    };
    const prior=await upload(reportPdf('REPL-1','Estudiante Reemplazo'),'original.pdf');
    const replacement=await upload(reportPdf('REPL-1','Estudiante Reemplazo','matematica'),'nueva.pdf');
    const before=await (await h.request('/api/state')).json() as AppState;
    assert.equal(before.students[0].academic[0].grades[0][0],'A');
    const response=await h.request(`/api/pdfs/${replacement.id}`,'PUT',{action:'replace',studentId:prior.studentId,replacesId:prior.id});
    assert.equal(response.status,200);
    const after=await (await h.request('/api/state')).json() as AppState;
    assert(after.students[0].academic.find(area=>area.areaId==='matematica')!.grades.every(row=>row.every(value=>value==='')));
    assert.equal(after.students[0].academic.find(area=>area.areaId==='ciencia')!.grades[0][0],'A');
    assert.equal(after.pdfs.find(pdf=>pdf.id===prior.id)!.status,'replaced');
    assert(after.students[0].history.some(entry=>entry.before.includes('matematica')&&entry.before.includes('"A"')));
  }finally{await h.close();}
});

test('Pauta común: sincroniza cohortes, protege metadatos, conserva retirados y audita cambios',async()=>{
  const h=await harness();try{
    const created=await (await h.request('/api/students','POST',{code:'COH-1',name:'Estudiante Cohorte',grade:'3',section:'A'})).json() as Student;
    const initial=await (await h.request('/api/state')).json() as AppState;
    const settings={...initial.settings,cohortRecords:[{id:'event-1',kind:'institutional',name:'Concurso común',date:'2026-10-10',grade:'3',section:'A',required:true}]};
    assert.equal((await h.request('/api/settings','PUT',settings)).status,200);
    let state=await (await h.request('/api/state')).json() as AppState;
    let student=state.students.find(s=>s.id===created.id)!;
    assert.equal(student.institutional.length,1);assert.equal(student.institutional[0].catalogId,'event-1');assert.equal(student.institutional[0].status,'pending');
    const forged=structuredClone(student);forged.institutional[0].required=false;
    assert.equal((await h.request(`/api/students/${student.id}`,'PUT',forged)).status,409);
    const modified=structuredClone(student);modified.institutional[0].status='fulfilled';modified.institutional[0].evidence='Acta de concurso';
    const result=await h.request(`/api/students/${student.id}`,'PUT',modified);assert.equal(result.status,200);
    student=await result.json() as Student;
    assert(student.history.some(entry=>entry.field==='institutional'&&entry.after.includes('fulfilled')));
    const sibling=await (await h.request('/api/students','POST',{code:'COH-2',name:'Otra cohorte',grade:'4',section:'A'})).json() as Student;
    assert.equal(sibling.institutional.length,0);
    assert.equal((await h.request('/api/settings','PUT',{...state.settings,cohortRecords:[]})).status,200);
    state=await (await h.request('/api/state')).json() as AppState;student=state.students.find(s=>s.id===created.id)!;
    assert.equal(student.institutional[0].catalogId,undefined);assert.equal(student.institutional[0].status,'na');assert.equal(student.institutional[0].required,false);assert.equal(student.institutional[0].validated,false);
    assert(student.history.some(entry=>entry.field==='Sincronización de criterios comunes de cohorte'&&entry.before.includes('fulfilled')));
    const backup=await (await h.request('/api/backup')).json();const malformed=structuredClone(backup);malformed.state.students[0].academic[0].grades[0][0]='E';
    assert.throws(()=>h.app.locals.store.save('real',malformed.state),'La persistencia rechaza estados que luego no podrían restaurarse');
    assert.equal((await h.request('/api/restore','POST',malformed)).status,400);
    assert.equal((await (await h.request('/api/state')).json()).students.length,2);
    assert.equal((await h.request('/api/restore','POST',backup)).status,200);
  }finally{await h.close();}
});
