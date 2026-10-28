import { documentUrl, templateUrl } from './runtime';
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, Files, FileText, CircleCheck, CircleAlert, LoaderCircle, Eye, ExternalLink, Plus, Table2, Download, Trash2, X } from 'lucide-react';
import type { Dataset, PdfRecord, Settings, Student } from '../shared/types';
import { ACTIVE_BIMESTERS, normalizeCohort } from '../shared/policy';

interface Props {
  pdfs: PdfRecord[]; students: Student[]; settings: Settings; dataset: Dataset;
  onRefresh: () => Promise<void>; onOpenStudent: (id: string) => void; notify: (message: string) => void;
}
interface QueuedFile { id: string; name: string; state: 'pending' | 'processing' | 'done' | 'failed'; error?: string }
const labels: Record<PdfRecord['status'], string> = { pending: 'Pendiente', review: 'Por revisar', validated: 'Lectura confirmada', failed: 'Fallido', duplicate: 'Duplicado', replaced: 'Reemplazado' };
const recognizedValue = (value: string, maxLength = 200) => Boolean(value.trim() && value.trim().length <= maxLength && !/^(?:por revisar|por definir|sin c[oó]digo(?: reconocido)?|sin nombre|sin grado|sin secci[oó]n|desconocido|[-—–])$/i.test(value.trim()));
const reportIdentity = (pdf: PdfRecord) => pdf.confirmedIdentity || { code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade, section: pdf.extractedSection };
const displayReadWarning = (warning: string) => warning
  .replace(/:\s*complete la identidad antes de vincular\.?/i, '. La lectura automática no pudo completar la identificación.')
  .replace(/:\s*complételos comparando con el PDF original\.?/i, '. La lectura automática no pudo completar la identificación.')
  .replace(/:\s*confirme el aula comparando con el PDF original\.?/i, '. La lectura automática no pudo reconocer el aula.');
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data as T;
}

export default function ImportPage({ pdfs, students, settings, dataset, onRefresh, onOpenStudent, notify }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const tabularInput = useRef<HTMLInputElement>(null);
  const recoveryAttempts = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tabularResult, setTabularResult] = useState<{ updated: number; errors: unknown[] } | null>(null);
  const selected = pdfs.find(p => p.id === selectedId);
  const identity = selected ? reportIdentity(selected) : null;
  const cohort = identity && normalizeCohort(identity.grade, identity.section);
  const identityComplete = Boolean(identity && recognizedValue(identity.code, 100) && recognizedValue(identity.name) && cohort);
  const reviewLocked = busy || uploading || settings.closed || !selected || !['pending', 'review'].includes(selected.status);
  const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}dataset=${dataset}`;
  const select = (pdf: PdfRecord) => {
    setSelectedId(pdf.id);
    setError('');
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!selected || busy || uploading || settings.closed || ['validated', 'duplicate', 'replaced'].includes(selected.status)) return;
    const recognized = reportIdentity(selected);
    if (recognizedValue(recognized.code, 100) && recognizedValue(recognized.name) && recognizedValue(recognized.grade) && recognizedValue(recognized.section)) return;
    const key = `${dataset}:${selected.id}`;
    if (recoveryAttempts.current.has(key)) return;
    recoveryAttempts.current.add(key);
    setBusy(true); setReadingId(selected.id); setError('');
    void (async () => {
      try {
        await responseJson<PdfRecord>(await fetch(url(`/api/pdfs/${selected.id}`), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reprocess' }),
        }));
        if (!mountedRef.current) return;
        await onRefresh();
      } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudieron reconocer automáticamente los datos de la libreta.'); }
      finally { if (mountedRef.current) { setBusy(false); setReadingId(null); } }
    })();
  }, [selected, busy, uploading, settings.closed, dataset, onRefresh]);
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
          result.pdfs.forEach(pdf => recoveryAttempts.current.add(`${dataset}:${pdf.id}`));
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
    setBusy(true); setError('');
    try {
      const confirmed = await responseJson<PdfRecord>(await fetch(url(`/api/pdfs/${selected.id}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate' }),
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
      ? `Eliminar la libreta de ${student.name} (${student.code}) también eliminará su ficha, todas sus versiones PDF y sus evaluaciones. Esta acción no se puede deshacer. ¿Eliminar todo?`
      : `¿Eliminar «${selected.name}»? Se borrará este documento. Si tiene una ficha vinculada, también se eliminarán la ficha, todas sus versiones PDF y sus evaluaciones. Esta acción no se puede deshacer.`;
    if (!window.confirm(message)) return;
    setBusy(true); setError('');
    try {
      await responseJson(await fetch(url(`/api/pdfs/${selected.id}`), { method: 'DELETE' }));
      if (!mountedRef.current) return;
      setSelectedId(null);
      await onRefresh();
      if (!mountedRef.current) return;
      notify('Libreta y datos vinculados eliminados.');
    } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudo eliminar la libreta.'); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function importRecords(file?: File) {
    if (!file) return;
    setBusy(true); setError(''); setTabularResult(null);
    try {
      const body = new FormData(); body.append('file', file);
      const result = await responseJson<{ updated: number; errors: unknown[] }>(await fetch(url('/api/records/import'), { method: 'POST', body }));
      if (!mountedRef.current) return;
      setTabularResult(result); await onRefresh();
      if (mountedRef.current) notify(`Asistencia importada: ${result.updated} registros actualizados.`);
    } catch (cause) { if (mountedRef.current) setError(cause instanceof Error ? cause.message : 'No se pudo importar la tabla.'); }
    finally { if (mountedRef.current) { setBusy(false); if (tabularInput.current) tabularInput.current.value = ''; } }
  }
  return <div className="import-page">
    <div className="page-heading"><div><p className="eyebrow">CARGA Y REVISIÓN DOCUMENTAL</p><h1>Importación masiva</h1><p className="muted">Importa las libretas de 2.º F, 3.º F y 4.º F. Los estudiantes reconocidos aparecen automáticamente; confirma cada libreta para habilitar su evaluación.</p></div></div>
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
    <section className="card"><div className="card-header"><div><h2>Documentos importados <span className="count-badge">{pdfs.length}</span></h2><p className="muted">Comprueba la identidad extraída del PDF y confirma la libreta para habilitar la ficha.</p></div></div>
      {pdfs.length === 0 ? <div className="empty-state"><FileText size={32}/><h3>Aún no hay libretas</h3><p>La primera carga aparecerá aquí con su estado y observaciones.</p></div> : <div className="table-wrap"><table><thead><tr><th>Documento</th><th>Estudiante reconocido</th><th>Estado</th><th>Lectura</th><th></th></tr></thead><tbody>{[...pdfs].reverse().map(pdf => <tr key={pdf.id} className={pdf.id === selectedId ? 'selected' : ''}><td><div className="file-cell"><FileText size={18}/><div><strong>{pdf.name}</strong><small className="muted">{(pdf.size / 1024).toFixed(0)} KB · {new Date(pdf.uploadedAt).toLocaleDateString('es-PE')}</small></div></div></td><td>{pdf.extractedName || 'Nombre por revisar'}<small className="muted">{pdf.extractedCode || 'Sin código reconocido'}</small></td><td><span className={`badge ${pdf.status === 'validated' ? 'success' : pdf.status === 'failed' ? 'danger' : 'warning'}`}>{labels[pdf.status]}</span></td><td><span className="muted">{pdf.ocr ? 'OCR' : 'Texto'} · {pdf.warnings.length} observaciones</span></td><td><button className="button small secondary" onClick={() => select(pdf)}><Eye size={15}/>Revisar</button></td></tr>)}</tbody></table></div>}
    </section>
    {selected && <section className="card import-review" aria-busy={busy}><div className="card-header"><div><p className="eyebrow">REVISIÓN DE LIBRETA</p><h2>{selected.name}</h2></div><span className={`badge ${selected.status === 'validated' ? 'success' : 'warning'}`}>{labels[selected.status]}</span></div>
      <div className="import-review-grid"><div className="import-original"><a className="button secondary small" href={documentUrl(selected.id, dataset)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Abrir PDF original</a><iframe title={`Documento original: ${selected.name}`} src={documentUrl(selected.id, dataset)}/></div>
      <div className="import-extraction"><h3>Datos reconocidos automáticamente</h3><dl className="detail-list import-identity"><div><dt>Código</dt><dd>{identity?.code || 'No reconocido'}</dd></div><div><dt>Apellidos y nombres</dt><dd>{identity?.name || 'No reconocido'}</dd></div><div><dt>Grado y sección</dt><dd>{cohort?.label || [identity?.grade, identity?.section].filter(Boolean).join(' ') || 'No reconocido'}</dd></div><div><dt>Periodo</dt><dd>{selected.period || 'No reconocido'}</dd></div></dl>
      <div className="button-row import-review-actions"><button className="button primary" disabled={reviewLocked || !identityComplete} onClick={() => void confirmReport()}><CircleCheck size={16}/>Confirmar libreta</button><button className="button danger" disabled={busy || uploading || settings.closed} onClick={() => void deleteReport()}><Trash2 size={16}/>Eliminar libreta</button></div>
      {readingId === selected.id && <div className="notice" role="status" aria-live="polite"><LoaderCircle className="spin" size={18}/>Leyendo automáticamente los datos de la libreta…</div>}
      {readingId !== selected.id && !identityComplete && <p className="notice warning">{identity && recognizedValue(identity.code, 100) && recognizedValue(identity.name) && recognizedValue(identity.grade) && recognizedValue(identity.section) ? 'El aula reconocida está fuera de los grupos admitidos. Solo se admiten 2.º F, 3.º F y 4.º F.' : 'La lectura automática no pudo reconocer todos los datos del estudiante. No se puede confirmar esta libreta sin identificar su código, nombre y aula.'}</p>}
      {selected.status === 'validated' && <p className="notice success">Libreta confirmada y evaluación habilitada.</p>}
      {selected.warnings.length > 0 && <div className="notice warning"><div><strong>Observaciones de lectura</strong><ul>{selected.warnings.map((warning, index) => <li key={index}>{displayReadWarning(warning)}</li>)}</ul></div></div>}
      <div className="notice">La confirmación habilita las tres áreas de evaluación. Las notas A se completan automáticamente; B y C quedan pendientes para tu evaluación. Las casillas ilegibles permanecen vacías.</div>
      {selected.areas.length > 0 && <details className="import-grade-preview"><summary>Calificaciones reconocidas · I a III bimestre</summary><div className="table-wrap"><table><thead><tr><th>Área / competencia</th>{ACTIVE_BIMESTERS.map(bimester => <th key={bimester}>{bimester}</th>)}</tr></thead><tbody>{selected.areas.flatMap(area => { const definition = settings.areas.find(item => item.id === area.areaId); return area.grades.map((grades, index) => <tr key={`${area.areaId}-${index}`}><td><strong>{definition?.name || area.areaId}</strong><small className="muted">{definition?.competencies[index] || `Competencia ${index + 1}`}</small></td>{ACTIVE_BIMESTERS.map((_, bimester) => <td key={bimester}><span className={`badge ${grades[bimester] ? '' : 'warning'}`}>{grades[bimester] || '—'}</span></td>)}</tr>); })}</tbody></table></div></details>}
      <details><summary>Texto original extraído</summary><pre className="extracted-text">{selected.text || 'No se pudo reconocer texto en este documento.'}</pre></details>
      </div></div>
    </section>}
    <section className="card import-tabular"><div className="card-header"><div><p className="eyebrow">REGISTROS REPETITIVOS</p><h2><Table2 size={21}/> Importar asistencia</h2><p className="muted">Usa el código del estudiante para actualizar días lectivos, eximidos, asistencias e ingresos puntuales.</p></div></div><div className="button-row"><a className="button secondary" href={templateUrl(dataset)} download="Plantilla_asistencia.csv"><Download size={16}/>Descargar plantilla CSV</a><button className="button secondary" disabled={busy || settings.closed} onClick={() => tabularInput.current?.click()}><UploadCloud size={16}/>Importar Excel o CSV</button></div><input ref={tabularInput} type="file" accept=".csv,.xlsx" hidden onChange={event => void importRecords(event.target.files?.[0])}/><p className="muted">Las filas importadas quedan sin validar. Las incidencias y compromisos se registran en la ficha para conservar fecha y evidencia.</p>{tabularResult && <div className="notice"><div><strong>{tabularResult.updated} registros actualizados</strong>{tabularResult.errors.length > 0 && <ul>{tabularResult.errors.map((issue, index) => <li key={index}>{typeof issue === 'string' ? issue : JSON.stringify(issue)}</li>)}</ul>}</div></div>}</section>
  </div>;
}
