import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { ZodError } from 'zod';
import type { AppState, Dataset, HistoryEntry, PdfRecord, Student } from '../shared/types.js';
import { createStudent, createDemoState } from '../shared/defaults.js';
import { calculateStudent, validateSettings, cohortRecordApplies } from '../shared/calculations.js';
import { normalizeCohort, isReportApproved } from '../shared/policy.js';
import { migrateState } from '../shared/migrations.js';
import { resolveReportIdentity } from '../shared/filename-identity.js';
import { registerImportedReport, identifyReport, applyReprocessedReport, applyRescannedGrades, confirmReport, deleteReportAndStudent, deleteStudentAndReports, linkAcademic, ReportWorkflowError } from '../shared/report-workflow.js';
import { ACADEMIC_CONTEST_LABEL, isAcademicContest } from '../shared/contests.js';
import { hasActiveGrades } from '../shared/academic-policy.js';
import { Store, CapacityError } from './store.js';
import { extractPdf } from './pdf.js';
import { buildWorkbook } from './export.js';
import { backupSchema, newStudentSchema, settingsSchema, studentSchema, semanticStudentErrors, stateReferenceErrors } from './validation.js';

class HttpError extends Error { constructor(public status: number, message: string, public details?: string[]) { super(message); } }
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(a,b);
const stamp=()=>new Date().toISOString();
const pdfFilename=(value:string):string=>{
  // Multipart headers are read as latin1 by busboy; restore valid UTF-8 names once.
  const decoded=Buffer.from(value,'latin1').toString('utf8');
  const restored=/[ÃÂ][\u0080-\u00bf]/.test(value)&&!decoded.includes('�')?decoded:value;
  return path.basename(restored.replace(/\\/g,'/')).slice(0,300);
};
const audit=(field:string,before:unknown,after:unknown):HistoryEntry=>({id:randomUUID(),date:stamp(),field,before:typeof before==='string'?before:JSON.stringify(before),after:typeof after==='string'?after:JSON.stringify(after)});
const dataset=(req:Request):Dataset=>{ const v=req.query.dataset??'real'; if(v!=='real'&&v!=='demo') throw new HttpError(400,'La base de datos seleccionada no es válida.'); return v; };
const unlocked=(state:AppState)=>{if(state.settings.closed) throw new HttpError(423,'La evaluación está cerrada. Reábrala en Parámetros antes de modificar registros.');};
const checkErrors=(errors:string[])=>{if(errors.length) throw new HttpError(400,errors[0],errors);};
const findStudent=(state:AppState,id:string)=>{const student=state.students.find(s=>s.id===id);if(!student) throw new HttpError(404,'Estudiante no encontrado.');return student;};
function syncExistingCohortRecords(student:Student,settings:AppState['settings']) {
  if(student.commitmentEnabled===false)return;
  const before={institutional:structuredClone(student.institutional),family:structuredClone(student.family)};
  for(const kind of ['institutional','family'] as const)for(const record of student[kind]){
    if(kind==='institutional'&&isAcademicContest(record))continue;
    if(!record.catalogId)continue;
    const criterion=settings.cohortRecords?.find(value=>value.id===record.catalogId&&value.kind===kind&&cohortRecordApplies(value,student));
    if(!criterion){delete record.catalogId;record.validated=false;continue;}
    if(record.name!==criterion.name||record.date!==criterion.date||record.required!==criterion.required){record.name=criterion.name;record.date=criterion.date;record.required=criterion.required;record.validated=false;}
  }
  const after={institutional:student.institutional,family:student.family};
  if(!same(before,after)){student.validated.commitment=false;student.history.push(audit('Sincronización de criterios comunes de cohorte',before,after));}
}

export function createApp(options: {dataDir?: string} = {}) {
  const app=express();
  const store=new Store(options.dataDir??process.env.DATA_DIR??path.resolve('data'));
  app.locals.store=store;
  app.disable('x-powered-by');
  app.use(express.json({limit:'512mb'}));
  app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:50,fields:10,fieldSize:10000}});
  app.get('/api/health',(_req,res)=>res.json({status:'ok',storage:'sqlite',version:'1.0.0'}));
  app.get('/api/state',(req,res)=>res.json(store.read(dataset(req))));
  app.post('/api/students',(req,res)=>{
    const ds=dataset(req),state=store.read(ds);unlocked(state);
    const input=newStudentSchema.parse(req.body);
    const cohort=normalizeCohort(input.grade,input.section);
    if(!cohort)throw new HttpError(400,'Seleccione un grado de 1.º a 5.º de secundaria y una sección de A a Z.');
    if(state.students.some(s=>s.code.toLocaleLowerCase()===input.code.toLocaleLowerCase()))throw new HttpError(409,'Ya existe un estudiante con ese código.');
    const student=createStudent({...input,grade:cohort.grade,section:cohort.section},state.settings);student.history=[audit('Creación de expediente','',input)];
    state.students.push(student);store.save(ds,state);res.status(201).json(student);
  });
  app.put('/api/students/:id',(req,res)=>{
    const ds=dataset(req),state=store.read(ds);unlocked(state);
    const current=findStudent(state,String(req.params.id));
    const student=studentSchema.parse({...req.body,reportApproval:current.reportApproval,commitmentEnabled:req.body.commitmentEnabled===undefined?current.commitmentEnabled??true:req.body.commitmentEnabled,circleStatus:req.body.circleStatus===undefined?current.circleStatus??'pending':req.body.circleStatus}) as Student;
    if(student.id!==current.id)throw new HttpError(400,'El identificador del estudiante no se puede modificar.');
    if(student.updatedAt!==current.updatedAt)throw new HttpError(409,'El expediente cambió en otra pestaña. Recargue antes de guardar.');
    const cohort=normalizeCohort(student.grade,student.section);
    if(!cohort)throw new HttpError(400,'Seleccione un grado de 1.º a 5.º de secundaria y una sección de A a Z.');
    student.grade=cohort.grade;student.section=cohort.section;
    if(['code','name','grade','section'].some(field=>student[field as keyof Student]!==current[field as keyof Student]))throw new HttpError(409,'Los datos del estudiante se obtienen automáticamente del PDF y no se editan en la ficha.');
    student.reportApproval=current.reportApproval;
    student.pdfIds=[...current.pdfIds];
    const evaluationFields=['academic','attendance','discipline','institutional','family','validated','commitmentEnabled'] as const;
    if(!isReportApproved(current)&&evaluationFields.some(field=>!same(current[field],student[field])))throw new HttpError(409,'Revise y confirme la libreta PDF antes de editar los tres ámbitos de evaluación.');
    for(const area of student.academic)if(!hasActiveGrades(area))area.validated=false;
    student.history=[...current.history];
    if(state.students.some(s=>s.id!==student.id&&s.code.toLocaleLowerCase()===student.code.toLocaleLowerCase()))throw new HttpError(409,'Ya existe un estudiante con ese código.');
    const academicChanged=!same(current.academic.map(a=>({areaId:a.areaId,grades:a.grades})),student.academic.map(a=>({areaId:a.areaId,grades:a.grades})));
    if(academicChanged){
      student.validated.academic=false;
      for(const area of student.academic){const old=current.academic.find(a=>a.areaId===area.areaId);if(!old||!same(old.grades,area.grades))area.validated=false;}
    }
    const attendanceChanged=!same({...current.attendance,validated:false},{...student.attendance,validated:false});
    const disciplineChanged=!same(current.discipline,student.discipline);
    if(attendanceChanged){student.attendance.validated=false;student.validated.performance=false;}
    if(disciplineChanged)student.validated.performance=false;
    const commitmentsChanged=!same(current.institutional,student.institutional)||!same(current.family,student.family);
    if(commitmentsChanged)student.validated.commitment=false;
    checkErrors(semanticStudentErrors(student,state.settings));
    const result=calculateStudent(student,state.settings);
    if(student.validated.academic&&result.a===null)throw new HttpError(400,'Complete y valide las calificaciones I–III de los cursos estudiados antes de validar el ámbito académico.');
    if(student.validated.performance&&result.b===null)throw new HttpError(400,'Complete asistencia y disciplina antes de validar desempeño.');
    if(student.commitmentEnabled!==false&&student.validated.commitment&&result.c===null)throw new HttpError(400,'Complete y revise los compromisos antes de validar el ámbito C.');
    for(const field of ['code','name','grade','section','academic','attendance','discipline','institutional','family','validated','commitmentEnabled','circleStatus'] as const){if(!same(current[field],student[field]))student.history.push(audit(field,current[field],student[field]));}
    student.pdfIds=current.pdfIds;student.createdAt=current.createdAt;student.updatedAt=stamp();
    state.students[state.students.findIndex(s=>s.id===student.id)]=student;
    store.save(ds,state);res.json(student);
  });
  app.delete('/api/students/:id',(req,res)=>{
    const ds=dataset(req),state=store.read(ds),student=findStudent(state,String(req.params.id));
    if(!req.body||req.body.confirmation!==student.name)throw new HttpError(400,'Escriba los apellidos y nombres exactos del estudiante para confirmar su eliminación.');
    if(state.settings.closed&&req.body.allowClosed!==true)throw new HttpError(423,'Confirme la eliminación del expediente de la evaluación cerrada.');
    if(req.body.expectedUpdatedAt!==undefined&&req.body.expectedUpdatedAt!==student.updatedAt)throw new HttpError(409,'El expediente cambió desde la confirmación. Recargue y revise antes de eliminarlo.');
    const result=deleteStudentAndReports(state,student.id);
    store.transaction(()=>{store.deleteFiles(ds,result.deletedPdfIds);store.save(ds,state);});
    res.json({deleted:true,...result,students:1,pdfs:result.deletedPdfIds.length});
  });
  app.delete('/api/evaluation',(req,res)=>{
    if(req.query.dataset===undefined)throw new HttpError(400,'Seleccione explícitamente la base de datos que desea vaciar.');
    const ds=dataset(req),state=store.read(ds);
    if(!req.body||req.body.confirmation!=='ELIMINAR TODO')throw new HttpError(400,'Escriba ELIMINAR TODO para confirmar la eliminación de la evaluación.');
    if(state.settings.closed&&req.body.allowClosed!==true)throw new HttpError(423,'Confirme la eliminación de los datos de la evaluación cerrada.');
    const expected=req.body.expectedCounts;
    if(expected!==undefined){
      if(!expected||!Number.isSafeInteger(expected.students)||expected.students<0||!Number.isSafeInteger(expected.pdfs)||expected.pdfs<0)throw new HttpError(400,'Los conteos de la confirmación no son válidos.');
      if(expected.students!==state.students.length||expected.pdfs!==state.pdfs.length)throw new HttpError(409,'Los datos cambiaron desde la confirmación. Recargue y revise antes de eliminar todo.');
    }
    const counts={students:state.students.length,pdfs:state.pdfs.length,files:(store.db.prepare('SELECT count(*) AS count FROM documents WHERE dataset=?').get(ds) as {count:number}).count};
    store.replace(ds,{students:[],pdfs:[],settings:{...state.settings,closed:false}},[]);
    res.json({deleted:true,...counts});
  });
  app.put('/api/settings',(req,res)=>{
    const ds=dataset(req),state=store.read(ds),settings=settingsSchema.parse({...req.body,dimensionWeights:req.body.dimensionWeights===undefined?state.settings.dimensionWeights:req.body.dimensionWeights});
    settings.activityTypes=[ACADEMIC_CONTEST_LABEL];
    if(state.settings.closed&&(req.body.confirmReopen!==true||settings.closed))throw new HttpError(423,'Confirme explícitamente la reapertura de la evaluación antes de modificar los parámetros.');
    checkErrors(validateSettings(settings));
    const criteriaChanged=!same({...state.settings,closed:false},{...settings,closed:false});
    if(settings.closed&&!settings.criteriaApproved)throw new HttpError(400,'Apruebe los criterios institucionales antes de cerrar la evaluación.');
    if(settings.closed&&criteriaChanged)throw new HttpError(400,'Guarde los cambios de parámetros y revise los expedientes antes de cerrar la evaluación.');
    const availableCategories=new Set(settings.disciplineTypes.map(type=>type.id));
    if(state.students.some(s=>s.discipline.incidents.some(i=>(i.verified||i.typeId.trim())&&!availableCategories.has(i.typeId))))throw new HttpError(400,'No se puede retirar una categoría disciplinaria utilizada en expedientes. Conserve la categoría o reasigne las incidencias antes de retirarla.');
    if(criteriaChanged){
      for(const s of state.students){
        s.history.push(audit('Cambio de parámetros institucionales',state.settings,settings));
        s.validated={academic:false,performance:false,commitment:false};s.attendance.validated=false;s.discipline.confirmed=false;
        s.institutional.forEach(c=>c.validated=false);s.family.forEach(c=>c.validated=false);
        const previousAcademic=structuredClone(s.academic);
        s.academic=settings.areas.map(def=>{const old=s.academic.find(a=>a.areaId===def.id);const oldDefinition=state.settings.areas.find(a=>a.id===def.id);return{areaId:def.id,grades:def.competencies.map(name=>{const i=oldDefinition?.competencies.indexOf(name)??-1;return i>=0?old?.grades[i]??['','','']:['','',''];}),validated:false};});
        if(!same(previousAcademic,s.academic))s.history.push(audit('Revisión de catálogo académico',previousAcademic,s.academic));
        syncExistingCohortRecords(s,settings);
        s.updatedAt=stamp();
      }
    }
    if(state.settings.closed!==settings.closed)for(const s of state.students)s.history.push(audit('Estado de la evaluación',state.settings.closed?'Cerrada':'Abierta',settings.closed?'Cerrada':'Abierta'));
    state.settings=settings;store.save(ds,state);res.json(settings);
  });
  app.post('/api/demo/reset',(req,res)=>{const ds=dataset(req);if(ds!=='demo')throw new HttpError(400,'El reinicio solo está permitido para datos ficticios.');const state=createDemoState();store.replace('demo',state,[]);res.json(state);});
  app.post('/api/pdfs',upload.array('files',50),async(req,res)=>{
    const ds=dataset(req);unlocked(store.read(ds));
    const files=req.files as Express.Multer.File[];
    if(!files?.length)throw new HttpError(400,'Seleccione uno o varios archivos PDF.');
    if(files.reduce((n,f)=>n+f.size,0)>80*1024*1024)throw new HttpError(413,'El lote no puede superar 80 MB. Divida la carga en varios lotes.');
    const processed:PdfRecord[]=[];
    for(const file of files){
      const hash=createHash('sha256').update(file.buffer).digest('hex');
      let state=store.read(ds);unlocked(state);
      const duplicate=state.pdfs.find(p=>p.hash===hash&&p.status!=='duplicate');
      const pdf:PdfRecord={id:randomUUID(),name:pdfFilename(file.originalname),hash,size:file.size,uploadedAt:stamp(),status:'review',studentId:null,extractedCode:'',extractedName:'',extractedGrade:'',extractedSection:'',period:'',text:'',ocr:false,warnings:[],areas:[]};
      if(duplicate){pdf.status='duplicate';pdf.studentId=duplicate.studentId;pdf.warnings=[`Contenido duplicado de ${duplicate.name}. No se han sobrescrito las calificaciones.`];const student=state.students.find(s=>s.id===pdf.studentId);if(student)student.pdfIds.push(pdf.id);}
      else if(!file.buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))){pdf.status='failed';pdf.warnings=['El archivo no contiene un documento PDF válido.'];}
      else {
        const dir=await mkdtemp(path.join(os.tmpdir(),'circulos-pdf-'));
        try{
          const source=path.join(dir,'document.pdf');await writeFile(source,file.buffer);
          const extractionSettings=structuredClone(state.settings);
          const sourceIdentity=resolveReportIdentity(pdf);
          Object.assign(pdf,await extractPdf(source,extractionSettings,{identityFromFilename:Boolean(sourceIdentity.name&&normalizeCohort(sourceIdentity.grade,sourceIdentity.section)),cohort:sourceIdentity}));
          // Extraction can take time; reload so simultaneous manual edits are retained.
          state=store.read(ds);unlocked(state);
          if(!same(extractionSettings,state.settings)){
            pdf.warnings.push('Los parámetros cambiaron durante la lectura. Revise el documento con el catálogo vigente antes de aplicar notas.');
            pdf.areas=[];
          }
          registerImportedReport(state,pdf);
          if(!pdf.studentId)pdf.warnings.push('La lectura automática no reconoció todos los datos del estudiante. La libreta permanece sin confirmar.');
        }catch(error){
          state=store.read(ds);unlocked(state);
          const message=error instanceof Error?error.message:'No fue posible leer el PDF.';
          const identity=resolveReportIdentity(pdf);
          const usableFilename=identity.name&&normalizeCohort(identity.grade,identity.section);
          pdf.status=usableFilename&&!/no se pudo abrir|no contiene.*PDF|dañado|contraseña|protegido/i.test(message)?'review':'failed';
          pdf.warnings=[message];
          if(pdf.status==='review'){pdf.warnings.push('El nombre y el aula se obtuvieron del archivo. Las notas no reconocidas quedan pendientes de revisión.');registerImportedReport(state,pdf);}
        }
        finally{await rm(dir,{recursive:true,force:true});}
      }
      state.pdfs.push(pdf);store.transaction(()=>{store.putFile(ds,pdf.id,file.buffer);store.save(ds,state);});processed.push(pdf);
    }
    res.status(201).json({pdfs:processed});
  });
  app.get('/api/pdfs/:id/file',(req,res)=>{
    const ds=dataset(req),state=store.read(ds),pdf=state.pdfs.find(p=>p.id===req.params.id);
    if(!pdf)throw new HttpError(404,'PDF no encontrado.');
    const content=store.file(ds,pdf.id);if(!content)throw new HttpError(404,'El archivo original no está disponible.');
    res.type('application/pdf').setHeader('Content-Disposition',`inline; filename="documento.pdf"; filename*=UTF-8''${encodeURIComponent(pdf.name)}`);
    res.setHeader('X-Content-Type-Options','nosniff');res.send(content);
  });
  app.put('/api/pdfs/:id',async(req,res)=>{
    const ds=dataset(req),state=store.read(ds);unlocked(state);
    if(!req.body||typeof req.body!=='object')throw new HttpError(400,'Envíe una acción y un estudiante para actualizar el PDF.');
    const pdf=state.pdfs.find(p=>p.id===req.params.id);if(!pdf)throw new HttpError(404,'PDF no encontrado.');
    const action=req.body.action;
    if(!['link','replace','validate','identify','reprocess','rescan-grades'].includes(action))throw new HttpError(400,'Acción de PDF no válida.');
    if(action==='identify'){
      if(typeof req.body.name!=='string')throw new HttpError(400,'Indique los apellidos y nombres del estudiante.');
      if(req.body.grade!==undefined&&typeof req.body.grade!=='string'||req.body.section!==undefined&&typeof req.body.section!=='string')throw new HttpError(400,'El grado y sección deben ser texto.');
      const updated=identifyReport(state,pdf.id,{name:req.body.name,...(req.body.grade!==undefined?{grade:req.body.grade}:{}),...(req.body.section!==undefined?{section:req.body.section}:{})});
      store.save(ds,state);res.json(updated);return;
    }
    if(action==='rescan-grades'){
      if(!['review','validated'].includes(pdf.status))throw new HttpError(409,'Solo una libreta activa en revisión o validada permite actualizar sus notas.');
      const content=store.file(ds,pdf.id);
      if(!content)throw new HttpError(404,'No está disponible el PDF original para actualizar sus notas.');
      if(!content.subarray(0,1024).includes(Buffer.from('%PDF-'))||createHash('sha256').update(content).digest('hex')!==pdf.hash)throw new HttpError(400,'El archivo original no es un PDF válido o no coincide con la libreta conservada.');
      const directory=await mkdtemp(path.join(os.tmpdir(),'circulos-notas-'));
      try{
        const source=path.join(directory,'original.pdf');await writeFile(source,content);
        const reading=await extractPdf(source,structuredClone(state.settings),{identityFromFilename:true,forceGrades:true,cohort:state.students.find(student=>student.id===pdf.studentId)??resolveReportIdentity(pdf)});
        let updated:PdfRecord|undefined;
        store.transaction(()=>{
          const latest=store.read(ds);unlocked(latest);
          const current=latest.pdfs.find(record=>record.id===pdf.id);
          if(!current||!same(current,pdf)||!same(state.settings,latest.settings))throw new HttpError(409,'El documento o sus parámetros cambiaron durante la lectura. Vuelva a actualizar sus notas.');
          updated=applyRescannedGrades(latest,pdf.id,reading);
          store.save(ds,latest);
        });
        res.json(updated);return;
      }finally{await rm(directory,{recursive:true,force:true});}
    }
    if(action==='reprocess'){
      if(!['pending','review','failed'].includes(pdf.status))throw new HttpError(409,'Esta versión ya está confirmada, duplicada o reemplazada.');
      const content=store.file(ds,pdf.id);
      if(!content)throw new HttpError(404,'No está disponible el PDF original para leerlo automáticamente.');
      const directory=await mkdtemp(path.join(os.tmpdir(),'circulos-relectura-'));
      try{
        const source=path.join(directory,'original.pdf');
        await writeFile(source,content);
        const sourceIdentity=resolveReportIdentity(pdf);
        const reading=await extractPdf(source,structuredClone(state.settings),{identityFromFilename:Boolean(sourceIdentity.name&&normalizeCohort(sourceIdentity.grade,sourceIdentity.section)),cohort:sourceIdentity});
        const latest=store.read(ds);unlocked(latest);
        const current=latest.pdfs.find(record=>record.id===pdf.id);
        if(!current||current.hash!==pdf.hash||!same(state.settings,latest.settings)||!same(current,pdf))throw new HttpError(409,'El documento o sus parámetros cambiaron durante la lectura automática. Vuelva a abrir la revisión.');
        const updated=applyReprocessedReport(latest,pdf.id,reading);
        store.save(ds,latest);res.json(updated);return;
      }finally{await rm(directory,{recursive:true,force:true});}
    }
    if(pdf.status==='failed'||pdf.status==='duplicate')throw new HttpError(400,'Un PDF fallido o duplicado no puede aplicarse a un expediente.');
    if(action==='validate'){
      if(req.body.name!==undefined&&typeof req.body.name!=='string')throw new HttpError(400,'Los apellidos y nombres deben ser texto.');
      if(req.body.grade!==undefined&&typeof req.body.grade!=='string'||req.body.section!==undefined&&typeof req.body.section!=='string')throw new HttpError(400,'El grado y sección deben ser texto.');
      const result=confirmReport(state,pdf.id,{identity:req.body.identity,...(req.body.name!==undefined?{name:req.body.name}:{}),...(req.body.grade!==undefined?{grade:req.body.grade}:{}),...(req.body.section!==undefined?{section:req.body.section}:{}),confirmMismatch:req.body.confirmMismatch===true});
      store.save(ds,state);res.json(result.pdf);return;
    }
    const student=findStudent(state,req.body.studentId||pdf.studentId);
    if(!normalizeCohort(student.grade,student.section))throw new HttpError(400,'El estudiante debe tener un grado de 1.º a 5.º de secundaria y una sección de A a Z.');
    if(pdf.extractedCode&&pdf.extractedCode.toLocaleLowerCase()!==student.code.toLocaleLowerCase()&&req.body.confirmMismatch!==true)throw new HttpError(409,'El código extraído no coincide. Confirme la reasignación antes de unir los registros.');
    {
      const old=pdf.studentId?state.students.find(s=>s.id===pdf.studentId):null;
      if(old&&old.id!==student.id){old.pdfIds=old.pdfIds.filter(id=>id!==pdf.id);if(old.reportApproval?.pdfId===pdf.id)delete old.reportApproval;old.validated.academic=false;old.academic.forEach(area=>area.validated=false);old.updatedAt=stamp();old.history.push(audit('Reasignación de PDF',pdf.name,student.code));}
      const prior=state.pdfs.find(p=>p.id===req.body.replacesId);
      const existing=state.pdfs.filter(p=>p.studentId===student.id&&p.id!==pdf.id&&!['duplicate','failed','replaced'].includes(p.status));
      if(existing.length&&action==='link')throw new HttpError(409,'El estudiante ya tiene una libreta. Seleccione Reemplazar para conservar trazabilidad.');
      if(action==='replace'){
        if(!prior||prior.studentId!==student.id||prior.id===pdf.id)throw new HttpError(400,'Seleccione la libreta anterior del mismo estudiante.');
        prior.status='replaced';pdf.replacesId=prior.id;
      }
      pdf.studentId=student.id;pdf.status='review';linkAcademic(student,pdf,state.settings,true);
    }
    store.save(ds,state);res.json(pdf);
  });
  app.delete('/api/pdfs/:id',(req,res)=>{
    const ds=dataset(req),state=store.read(ds);unlocked(state);
    const result=deleteReportAndStudent(state,String(req.params.id));
    store.transaction(()=>{store.deleteFiles(ds,result.deletedPdfIds);store.save(ds,state);});
    res.json({deleted:true,...result});
  });
  app.get('/api/records/template',(_req,res)=>res.type('text/csv').attachment('plantilla_asistencia.csv').send('\uFEFFcodigo,dias,eximidos,asistencias,puntuales\nEJEMPLO-001,200,0,190,171\n'));
  app.post('/api/records/import',upload.single('file'),async(req,res)=>{
    const ds=dataset(req);let state=store.read(ds);unlocked(state);
    const file=req.file;if(!file)throw new HttpError(400,'Seleccione un archivo CSV o XLSX.');
    let rows:Record<string,unknown>[]=[];
    if(/\.csv$/i.test(file.originalname)){
      const source=file.buffer.toString('utf8').replace(/^\uFEFF/,'');
      const delimiter=source.split(/\r?\n/)[0].includes(';')?';':',';
      try{rows=parseCsv(source,{columns:true,skip_empty_lines:true,trim:true,delimiter});}catch{throw new HttpError(400,'El CSV no tiene un formato válido. Use la plantilla de asistencia.');}
    }else if(/\.xlsx$/i.test(file.originalname)){
      const book=new ExcelJS.Workbook();await book.xlsx.load(file.buffer as never);const sheet=book.worksheets[0];if(!sheet)throw new HttpError(400,'El Excel no contiene hojas.');
      const headers:string[]=[];sheet.getRow(1).eachCell((cell,col)=>{headers[col]=String(cell.value??'').trim().toLowerCase();});
      sheet.eachRow((row,index)=>{if(index===1)return;const data:Record<string,unknown>={};headers.forEach((header,col)=>{if(header)data[header]=row.getCell(col).value;});rows.push(data);});
    }else throw new HttpError(400,'Use CSV o Excel XLSX para importar asistencia.');
    if(rows.length>10000)throw new HttpError(400,'El archivo no puede superar 10 000 filas.');
    state=store.read(ds);unlocked(state);
    const errors:string[]=[];let updated=0;const seen=new Set<string>();
    rows.forEach((raw,index)=>{
      const row=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key.trim().toLowerCase(),value]));
      const code=String(row.codigo??'').trim();
      const s=state.students.find(s=>s.code.toLocaleLowerCase()===code.toLocaleLowerCase());
      if(!s){errors.push(`Fila ${index+2}: código ${code||'(vacío)'} no encontrado.`);return;}
      if(!isReportApproved(s)){errors.push(`Fila ${index+2}: confirme la libreta PDF de ${code} antes de importar asistencia.`);return;}
      if(seen.has(s.id)){errors.push(`Fila ${index+2}: código repetido; no se aplicó esta fila.`);return;}seen.add(s.id);
      const values=['dias','eximidos','asistencias','puntuales'].map(key=>row[key]===undefined||row[key]===null||String(row[key]).trim()===''?null:Number(row[key]));
      if(values.some(v=>v===null||!Number.isInteger(v)||v<0||v>10000)){errors.push(`Fila ${index+2}: complete los cuatro conteos con enteros válidos.`);return;}
      const attendance={required:values[0],exempted:values[1],attended:values[2],punctual:values[3],validated:false};
      const candidate={...s,attendance};const problems=semanticStudentErrors(candidate,state.settings);
      if(problems.length){errors.push(`Fila ${index+2}: ${problems[0]}`);return;}
      s.history.push(audit('Asistencia importada',s.attendance,attendance));s.attendance=attendance;s.validated.performance=false;s.updatedAt=stamp();updated++;
    });
    store.save(ds,state);res.json({updated,errors});
  });
  app.get('/api/export',async(req,res)=>{
    const state=store.read(dataset(req));const filters={grade:typeof req.query.grade==='string'?req.query.grade:undefined,section:typeof req.query.section==='string'?req.query.section:undefined};
    const book=await buildWorkbook(state,filters);const content=await book.xlsx.writeBuffer();
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`Ranking_Circulos_${state.settings.year}.xlsx`).send(Buffer.from(content));
  });
  app.get('/api/backup',(req,res)=>{const ds=dataset(req);res.type('application/json').attachment(`Circulos_${ds}_${stamp().slice(0,10)}.json`).send(JSON.stringify({format:'circulos-backup',version:1,dataset:ds,createdAt:stamp(),state:store.read(ds),files:store.files(ds)}));});
  app.post('/api/restore',(req,res)=>{
    const ds=dataset(req);unlocked(store.read(ds));const backup=backupSchema.parse(req.body);
    if(backup.dataset!==ds)throw new HttpError(400,'El respaldo corresponde a otra base. Cambie a Datos reales o Demostración antes de restaurarlo.');
    const legacyDuplicateLinks=backup.state.settings.workflowVersion!==2&&backup.state.pdfs.every(pdf=>!pdf.studentId||backup.state.students.find(student=>student.id===pdf.studentId)?.pdfIds.includes(pdf.id)||pdf.status==='duplicate');
    const rawReferenceErrors=stateReferenceErrors(backup.state).filter(error=>!legacyDuplicateLinks||error!=='El vínculo del PDF no aparece en el expediente del estudiante.');
    checkErrors(rawReferenceErrors);
    backup.state=migrateState(backup.state);
    checkErrors([...validateSettings(backup.state.settings),...stateReferenceErrors(backup.state)]);
    if(backup.state.settings.closed&&!backup.state.settings.criteriaApproved)throw new HttpError(400,'El respaldo contiene una evaluación cerrada sin criterios aprobados.');
    const ids=new Set(backup.files.map(f=>f.id));
    if(ids.size!==backup.files.length||backup.state.pdfs.some(p=>!ids.has(p.id)))throw new HttpError(400,'El respaldo no incluye todos los PDF originales.');
    const files=backup.files.map(file=>{
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)||file.content.length%4)throw new HttpError(400,'Contenido de archivo no válido en el respaldo.');
      const content=Buffer.from(file.content,'base64');const record=backup.state.pdfs.find(p=>p.id===file.id);
      if(!record||content.length!==record.size||createHash('sha256').update(content).digest('hex')!==record.hash)throw new HttpError(400,'La integridad de un PDF del respaldo no es válida.');
      return{id:file.id,content};
    });
    store.replace(ds,backup.state,files);res.json({restored:true,students:backup.state.students.length,pdfs:files.length});
  });
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(process.env.NODE_ENV==='production'){
    app.use(express.static(path.join(root,'dist')));
    app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(root,'dist','index.html')));
  }
  app.use('/api',(_req,res)=>res.status(404).json({error:'Ruta de API no encontrada.'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof HttpError){res.status(error.status).json({error:error.message,details:error.details});return;}
    if(error instanceof ReportWorkflowError){res.status(error.status).json({error:error.message});return;}
    if(error instanceof ZodError){res.status(400).json({error:'Los datos no tienen el formato esperado.',details:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`)});return;}
    if(error instanceof multer.MulterError){res.status(413).json({error:'La carga excede el límite: hasta 50 PDF por lote y 20 MB por archivo.'});return;}
    if(error instanceof CapacityError){res.status(413).json({error:error.message});return;}
    if((error as {type?:string})?.type==='entity.too.large'){res.status(413).json({error:'El respaldo supera el límite de 512 MB por base de datos.'});return;}
    if(error instanceof SyntaxError){res.status(400).json({error:'El archivo JSON no es válido.'});return;}
    console.error(error instanceof Error?error.message:'Error interno');res.status(500).json({error:'No se pudo completar la operación. Revise el formato e inténtelo nuevamente.'});
  });
  return app;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();const port=Number(process.env.PORT)||3001;
  const server=app.listen(port,'0.0.0.0',()=>console.log(`Círculos API disponible en puerto ${port}`));
  const shutdown=()=>server.close(()=>{app.locals.store.close();process.exit(0);});
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
