import { documentUrl } from './runtime';
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, Files, FileText, CircleCheck, CircleAlert, LoaderCircle, Eye, ExternalLink, Plus, Trash2, X } from 'lucide-react';
import type { Dataset, PdfRecord, Settings, Student } from '../shared/types';
import { ACTIVE_BIMESTERS, ALLOWED_COHORTS, normalizeCohort } from '../shared/policy';
import { hasActiveGrades } from '../shared/academic-policy';
import { reportWarnings } from '../shared/pdf-parser';
import { resolveReportIdentity } from '../shared/filename-identity';

const classroomDescription = '1.º a 5.º de secundaria, en todas sus secciones';

interface Props {
  pdfs: PdfRecord[]; students: Student[]; settings: Settings; dataset: Dataset;
  onRefresh: () => Promise<void>; onOpenStudent: (id: string) => void; notify: (message: string) => void;
}
interface QueuedFile { id: string; name: string; state: 'pending' | 'processing' | 'done' | 'failed'; error?: string }
const labels: Record<PdfRecord['status'], string> = { pending: 'Pendiente', review: 'Por revisar', validated: 'Lectura confirmada', failed: 'Fallido', duplicate: 'Duplicado', replaced: 'Reemplazado' };
const recognizedValue = (value: string, maxLength = 200) => Boolean(value.trim() && value.trim().length <= maxLength && !/^(?:por revisar|por definir|sin c[oó]digo(?: reconocido)?|sin nombre|sin grado|sin secci[oó]n|desconocido|[-—–])$/i.test(value.trim()));
const reportIdentity = resolveReportIdentity;
const displayReadWarning = (warning: string) => warning
  .replace(/:\s*complete la identidad antes de vincular\.?/i, '. La lectura automática no pudo completar la identificación.')
  .replace(/:\s*complételos comparando con el PDF original\.?/i, '. La lectura automática no pudo completar la identificación.')
  .replace(/:\s*confirme el aula comparando con el PDF original\.?/i, '. La lectura automática no pudo reconocer el aula.');
const reviewWarnings = (pdf: PdfRecord, name = reportIdentity(pdf).name, settings: Settings) => {
  const identity = reportIdentity(pdf);
  const hasName = recognizedValue(name);
  const hasClassroom = Boolean(normalizeCohort(identity.grade, identity.section));
  const warnings = [...pdf.warnings.filter(warning => !/^Se reconocieron \d+ de \d+ casillas|^No se reconocieron notas/.test(warning)), ...reportWarnings(pdf, settings, identity).filter(warning => /^Se reconocieron \d+ de \d+ casillas|^No se reconocieron notas/.test(warning))];
  return warnings.filter(warning => {
    if (/c[oó]digo|a[ñn]o de la libreta no reconocido|revise el per[ií]odo|confirme que corresponde al per[ií]odo/i.test(warning)) return false;
    if (hasName && /apellidos y nombres.*no reconocid/i.test(warning)) return false;
    if (hasClassroom && /grado o secci[oó]n no reconocid|aula reconocida no corresponde/i.test(warning)) return false;
    if (hasName && hasClassroom && /no reconoci[oó] todos los datos del estudiante|necesita reconocer.*aula|necesita.*nombre.*aula/i.test(warning)) return false;
    return true;
  }).map(displayReadWarning);
};
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data as T;
}

export default function ImportPage({ pdfs, students, settings, dataset, onRefresh, onOpenStudent, notify }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const nameSaveRef = useRef<Promise<void>>(Promise.resolve());
  const nameDraftsRef = useRef<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [classroomDraft, setClassroomDraft] = useState<string | null>(null);
  const selected = pdfs.find(p => p.id === selectedId);
  const identity = selected ? reportIdentity(selected) : null;
  const previewAreas = selected ? [...selected.areas.map(area => ({ ...area, definition: settings.areas.find(item => item.id === area.areaId) })), ...(selected.supplementalAreas || []).map(area => ({ ...area, areaId: area.definition.id }))].filter(area => hasActiveGrades(area)) : [];
  const draftName = selected ? nameDrafts[selected.id] ?? identity?.name ?? '' : '';
  const cohort = classroomDraft !== null ? ALLOWED_COHORTS.find(item => item.label === classroomDraft) ?? null : identity && normalizeCohort(identity.grade, identity.section);
  useEffect(() => { setClassroomDraft(null); }, [selected?.id, identity?.grade, identity?.section]);
  const identityComplete = Boolean(recognizedValue(draftName) && cohort);
  const selectedWarnings = selected ? reviewWarnings(selected, draftName, settings) : [];
  const reviewLocked = busy || uploading || settings.closed || !selected || !['pending', 'review'].includes(selected.status);
  const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}dataset=${dataset}`;
  const select = (pdf: PdfRecord) => {
    if (busy || uploading) return;
    setSelectedId(pdf.id);
    setError('');
  };
  const changeName = (name: string) => {
    if (!selected) return;
    const next = { ...nameDraftsRef.current, [selected.id]: name };
    nameDraftsRef.current = next;
    setNameDrafts(next);
  };
  const saveName = () => {
    if (!selected || reviewLocked || draftName === identity?.name) return;
    const pdfId = selected.id;
    const name = draftName;
    nameSaveRef.current = nameSaveRef.current.catch(() => undefined).then(async () => {
      await responseJson<PdfRecord>(await fetch(url(`/api/pdfs/${pdfId}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'identify', name }),
      }));
      if (!mountedRef.current) return;
      await onRefresh();
      if (!mountedRef.current) return;
      if (nameDraftsRef.current[pdfId] === name) {
        const next = { ...nameDraftsRef.current };
        delete next[pdfId];
        nameDraftsRef.current = next;
        setNameDrafts(next);
      }
    }).catch(cause => { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudo guardar el nombre.'); });
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  async function uploadFiles(list: FileList | File[]) {
    if (uploading || busy || settings.closed) return;
    const all = Array.from(list);
    const files = all.filter(file => /\.pdf$/i.test(file.name));
    if (!files.length) { setError('Selecciona uno o varios archivos PDF.'); return; }
    if (all.length !== files.length) notify(`Se omitieron ${all.length - files.length} archivos que no son PDF.`);
    const entries = files.map(file => ({ id: crypto.randomUUID(), name: file.name, state: 'pending' as const }));
    setQueue(entries); setUploading(true); setError('');
    try {
      for (let offset = 0; offset < files.length; offset += 10) {
        const batch = files.slice(offset, offset + 10);
        const ids = new Set<string>(entries.slice(offset, offset + 10).map(item => item.id));
        if (mountedRef.current) setQueue(current => current.map(item => ids.has(item.id) ? { ...item, state: 'processing' } : item));
        const form = new FormData(); batch.forEach(file => form.append('files', file));
        try {
          const result = await responseJson<{ pdfs: PdfRecord[] }>(await fetch(url('/api/pdfs'), { method: 'POST', body: form }));
          if (mountedRef.current) {
            setQueue(current => current.map(item => {
              if (!ids.has(item.id)) return item;
              const record = result.pdfs.find(pdf => pdf.name === item.name);
              return { ...item, state: record?.status === 'failed' ? 'failed' : 'done', error: record?.status === 'failed' ? record.warnings.map(displayReadWarning).join(' ') : undefined };
            }));
            await onRefresh();
            if (mountedRef.current && result.pdfs[0]) select(result.pdfs[0]);
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'No se pudo procesar el lote.';
          if (mountedRef.current) setQueue(current => current.map(item => ids.has(item.id) ? { ...item, state: 'failed', error: message } : item));
        }
      }
      if (mountedRef.current) notify('Procesamiento terminado. Revisa la cola y confirma cada lectura.');
    } finally {
      if (mountedRef.current) {
        setUploading(false);
        if (fileInput.current) fileInput.current.value = '';
        if (folderInput.current) folderInput.current.value = '';
      }
    }
  }
  async function confirmReport() {
    if (!selected || reviewLocked || !identityComplete) return;
    const name = draftName;
    setBusy(true); setError('');
    try {
      await nameSaveRef.current;
      if (!mountedRef.current) return;
      const confirmed = await responseJson<PdfRecord>(await fetch(url(`/api/pdfs/${selected.id}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate', name, grade: cohort!.grade, section: cohort!.section }),
      }));
      if (!mountedRef.current) return;
      await onRefresh();
      if (!mountedRef.current) return;
      notify('Libreta confirmada. Las tres áreas de evaluación están habilitadas; revisa las notas y completa los datos pendientes.');
      if (confirmed.studentId) onOpenStudent(confirmed.studentId);
    } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudo confirmar la libreta.'); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function deleteReport() {
    if (!selected || busy || uploading || settings.closed) return;
    const student = students.find(item => item.id === selected.studentId);
    const message = student
      ? `Eliminar la libreta de ${student.name} también eliminará su ficha, todas sus versiones PDF y sus evaluaciones. Esta acción no se puede deshacer. ¿Eliminar todo?`
      : `¿Eliminar «${selected.name}»? Se borrará este documento. Si tiene una ficha vinculada, también se eliminarán la ficha, todas sus versiones PDF y sus evaluaciones. Esta acción no se puede deshacer.`;
    if (!window.confirm(message)) return;
    setBusy(true); setError('');
    try {
      await nameSaveRef.current;
      if (!mountedRef.current) return;
      await responseJson(await fetch(url(`/api/pdfs/${selected.id}`), { method: 'DELETE' }));
      if (!mountedRef.current) return;
      setSelectedId(null);
      await onRefresh();
      if (!mountedRef.current) return;
      notify('Libreta y datos vinculados eliminados.');
    } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudo eliminar la libreta.'); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  return <div className="import-page">
    <div className="page-heading"><div><p className="eyebrow">CARGA Y REVISIÓN DOCUMENTAL</p><h1>Importación masiva</h1><p className="muted">Importa las libretas de {classroomDescription}. Los estudiantes reconocidos aparecen automáticamente; confirma cada libreta para habilitar su evaluación.</p></div></div>
    {settings.closed && <div className="notice warning">La evaluación está cerrada. Puedes consultar documentos; reabre desde Parámetros para importar o corregir.</div>}
    {error && <div className="notice error" role="alert"><CircleAlert size={18}/>{error}<button className="icon-button" onClick={() => setError('')} aria-label="Cerrar error"><X size={16}/></button></div>}
    <section className={`card import-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
      <div className="upload-icon"><UploadCloud size={32}/></div><h2>Arrastra aquí tus libretas PDF</h2>
      <p className="muted">Selecciona varios archivos a la vez. Lectura de texto y OCR para documentos escaneados.</p>
      <div className="button-row"><button className="button primary" disabled={uploading || busy || settings.closed} onClick={() => fileInput.current?.click()}><Plus size={17}/>{uploading ? 'Procesando documentos…' : 'Seleccionar archivos PDF'}</button><button className="button secondary" disabled={uploading || busy || settings.closed} onClick={() => folderInput.current?.click()}><Files size={17}/>Elegir carpeta</button></div>
      <small className="muted">Procesamiento por lotes de hasta 10 archivos · originales conservados · estudiantes reconocidos automáticamente</small>
      <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={event => event.target.files && void uploadFiles(event.target.files)}/>
      <input ref={folderInput} type="file" accept="application/pdf,.pdf" multiple hidden {...{ webkitdirectory: '' } as Record<string, string>} onChange={event => event.target.files && void uploadFiles(event.target.files)}/>
    </section>
    {queue.length > 0 && <section className="card"><div className="card-header"><h2>Cola de procesamiento</h2><span className="muted">{queue.filter(item => item.state === 'done').length} procesados · {queue.filter(item => item.state === 'pending' || item.state === 'processing').length} pendientes · {queue.filter(item => item.state === 'failed').length} fallidos</span></div><div className="import-queue">{queue.map(item => <div key={item.id} className="import-queue-row">{item.state === 'processing' ? <LoaderCircle className="spin" size={16}/> : item.state === 'done' ? <CircleCheck size={16}/> : item.state === 'failed' ? <CircleAlert size={16}/> : <FileText size={16}/>}<span>{item.name}</span><span className="muted">{item.state === 'processing' ? 'Extrayendo texto / OCR…' : item.state === 'pending' ? 'En espera' : item.state === 'done' ? 'Procesado' : item.error}</span></div>)}</div></section>}
    <section className="card"><div className="card-header"><div><h2>Documentos importados <span className="count-badge">{pdfs.length}</span></h2><p className="muted">Comprueba los apellidos y nombres reconocidos desde el archivo, corrígelos si hace falta y confirma la libreta.</p></div></div>
      {pdfs.length === 0 ? <div className="empty-state"><FileText size={32}/><h3>Aún no hay libretas</h3><p>La primera carga aparecerá aquí con su estado y observaciones.</p></div> : <div className="table-wrap"><table><thead><tr><th>Documento</th><th>Estudiante reconocido</th><th>Estado</th><th>Lectura</th><th></th></tr></thead><tbody>{[...pdfs].reverse().map(pdf => <tr key={pdf.id} className={pdf.id === selectedId ? 'selected' : ''}><td><div className="file-cell"><FileText size={18}/><div><strong>{pdf.name}</strong><small className="muted">{(pdf.size / 1024).toFixed(0)} KB · {new Date(pdf.uploadedAt).toLocaleDateString('es-PE')}</small></div></div></td><td>{(nameDrafts[pdf.id] ?? reportIdentity(pdf).name) || 'Nombre por revisar'}<small className="muted">{normalizeCohort(reportIdentity(pdf).grade, reportIdentity(pdf).section)?.label || 'Aula por revisar'}</small></td><td><span className={`badge ${pdf.status === 'validated' ? 'success' : pdf.status === 'failed' ? 'danger' : 'warning'}`}>{labels[pdf.status]}</span></td><td><span className="muted">{pdf.ocr ? 'OCR' : 'Texto'} · {reviewWarnings(pdf, nameDrafts[pdf.id], settings).length} observaciones</span></td><td><button className="button small secondary" onClick={() => select(pdf)}><Eye size={15}/>Revisar</button></td></tr>)}</tbody></table></div>}
    </section>
    {selected && <section className="card import-review" aria-busy={busy}><div className="card-header"><div><p className="eyebrow">REVISIÓN DE LIBRETA</p><h2>{selected.name}</h2></div><span className={`badge ${selected.status === 'validated' ? 'success' : 'warning'}`}>{labels[selected.status]}</span></div>
      <div className="import-review-grid"><div className="import-original"><a className="button secondary small" href={documentUrl(selected.id, dataset)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Abrir PDF original</a><iframe title={`Documento original: ${selected.name}`} src={documentUrl(selected.id, dataset)}/></div>
      <div className="import-extraction"><h3>Datos del estudiante</h3><label className="field"><span>Apellidos y nombres</span><input value={draftName} maxLength={200} autoComplete="off" disabled={reviewLocked} onChange={event => changeName(event.target.value)} onBlur={saveName} placeholder="Escribe los apellidos y nombres completos" /></label><p className="muted">El nombre se toma del archivo PDF. Puedes completarlo o corregirlo aquí.</p><label className="field import-classroom-field"><span>Aula de la libreta</span><select aria-label="Aula de la libreta" value={cohort?.label ?? ''} disabled={reviewLocked} onChange={event => setClassroomDraft(event.target.value)}><option value="">Seleccionar aula reconocida en el PDF</option>{ALLOWED_COHORTS.map(item => <option key={item.label} value={item.label}>{item.label}</option>)}</select><small>Se reconoce desde el archivo o el PDF. Si falta, selecciónala después de revisar el original.</small></label><dl className="detail-list import-identity"><div><dt>Grado y sección</dt><dd>{cohort?.label || [identity?.grade, identity?.section].filter(Boolean).join(' ') || 'No reconocido'}</dd></div></dl>
      <div className="button-row import-review-actions"><button className="button primary" disabled={reviewLocked || !identityComplete} onClick={() => void confirmReport()}><CircleCheck size={16}/>Confirmar libreta</button><button className="button danger" disabled={busy || uploading || settings.closed} onClick={() => void deleteReport()}><Trash2 size={16}/>Eliminar libreta</button></div>
      {!identityComplete && <p className="notice warning">{!cohort ? `Selecciona el aula de ${classroomDescription} después de revisar el PDF original.` : 'Completa los apellidos y nombres para confirmar la libreta.'}</p>}
      {selected.status === 'validated' && <p className="notice success">Libreta confirmada y evaluación habilitada.</p>}
      {selectedWarnings.length > 0 && <div className="notice warning"><div><strong>Observaciones de lectura</strong><ul>{selectedWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></div>}
      <div className="notice">La confirmación habilita las tres áreas de evaluación. Las notas A se completan automáticamente; B y C quedan pendientes para tu evaluación. Las casillas ilegibles permanecen vacías.</div>
      {previewAreas.length > 0 && <details className="import-grade-preview"><summary>Calificaciones reconocidas · I a III bimestre</summary><div className="table-wrap"><table><thead><tr><th>Área / competencia</th>{ACTIVE_BIMESTERS.map(bimester => <th key={bimester}>{bimester}</th>)}</tr></thead><tbody>{previewAreas.flatMap(area => { const definition = area.definition; return area.grades.map((grades, index) => <tr key={`${area.areaId}-${index}`}><td><strong>{definition?.name || area.areaId}</strong><small className="muted">{definition?.competencies[index] || `Competencia ${index + 1}`}</small></td>{ACTIVE_BIMESTERS.map((_, bimester) => <td key={bimester}><span className={`badge ${grades[bimester] ? '' : 'warning'}`}>{grades[bimester] || '—'}</span></td>)}</tr>); })}</tbody></table></div></details>}
      <details><summary>Texto original extraído</summary><pre className="extracted-text">{selected.text || 'No se pudo reconocer texto en este documento.'}</pre></details>
      </div></div>
    </section>}
  </div>;
}
