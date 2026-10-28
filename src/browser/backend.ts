import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/browser/esm/sync';
import { ZodError } from 'zod';
import type { AppState, Dataset, HistoryEntry, PdfRecord, Settings, Student } from '../../shared/types';
import { createDemoState, createStudent, defaultSettings } from '../../shared/defaults';
import { calculateStudent, cohortRecordApplies, validateSettings } from '../../shared/calculations';
import { buildWorkbook } from '../../server/export';
import { backupSchema, newStudentSchema, semanticStudentErrors, settingsSchema, stateReferenceErrors, stateSchema, studentSchema } from '../../server/validation';
import { setBrowserRuntime } from '../runtime';
import { extractBrowserPdf } from './pdf';

const DB_NAME = 'circulos-2027-web';
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const TEMPLATE = '\uFEFFcodigo,dias,eximidos,asistencias,puntuales\nEJEMPLO-001,200,0,190,171\n';
const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const same = (before: unknown, after: unknown): boolean => {
  if (Object.is(before, after)) return true;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  if (Array.isArray(before) !== Array.isArray(after)) return false;
  const left = Object.keys(before), right = Object.keys(after);
  return left.length === right.length && left.every(key => Object.hasOwn(after, key) && same((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key]));
};

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: string[]) { super(message); }
}
const audit = (field: string, before: unknown, after: unknown): HistoryEntry => ({ id: uuid(), date: stamp(), field, before: typeof before === 'string' ? before : JSON.stringify(before), after: typeof after === 'string' ? after : JSON.stringify(after) });
const unlocked = (state: AppState) => { if (state.settings.closed) throw new HttpError(423, 'La evaluación está cerrada. Reábrala en Parámetros antes de modificar registros.'); };
const checkErrors = (errors: string[]) => { if (errors.length) throw new HttpError(400, errors[0], errors); };
const findStudent = (state: AppState, id: string) => { const student = state.students.find(value => value.id === id); if (!student) throw new HttpError(404, 'Estudiante no encontrado.'); return student; };
const fileKey = (dataset: Dataset, id: string) => `${dataset}:${id}`;
const fileRange = (dataset: Dataset) => IDBKeyRange.bound(`${dataset}:`, `${dataset}:\uffff`);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const attachment = (body: BodyInit, type: string, name: string) => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` } });

function linkAcademic(student: Student, pdf: PdfRecord, replacementSettings?: Settings) {
  const before = structuredClone(student.academic);
  if (replacementSettings) student.academic = replacementSettings.areas.map(area => ({ areaId: area.id, grades: area.competencies.map(() => ['', '', '', '']), validated: false }));
  for (const area of pdf.areas.filter(value => value.grades.some(row => row.some(Boolean)))) {
    const target = student.academic.find(value => value.areaId === area.areaId);
    if (target) { target.grades = structuredClone(area.grades); target.validated = false; }
  }
  student.validated.academic = false;
  student.history.push(audit(`Importación PDF: ${pdf.name}`, before, student.academic));
  if (!student.pdfIds.includes(pdf.id)) student.pdfIds.push(pdf.id);
  student.updatedAt = stamp();
}

function syncCohortRecords(student: Student, settings: Settings) {
  const before = { institutional: structuredClone(student.institutional), family: structuredClone(student.family) };
  const criteria = settings.cohortRecords ?? [];
  for (const kind of ['institutional', 'family'] as const) {
    const records = student[kind];
    for (const record of records) {
      if (!record.catalogId) continue;
      const criterion = criteria.find(value => value.id === record.catalogId && value.kind === kind && cohortRecordApplies(value, student));
      if (!criterion) { record.catalogId = undefined; record.required = false; record.status = 'na'; record.justification = `Criterio común retirado o no aplicable a la cohorte. ${record.justification}`.trim(); record.validated = false; continue; }
      if (record.name !== criterion.name || record.date !== criterion.date || record.required !== criterion.required) { record.name = criterion.name; record.date = criterion.date; record.required = criterion.required; record.validated = false; }
    }
    for (const criterion of criteria.filter(value => value.kind === kind && cohortRecordApplies(value, student))) {
      if (!records.some(record => record.catalogId === criterion.id)) records.push({ id: uuid(), catalogId: criterion.id, name: criterion.name, date: criterion.date, required: criterion.required, status: 'pending', justification: '', evidence: '', validated: false });
    }
  }
  const after = { institutional: student.institutional, family: student.family };
  if (!same(before, after)) { student.validated.commitment = false; student.history.push(audit('Sincronización de criterios comunes de cohorte', before, after)); }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('Se canceló el guardado local.')); transaction.onerror = () => { /* onabort provides the final result. */ }; });
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('state')) db.createObjectStore('state'); if (!db.objectStoreNames.contains('files')) db.createObjectStore('files'); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cierre las otras ventanas de Círculos y vuelva a abrir la aplicación para actualizar el almacenamiento local.'));
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
async function initialize(db: IDBDatabase) {
  const transaction = db.transaction('state', 'readwrite');
  const done = transactionDone(transaction), store = transaction.objectStore('state');
  for (const dataset of ['real', 'demo'] as const) {
    const request = store.get(dataset);
    request.onsuccess = () => { if (request.result === undefined) store.put(dataset === 'real' ? { students: [], settings: structuredClone(defaultSettings), pdfs: [] } : createDemoState(), dataset); };
  }
  await done;
}
async function readState(db: IDBDatabase, dataset: Dataset): Promise<AppState> {
  const transaction = db.transaction('state', 'readonly'), done = transactionDone(transaction);
  const state = await requestValue<AppState>(transaction.objectStore('state').get(dataset));
  await done;
  if (!state) throw new HttpError(500, 'No se encontró la base local. Recargue la aplicación.');
  return state;
}
async function readFiles(db: IDBDatabase, dataset: Dataset): Promise<Map<string, Blob>> {
  const transaction = db.transaction('files', 'readonly'), done = transactionDone(transaction), store = transaction.objectStore('files');
  const [entries] = await Promise.all([fileEntries(store, dataset), done]);
  return new Map(entries);
}
function fileEntries(store: IDBObjectStore, dataset: Dataset): Promise<[string, Blob][]> {
  return new Promise((resolve, reject) => {
    const values: [string, Blob][] = [], request = store.openCursor(fileRange(dataset));
    request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(values); return; } values.push([String(cursor.key).slice(dataset.length + 1), cursor.value as Blob]); cursor.continue(); };
    request.onerror = () => reject(request.error);
  });
}
async function readSnapshot(db: IDBDatabase, dataset: Dataset): Promise<{ state: AppState; files: Map<string, Blob> }> {
  const transaction = db.transaction(['state', 'files'], 'readonly'), done = transactionDone(transaction);
  const [state, files] = await Promise.all([requestValue<AppState>(transaction.objectStore('state').get(dataset)), fileEntries(transaction.objectStore('files'), dataset), done]);
  return { state, files: new Map(files) };
}
async function sha256(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
}
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function fromBase64(content: string): Blob {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4) throw new HttpError(400, 'Contenido de archivo no válido en el respaldo.');
  try { return new Blob([Uint8Array.from(atob(content), character => character.charCodeAt(0))], { type: 'application/pdf' }); }
  catch { throw new HttpError(400, 'Contenido de archivo no válido en el respaldo.'); }
}

let installation: Promise<void> | undefined;

/** Install the portable edition's API. Data and original files live in one IndexedDB transaction. */
export function installBrowserBackend(): Promise<void> {
  installation ??= install();
  return installation;
}

async function install(): Promise<void> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) throw new Error('Este navegador no permite el almacenamiento local seguro. Abra el archivo en una versión actual de Chrome, Edge o Firefox.');
  const db = await openDatabase();
  await initialize(db);
  const documentUrls = new Map<string, string>();
  const templateUrl = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const registerFiles = (dataset: Dataset, files: Map<string, Blob>, replace = false) => {
    // Keep URLs already displayed in other components alive until this page closes.
    if (replace) for (const key of documentUrls.keys()) if (key.startsWith(`${dataset}:`)) documentUrls.delete(key);
    for (const [id, blob] of files) documentUrls.set(fileKey(dataset, id), URL.createObjectURL(blob.type === 'application/pdf' ? blob : blob.slice(0, blob.size, 'application/pdf')));
  };
  const initialFiles = await Promise.all((['real', 'demo'] as const).map(async dataset => ({ dataset, files: await readFiles(db, dataset) })));
  for (const { dataset, files } of initialFiles) registerFiles(dataset, files);
  setBrowserRuntime({ documentUrl: (id, dataset) => documentUrls.get(fileKey(dataset, id)) ?? '', templateUrl: () => templateUrl });
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(DB_NAME);
  channel?.addEventListener('message', event => {
    const message = event.data as { dataset?: Dataset; changed?: string[]; removed?: string[] };
    if (!message || !['real', 'demo'].includes(message.dataset ?? '') || !Array.isArray(message.changed) || !Array.isArray(message.removed)) return;
    const dataset = message.dataset!;
    void readFiles(db, dataset).then(files => {
      for (const id of message.removed!) documentUrls.delete(fileKey(dataset, id));
      registerFiles(dataset, new Map(message.changed!.flatMap(id => { const blob = files.get(id); return blob ? [[id, blob] as [string, Blob]] : []; })));
    }).catch(() => {});
  });

  async function save(dataset: Dataset, state: AppState, expected: string, additions = new Map<string, Blob>(), replace = false) {
    stateSchema.parse(state);
    checkErrors([...validateSettings(state.settings), ...stateReferenceErrors(state)]);
    const previousFiles = await readFiles(db, dataset), resultingFiles = replace ? new Map<string, Blob>() : new Map(previousFiles);
    for (const [id, blob] of additions) resultingFiles.set(id, blob);
    const payload = JSON.stringify(state), envelope = JSON.stringify({ format: 'circulos-backup', version: 1, dataset, createdAt: stamp(), state: null, files: [] });
    const bytes = new TextEncoder().encode(payload).length + new TextEncoder().encode(envelope).length - 4 + Array.from(resultingFiles, ([id, blob]) => new TextEncoder().encode(JSON.stringify({ id, content: '' })).length + 4 * Math.ceil(blob.size / 3)).reduce((sum, size) => sum + size, 0) + Math.max(0, resultingFiles.size - 1);
    if (bytes > MAX_BACKUP_BYTES) throw new HttpError(413, 'La operación supera el límite de respaldo de 512 MB por base de datos. Reduzca el tamaño de los PDF antes de volver a cargarlos. El registro actual no se guardó.');
    const transaction = db.transaction(['state', 'files'], 'readwrite');
    let conflict = false;
    const done = transactionDone(transaction), states = transaction.objectStore('state'), files = transaction.objectStore('files');
    const current = states.get(dataset);
    current.onsuccess = () => {
      if (JSON.stringify(current.result) !== expected) { conflict = true; transaction.abort(); return; }
      if (replace) for (const id of previousFiles.keys()) files.delete(fileKey(dataset, id));
      for (const [id, blob] of additions) files.put(blob, fileKey(dataset, id));
      states.put(state, dataset);
    };
    try { await done; } catch (error) { if (conflict) throw new HttpError(409, 'Los datos cambiaron en otra pestaña. Recargue antes de guardar.'); throw error; }
    if (replace || additions.size) registerFiles(dataset, additions, replace);
    if (replace || additions.size) channel?.postMessage({ dataset, changed: [...additions.keys()], removed: replace ? [...previousFiles.keys()].filter(id => !additions.has(id)) : [] });
  }

  async function bodyJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
    if (init?.body !== undefined && init.body !== null) { if (typeof init.body === 'string') return JSON.parse(init.body); if (init.body instanceof Blob) return JSON.parse(await init.body.text()); throw new HttpError(400, 'Envíe los datos en formato JSON.'); }
    if (input instanceof Request) return input.clone().json();
    throw new HttpError(400, 'Envíe los datos en formato JSON.');
  }
  async function bodyForm(input: RequestInfo | URL, init?: RequestInit): Promise<FormData> {
    if (init?.body instanceof FormData) return init.body;
    if (input instanceof Request) return input.clone().formData();
    throw new HttpError(400, 'Seleccione un archivo para importar.');
  }

  async function handle(input: RequestInfo | URL, init: RequestInit | undefined, url: URL): Promise<Response> {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const selected = url.searchParams.get('dataset') ?? 'real';
    if (selected !== 'real' && selected !== 'demo') throw new HttpError(400, 'La base de datos seleccionada no es válida.');
    const dataset: Dataset = selected;
    const path = url.pathname.replace(/\/$/, '');
    if (method === 'GET' && path === '/api/health') return json({ status: 'ok', storage: 'indexeddb', version: '1.0.0' });
    if (method === 'GET' && path === '/api/records/template') return attachment(TEMPLATE, 'text/csv;charset=utf-8', 'plantilla_asistencia.csv');
    const state = await readState(db, dataset), expected = JSON.stringify(state);
    if (method === 'GET' && path === '/api/state') return json(state);

    if (method === 'POST' && path === '/api/students') {
      unlocked(state);
      const newInput = newStudentSchema.parse(await bodyJson(input, init));
      if (state.students.some(student => student.code.toLocaleLowerCase() === newInput.code.toLocaleLowerCase())) throw new HttpError(409, 'Ya existe un estudiante con ese código.');
      const student = createStudent(newInput, state.settings); student.history = [audit('Creación de expediente', '', newInput)];
      state.students.push(student); await save(dataset, state, expected); return json(student, 201);
    }
    const studentMatch = path.match(/^\/api\/students\/([^/]+)$/);
    if (studentMatch && method === 'PUT') {
      unlocked(state);
      const current = findStudent(state, decodeURIComponent(studentMatch[1]));
      const student = studentSchema.parse(await bodyJson(input, init)) as Student;
      if (student.id !== current.id) throw new HttpError(400, 'El identificador del estudiante no se puede modificar.');
      if (student.updatedAt !== current.updatedAt) throw new HttpError(409, 'El expediente cambió en otra pestaña. Recargue antes de guardar.');
      student.history = [...current.history];
      if (state.students.some(value => value.id !== student.id && value.code.toLocaleLowerCase() === student.code.toLocaleLowerCase())) throw new HttpError(409, 'Ya existe un estudiante con ese código.');
      const academicChanged = !same(current.academic.map(area => ({ areaId: area.areaId, grades: area.grades })), student.academic.map(area => ({ areaId: area.areaId, grades: area.grades })));
      if (academicChanged) { student.validated.academic = false; for (const area of student.academic) { const old = current.academic.find(value => value.areaId === area.areaId); if (!old || !same(old.grades, area.grades)) area.validated = false; } }
      const attendanceChanged = !same({ ...current.attendance, validated: false }, { ...student.attendance, validated: false });
      if (attendanceChanged) { student.attendance.validated = false; student.validated.performance = false; }
      if (!same(current.discipline, student.discipline)) student.validated.performance = false;
      if (!same(current.institutional, student.institutional) || !same(current.family, student.family)) student.validated.commitment = false;
      for (const record of [...student.institutional, ...student.family]) if (record.catalogId) {
        const criterion = state.settings.cohortRecords?.find(value => value.id === record.catalogId);
        if (!criterion || record.name.trim() !== criterion.name.trim() || record.date !== criterion.date || record.required !== criterion.required) throw new HttpError(409, 'El nombre, fecha y condición exigible de los criterios comunes se editan en Parámetros. Recargue la ficha para mantener la pauta de la cohorte.');
      }
      syncCohortRecords(student, state.settings);
      checkErrors(semanticStudentErrors(student, state.settings));
      const result = calculateStudent(student, state.settings);
      if (student.validated.academic && result.a === null) throw new HttpError(400, 'Complete todas las calificaciones antes de validar el ámbito académico.');
      if (student.validated.performance && result.b === null) throw new HttpError(400, 'Complete asistencia y disciplina antes de validar desempeño.');
      if (student.validated.commitment && result.c === null) throw new HttpError(400, 'Complete y revise los compromisos antes de validar el ámbito C.');
      for (const field of ['code', 'name', 'grade', 'section', 'academic', 'attendance', 'discipline', 'institutional', 'family', 'validated'] as const) if (!same(current[field], student[field])) student.history.push(audit(field, current[field], student[field]));
      student.pdfIds = current.pdfIds; student.createdAt = current.createdAt; student.updatedAt = stamp();
      state.students[state.students.findIndex(value => value.id === student.id)] = student;
      await save(dataset, state, expected); return json(student);
    }
    if (studentMatch && method === 'DELETE') {
      unlocked(state);
      const student = findStudent(state, decodeURIComponent(studentMatch[1]));
      state.students = state.students.filter(value => value.id !== student.id);
      for (const pdf of state.pdfs) if (pdf.studentId === student.id) { pdf.studentId = null; if (pdf.status === 'validated') pdf.status = 'review'; }
      await save(dataset, state, expected); return json({ deleted: true });
    }
    if (method === 'PUT' && path === '/api/settings') {
      const body = await bodyJson(input, init), settings = settingsSchema.parse(body);
      if (state.settings.closed && ((body as { confirmReopen?: unknown }).confirmReopen !== true || settings.closed)) throw new HttpError(423, 'Confirme explícitamente la reapertura de la evaluación antes de modificar los parámetros.');
      checkErrors(validateSettings(settings));
      const criteriaChanged = !same({ ...state.settings, closed: false }, { ...settings, closed: false });
      if (settings.closed && !settings.criteriaApproved) throw new HttpError(400, 'Apruebe los criterios institucionales antes de cerrar la evaluación.');
      if (settings.closed && criteriaChanged) throw new HttpError(400, 'Guarde los cambios de parámetros y revise los expedientes antes de cerrar la evaluación.');
      const available = new Set(settings.disciplineTypes.map(value => value.id));
      if (state.students.some(student => student.discipline.incidents.some(incident => !available.has(incident.typeId)))) throw new HttpError(400, 'No se puede retirar una categoría disciplinaria utilizada en expedientes. Conserve la categoría o reasigne las incidencias antes de retirarla.');
      if (criteriaChanged) for (const student of state.students) {
        student.history.push(audit('Cambio de parámetros institucionales', state.settings, settings));
        student.validated = { academic: false, performance: false, commitment: false }; student.attendance.validated = false; student.discipline.confirmed = false;
        student.institutional.forEach(record => { record.validated = false; }); student.family.forEach(record => { record.validated = false; });
        const previous = structuredClone(student.academic);
        student.academic = settings.areas.map(definition => { const old = student.academic.find(area => area.areaId === definition.id), oldDefinition = state.settings.areas.find(area => area.id === definition.id); return { areaId: definition.id, grades: definition.competencies.map(name => { const index = oldDefinition?.competencies.indexOf(name) ?? -1; return index >= 0 ? old?.grades[index] ?? ['', '', '', ''] : ['', '', '', '']; }), validated: false }; });
        if (!same(previous, student.academic)) student.history.push(audit('Revisión de catálogo académico', previous, student.academic));
        syncCohortRecords(student, settings); student.updatedAt = stamp();
      }
      if (state.settings.closed !== settings.closed) for (const student of state.students) { student.history.push(audit('Estado de la evaluación', state.settings.closed ? 'Cerrada' : 'Abierta', settings.closed ? 'Cerrada' : 'Abierta')); student.updatedAt = stamp(); }
      state.settings = settings; await save(dataset, state, expected); return json(settings);
    }
    if (method === 'POST' && path === '/api/demo/reset') {
      if (dataset !== 'demo') throw new HttpError(400, 'El reinicio solo está permitido para datos ficticios.');
      const demo = createDemoState(); await save(dataset, demo, expected, new Map(), true); return json(demo);
    }
    if (method === 'POST' && path === '/api/pdfs') {
      unlocked(state);
      const form = await bodyForm(input, init), files = form.getAll('files').filter((file): file is File => file instanceof File);
      if (!files.length) throw new HttpError(400, 'Seleccione uno o varios archivos PDF.');
      if (files.length > 50 || files.some(file => file.size > 20 * 1024 * 1024)) throw new HttpError(413, 'La carga excede el límite: hasta 50 PDF por lote y 20 MB por archivo.');
      if (files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) throw new HttpError(413, 'El lote no puede superar 80 MB. Divida la carga en varios lotes.');
      const processed: PdfRecord[] = [], additions = new Map<string, Blob>();
      for (const file of files) {
        const hash = await sha256(file), duplicate = state.pdfs.find(pdf => pdf.hash === hash && pdf.status !== 'duplicate');
        const pdf: PdfRecord = { id: uuid(), name: file.name.replace(/\\/g, '/').split('/').at(-1)!.slice(0, 300) || 'documento.pdf', hash, size: file.size, uploadedAt: stamp(), status: 'review', studentId: null, extractedCode: '', extractedName: '', extractedGrade: '', extractedSection: '', period: '', text: '', ocr: false, warnings: [], areas: [] };
        if (duplicate) { pdf.status = 'duplicate'; pdf.studentId = duplicate.studentId; pdf.warnings = [`Contenido duplicado de ${duplicate.name}. No se han sobrescrito las calificaciones.`]; }
        else if (!new TextDecoder('latin1').decode(await file.slice(0, 1024).arrayBuffer()).includes('%PDF-')) { pdf.status = 'failed'; pdf.warnings = ['El archivo no contiene un documento PDF válido.']; }
        else {
          try {
            Object.assign(pdf, await extractBrowserPdf(file, structuredClone(state.settings)));
            // Only an exact student code can link records automatically. Every reading needs review.
            if (pdf.extractedCode) {
              let student = state.students.find(value => value.code.toLocaleLowerCase() === pdf.extractedCode.toLocaleLowerCase());
              if (!student && pdf.extractedName) { student = createStudent({ code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade || 'Por definir', section: pdf.extractedSection || '—' }, state.settings); state.students.push(student); }
              if (student) { pdf.studentId = student.id; if (!student.pdfIds.length) linkAcademic(student, pdf); else { student.pdfIds.push(pdf.id); student.updatedAt = stamp(); pdf.warnings.push('El estudiante ya tiene una libreta: confirme el reemplazo para aplicar las nuevas calificaciones.'); } }
            }
            if (!pdf.studentId) pdf.warnings.push('Confirme el estudiante correspondiente; no se ha realizado ninguna unión automática.');
          } catch (error) { pdf.status = 'failed'; pdf.warnings = [error instanceof Error ? error.message : 'No fue posible leer el PDF.']; }
        }
        state.pdfs.push(pdf); additions.set(pdf.id, file.slice(0, file.size, 'application/pdf')); processed.push(pdf);
      }
      await save(dataset, state, expected, additions); return json({ pdfs: processed }, 201);
    }
    const fileMatch = path.match(/^\/api\/pdfs\/([^/]+)\/file$/);
    if (method === 'GET' && fileMatch) {
      const pdf = state.pdfs.find(value => value.id === decodeURIComponent(fileMatch[1]));
      if (!pdf) throw new HttpError(404, 'PDF no encontrado.');
      const file = (await readFiles(db, dataset)).get(pdf.id);
      if (!file) throw new HttpError(404, 'El archivo original no está disponible.');
      return new Response(file, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="documento.pdf"; filename*=UTF-8''${encodeURIComponent(pdf.name)}`, 'X-Content-Type-Options': 'nosniff' } });
    }
    const pdfMatch = path.match(/^\/api\/pdfs\/([^/]+)$/);
    if (method === 'PUT' && pdfMatch) {
      unlocked(state);
      const raw = await bodyJson(input, init);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Envíe una acción y un estudiante para actualizar el PDF.');
      const body = raw as Record<string, unknown>, pdf = state.pdfs.find(value => value.id === decodeURIComponent(pdfMatch[1]));
      if (!pdf) throw new HttpError(404, 'PDF no encontrado.');
      const action = body.action;
      if (!['link', 'replace', 'validate'].includes(String(action))) throw new HttpError(400, 'Acción de PDF no válida.');
      if (['failed', 'duplicate', 'replaced'].includes(pdf.status)) throw new HttpError(400, 'Un PDF fallido, duplicado o reemplazado no puede aplicarse a un expediente.');
      const student = findStudent(state, typeof body.studentId === 'string' && body.studentId ? body.studentId : pdf.studentId ?? '');
      if (pdf.extractedCode && pdf.extractedCode.toLocaleLowerCase() !== student.code.toLocaleLowerCase() && body.confirmMismatch !== true) throw new HttpError(409, 'El código extraído no coincide. Confirme la reasignación antes de unir los registros.');
      if (action === 'link' || action === 'replace') {
        const old = pdf.studentId ? state.students.find(value => value.id === pdf.studentId) : undefined;
        const prior = state.pdfs.find(value => value.id === body.replacesId);
        const existing = state.pdfs.filter(value => value.studentId === student.id && value.id !== pdf.id && !['duplicate', 'failed', 'replaced'].includes(value.status));
        if (existing.length && action === 'link') throw new HttpError(409, 'El estudiante ya tiene una libreta. Seleccione Reemplazar para conservar trazabilidad.');
        if (action === 'replace') { if (!prior || prior.studentId !== student.id || prior.id === pdf.id) throw new HttpError(400, 'Seleccione la libreta anterior del mismo estudiante.'); prior.status = 'replaced'; pdf.replacesId = prior.id; }
        if (old && old.id !== student.id) { old.pdfIds = old.pdfIds.filter(id => id !== pdf.id); old.validated.academic = false; old.updatedAt = stamp(); old.history.push(audit('Reasignación de PDF', pdf.name, student.code)); }
        pdf.studentId = student.id; pdf.status = 'review'; linkAcademic(student, pdf, action === 'replace' ? state.settings : undefined);
      } else {
        if (pdf.studentId !== student.id) throw new HttpError(400, 'Vincule primero el PDF al estudiante.');
        pdf.status = 'validated'; student.history.push(audit('Lectura PDF confirmada', pdf.name, 'Lectura revisada por el operador')); student.updatedAt = stamp();
      }
      await save(dataset, state, expected); return json(pdf);
    }
    if (method === 'POST' && path === '/api/records/import') {
      unlocked(state);
      const form = await bodyForm(input, init), file = form.get('file');
      if (!(file instanceof File)) throw new HttpError(400, 'Seleccione un archivo CSV o XLSX.');
      if (file.size > 20 * 1024 * 1024) throw new HttpError(413, 'El archivo de asistencia no puede superar 20 MB.');
      let rows: Record<string, unknown>[] = [];
      if (/\.csv$/i.test(file.name)) {
        const source = (await file.text()).replace(/^\uFEFF/, ''), delimiter = source.split(/\r?\n/)[0].includes(';') ? ';' : ',';
        try { rows = parseCsv(source, { columns: true, skip_empty_lines: true, trim: true, delimiter }); } catch { throw new HttpError(400, 'El CSV no tiene un formato válido. Use la plantilla de asistencia.'); }
      } else if (/\.xlsx$/i.test(file.name)) {
        const book = new ExcelJS.Workbook();
        try { await book.xlsx.load(await file.arrayBuffer()); } catch { throw new HttpError(400, 'El Excel no tiene un formato XLSX válido.'); }
        const sheet = book.worksheets[0]; if (!sheet) throw new HttpError(400, 'El Excel no contiene hojas.');
        const headers: string[] = []; sheet.getRow(1).eachCell((cell, column) => { headers[column] = String(cell.value ?? '').trim().toLowerCase(); });
        sheet.eachRow((row, index) => { if (index === 1) return; const data: Record<string, unknown> = {}; headers.forEach((header, column) => { if (header) data[header] = row.getCell(column).value; }); rows.push(data); });
      } else throw new HttpError(400, 'Use CSV o Excel XLSX para importar asistencia.');
      if (rows.length > 10000) throw new HttpError(400, 'El archivo no puede superar 10 000 filas.');
      const errors: string[] = [], seen = new Set<string>(); let updated = 0;
      rows.forEach((raw, index) => {
        const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), value])), code = String(row.codigo ?? '').trim();
        const student = state.students.find(value => value.code.toLocaleLowerCase() === code.toLocaleLowerCase());
        if (!student) { errors.push(`Fila ${index + 2}: código ${code || '(vacío)'} no encontrado.`); return; }
        if (seen.has(student.id)) { errors.push(`Fila ${index + 2}: código repetido; no se aplicó esta fila.`); return; } seen.add(student.id);
        const values = ['dias', 'eximidos', 'asistencias', 'puntuales'].map(key => row[key] === undefined || row[key] === null || String(row[key]).trim() === '' ? null : Number(row[key]));
        if (values.some(value => value === null || !Number.isInteger(value) || value < 0 || value > 10000)) { errors.push(`Fila ${index + 2}: complete los cuatro conteos con enteros válidos.`); return; }
        const attendance = { required: values[0], exempted: values[1], attended: values[2], punctual: values[3], validated: false };
        const problems = semanticStudentErrors({ ...student, attendance }, state.settings);
        if (problems.length) { errors.push(`Fila ${index + 2}: ${problems[0]}`); return; }
        student.history.push(audit('Asistencia importada', student.attendance, attendance)); student.attendance = attendance; student.validated.performance = false; student.updatedAt = stamp(); updated++;
      });
      await save(dataset, state, expected); return json({ updated, errors });
    }
    if (method === 'GET' && path === '/api/export') {
      const book = await buildWorkbook(state, { grade: url.searchParams.get('grade') ?? undefined, section: url.searchParams.get('section') ?? undefined });
      const content = await book.xlsx.writeBuffer();
      return attachment(new Blob([content as unknown as ArrayBuffer]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `Ranking_Circulos_${state.settings.year}.xlsx`);
    }
    if (method === 'GET' && path === '/api/backup') {
      // Both stores must come from one snapshot, including when another tab restores data.
      const snapshot = await readSnapshot(db, dataset);
      const files: { id: string; content: string }[] = [];
      for (const [id, blob] of snapshot.files) files.push({ id, content: await base64(blob) });
      return attachment(JSON.stringify({ format: 'circulos-backup', version: 1, dataset, createdAt: stamp(), state: snapshot.state, files }), 'application/json', `Circulos_${dataset}_${stamp().slice(0, 10)}.json`);
    }
    if (method === 'POST' && path === '/api/restore') {
      unlocked(state);
      const backup = backupSchema.parse(await bodyJson(input, init));
      if (backup.dataset !== dataset) throw new HttpError(400, 'El respaldo corresponde a otra base. Cambie a Datos reales o Demostración antes de restaurarlo.');
      checkErrors([...validateSettings(backup.state.settings), ...stateReferenceErrors(backup.state)]);
      if (backup.state.settings.closed && !backup.state.settings.criteriaApproved) throw new HttpError(400, 'El respaldo contiene una evaluación cerrada sin criterios aprobados.');
      const ids = new Set(backup.files.map(file => file.id));
      if (ids.size !== backup.files.length || backup.state.pdfs.some(pdf => !ids.has(pdf.id))) throw new HttpError(400, 'El respaldo no incluye todos los PDF originales.');
      const files = new Map<string, Blob>();
      for (const file of backup.files) {
        const content = fromBase64(file.content), pdf = backup.state.pdfs.find(value => value.id === file.id);
        if (!pdf || content.size !== pdf.size || await sha256(content) !== pdf.hash) throw new HttpError(400, 'La integridad de un PDF del respaldo no es válida.');
        files.set(file.id, content);
      }
      await save(dataset, backup.state, expected, files, true); return json({ restored: true, students: backup.state.students.length, pdfs: files.size });
    }
    throw new HttpError(404, 'Ruta de API no encontrada.');
  }

  function failure(error: unknown): Response {
    if (error instanceof HttpError) return json({ error: error.message, details: error.details }, error.status);
    if (error instanceof ZodError) return json({ error: 'Los datos no tienen el formato esperado.', details: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) }, 400);
    if (error instanceof SyntaxError) return json({ error: 'El archivo JSON no es válido.' }, 400);
    if (error instanceof DOMException && ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) return json({ error: 'El navegador no tiene espacio suficiente. Descargue un respaldo y libere almacenamiento o reduzca el tamaño de los PDF. Los datos anteriores se conservaron.' }, 413);
    if (error instanceof DOMException && ['InvalidStateError', 'SecurityError', 'UnknownError'].includes(error.name)) return json({ error: 'No se pudo acceder al almacenamiento local. Abra la aplicación en una ventana normal de Chrome, Edge o Firefox y habilite el almacenamiento del sitio.' }, 503);
    console.error(error instanceof Error ? error.message : 'Error de almacenamiento local');
    return json({ error: 'No se pudo completar la operación. Revise el formato e inténtelo nuevamente.' }, 500);
  }

  const originalFetch = window.fetch.bind(window);
  let pending: Promise<unknown> = Promise.resolve();
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url: URL;
    try { url = new URL(rawUrl, window.location.href); } catch { return originalFetch(input, init); }
    if (!url.pathname.startsWith('/api/') || url.origin !== window.location.origin) return originalFetch(input, init);
    const work = async () => {
      const run = () => handle(input, init, url);
      try {
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        return method !== 'GET' && navigator.locks ? await navigator.locks.request(`${DB_NAME}:${url.searchParams.get('dataset') ?? 'real'}`, run) : await run();
      } catch (error) { return failure(error); }
    };
    const result = pending.then(work, work); pending = result.then(() => undefined, () => undefined); return result;
  }) as typeof window.fetch;
}
