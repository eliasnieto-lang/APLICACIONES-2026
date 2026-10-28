import { documentUrl, templateUrl } from './runtime';
import { useRef, useState } from 'react';
import { UploadCloud, Files, FileText, CircleCheck, CircleAlert, LoaderCircle, Eye, ExternalLink, Link2, Plus, Table2, Download, X } from 'lucide-react';
import type { Dataset, PdfRecord, Settings, Student } from '../shared/types';

interface Props {
  pdfs: PdfRecord[]; students: Student[]; settings: Settings; dataset: Dataset;
  onRefresh: () => Promise<void>; onOpenStudent: (id: string) => void; notify: (message: string) => void;
}
interface QueuedFile { id: string; name: string; state: 'pending' | 'processing' | 'done' | 'failed'; error?: string }
const labels: Record<PdfRecord['status'], string> = { pending: 'Pendiente', review: 'Por revisar', validated: 'Lectura confirmada', failed: 'Fallido', duplicate: 'Duplicado', replaced: 'Reemplazado' };
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data as T;
}

export default function ImportPage({ pdfs, students, settings, dataset, onRefresh, onOpenStudent, notify }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const tabularInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [newStudent, setNewStudent] = useState({ code: '', name: '', grade: '', section: '' });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tabularResult, setTabularResult] = useState<{ updated: number; errors: unknown[] } | null>(null);
  const selected = pdfs.find(p => p.id === selectedId);
  const target = students.find(s => s.id === targetId);
  const mismatch = !!selected?.extractedCode && !!target && selected.extractedCode.trim().toUpperCase() !== target.code.trim().toUpperCase();
  const url = (path: string) => `${path}${path.includes('?') ? '&' : '?'}dataset=${dataset}`;
  const select = (pdf: PdfRecord) => {
    setSelectedId(pdf.id);
    setTargetId(pdf.studentId || students.find(s => s.code.trim().toUpperCase() === pdf.extractedCode.trim().toUpperCase())?.id || '');
    setNewStudent({ code: pdf.extractedCode, name: pdf.extractedName, grade: pdf.extractedGrade, section: pdf.extractedSection });
    setConfirmMismatch(false); setCreating(false); setReplacementId(''); setError('');
  };
  async function uploadFiles(list: FileList | File[]) {
    if (uploading || settings.closed) return;
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
        setQueue(current => current.map(item => ids.has(item.id) ? { ...item, state: 'processing' } : item));
        const form = new FormData(); batch.forEach(file => form.append('files', file));
        try {
          const result = await responseJson<{ pdfs: PdfRecord[] }>(await fetch(url('/api/pdfs'), { method: 'POST', body: form }));
          setQueue(current => current.map(item => {
            if (!ids.has(item.id)) return item;
            const record = result.pdfs.find(pdf => pdf.name === item.name);
            return { ...item, state: record?.status === 'failed' ? 'failed' : 'done', error: record?.status === 'failed' ? record.warnings.join(' ') : undefined };
          }));
          await onRefresh();
          if (result.pdfs[0]) select(result.pdfs[0]);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'No se pudo procesar el lote.';
          setQueue(current => current.map(item => ids.has(item.id) ? { ...item, state: 'failed', error: message } : item));
        }
      }
      notify('Procesamiento terminado. Revisa la cola y confirma cada lectura.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
      if (folderInput.current) folderInput.current.value = '';
    }
  }
  async function link(action: 'link' | 'replace' | 'validate', studentId = targetId) {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await responseJson(await fetch(url(`/api/pdfs/${selected.id}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, studentId, confirmMismatch, ...(action === 'replace' ? { replacesId: replacementId } : {}) }),
      }));
      await onRefresh();
      notify(action === 'validate' ? 'Lectura confirmada. La evaluación se valida desde la ficha.' : 'Libreta vinculada. Las calificaciones quedan pendientes de revisión.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo vincular el documento.'); }
    finally { setBusy(false); }
  }
  async function createAndLink() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const student = await responseJson<Student>(await fetch(url('/api/students'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newStudent) }));
      setTargetId(student.id);
      await responseJson(await fetch(url(`/api/pdfs/${selected.id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'link', studentId: student.id, confirmMismatch: false }) }));
      await onRefresh(); setCreating(false); notify('Estudiante creado y libreta vinculada. Revisa su ficha.');
    } catch (cause) {
      await onRefresh();
      setError(cause instanceof Error ? cause.message : 'No se pudo crear el estudiante.');
    } finally { setBusy(false); }
  }
  async function importRecords(file?: File) {
    if (!file) return;
    setBusy(true); setError(''); setTabularResult(null);
    try {
      const body = new FormData(); body.append('file', file);
      const result = await responseJson<{ updated: number; errors: unknown[] }>(await fetch(url('/api/records/import'), { method: 'POST', body }));
      setTabularResult(result); await onRefresh(); notify(`Asistencia importada: ${result.updated} registros actualizados.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo importar la tabla.'); }
    finally { setBusy(false); if (tabularInput.current) tabularInput.current.value = ''; }
  }
  return <div className="import-page">
    <div className="page-heading"><div><p className="eyebrow">CARGA Y REVISIÓN DOCUMENTAL</p><h1>Importación masiva</h1><p className="muted">Todas las libretas en un solo lugar. Cada lectura permanece pendiente hasta tu confirmación.</p></div></div>
    {settings.closed && <div className="notice warning">La evaluación está cerrada. Puedes consultar documentos; reabre desde Parámetros para importar o corregir.</div>}
    {error && <div className="notice error" role="alert"><CircleAlert size={18}/>{error}<button className="icon-button" onClick={() => setError('')} aria-label="Cerrar error"><X size={16}/></button></div>}
    <section className={`card import-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
      <div className="upload-icon"><UploadCloud size={32}/></div><h2>Arrastra aquí tus libretas PDF</h2>
      <p className="muted">Selecciona varios archivos a la vez. Lectura de texto y OCR para documentos escaneados.</p>
      <div className="button-row"><button className="button primary" disabled={uploading || settings.closed} onClick={() => fileInput.current?.click()}><Plus size={17}/>{uploading ? 'Procesando documentos…' : 'Seleccionar archivos PDF'}</button><button className="button secondary" disabled={uploading || settings.closed} onClick={() => folderInput.current?.click()}><Files size={17}/>Elegir carpeta</button></div>
      <small className="muted">Procesamiento por lotes de hasta 10 archivos · originales conservados · sin fusión automática de estudiantes</small>
      <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={event => event.target.files && void uploadFiles(event.target.files)}/>
      <input ref={folderInput} type="file" accept="application/pdf,.pdf" multiple hidden {...{ webkitdirectory: '' } as Record<string, string>} onChange={event => event.target.files && void uploadFiles(event.target.files)}/>
    </section>
    {queue.length > 0 && <section className="card"><div className="card-header"><h2>Cola de procesamiento</h2><span className="muted">{queue.filter(item => item.state === 'done').length} procesados · {queue.filter(item => item.state === 'pending' || item.state === 'processing').length} pendientes · {queue.filter(item => item.state === 'failed').length} fallidos</span></div><div className="import-queue">{queue.map(item => <div key={item.id} className="import-queue-row">{item.state === 'processing' ? <LoaderCircle className="spin" size={16}/> : item.state === 'done' ? <CircleCheck size={16}/> : item.state === 'failed' ? <CircleAlert size={16}/> : <FileText size={16}/>}<span>{item.name}</span><span className="muted">{item.state === 'processing' ? 'Extrayendo texto / OCR…' : item.state === 'pending' ? 'En espera' : item.state === 'done' ? 'Procesado' : item.error}</span></div>)}</div></section>}
    <section className="card"><div className="card-header"><div><h2>Documentos importados <span className="count-badge">{pdfs.length}</span></h2><p className="muted">Revisa el código y las notas antes de vincular o confirmar la lectura.</p></div></div>
      {pdfs.length === 0 ? <div className="empty-state"><FileText size={32}/><h3>Aún no hay libretas</h3><p>La primera carga aparecerá aquí con su estado y observaciones.</p></div> : <div className="table-wrap"><table><thead><tr><th>Documento</th><th>Estudiante reconocido</th><th>Estado</th><th>Lectura</th><th></th></tr></thead><tbody>{[...pdfs].reverse().map(pdf => <tr key={pdf.id} className={pdf.id === selectedId ? 'selected' : ''}><td><div className="file-cell"><FileText size={18}/><div><strong>{pdf.name}</strong><small className="muted">{(pdf.size / 1024).toFixed(0)} KB · {new Date(pdf.uploadedAt).toLocaleDateString('es-PE')}</small></div></div></td><td>{pdf.extractedName || 'Nombre por revisar'}<small className="muted">{pdf.extractedCode || 'Sin código reconocido'}</small></td><td><span className={`badge ${pdf.status === 'validated' ? 'success' : pdf.status === 'failed' ? 'danger' : 'warning'}`}>{labels[pdf.status]}</span></td><td><span className="muted">{pdf.ocr ? 'OCR' : 'Texto'} · {pdf.warnings.length} observaciones</span></td><td><button className="button small secondary" onClick={() => select(pdf)}><Eye size={15}/>Revisar</button></td></tr>)}</tbody></table></div>}
    </section>
    {selected && <section className="card import-review"><div className="card-header"><div><p className="eyebrow">REVISIÓN DE LIBRETA</p><h2>{selected.name}</h2></div><button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Cerrar revisión"><X size={20}/></button></div>
      <div className="import-review-grid"><div className="import-original"><a className="button secondary small" href={documentUrl(selected.id, dataset)} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Abrir PDF original</a><iframe title={`Documento original: ${selected.name}`} src={documentUrl(selected.id, dataset)}/></div>
      <div className="import-extraction"><h3>Datos reconocidos</h3><dl className="detail-list"><div><dt>Código</dt><dd>{selected.extractedCode || 'Por revisar'}</dd></div><div><dt>Nombres</dt><dd>{selected.extractedName || 'Por revisar'}</dd></div><div><dt>Grado y sección</dt><dd>{[selected.extractedGrade, selected.extractedSection].filter(Boolean).join(' · ') || 'Por revisar'}</dd></div><div><dt>Periodo</dt><dd>{selected.period || 'Por revisar'}</dd></div></dl>
      {selected.warnings.length > 0 && <div className="notice warning"><div><strong>Observaciones de lectura</strong><ul>{selected.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></div>}
      <div className="notice">Las casillas ilegibles quedan en blanco. Vincula la libreta y corrige las calificaciones en la ficha, sin alterar el documento original.</div>
      {selected.areas.length > 0 && <details className="import-grade-preview"><summary>Calificaciones reconocidas · I a IV bimestre</summary><div className="table-wrap"><table><thead><tr><th>Área / competencia</th><th>I</th><th>II</th><th>III</th><th>IV</th></tr></thead><tbody>{selected.areas.flatMap(area => { const definition = settings.areas.find(item => item.id === area.areaId); return area.grades.map((grades, index) => <tr key={`${area.areaId}-${index}`}><td><strong>{definition?.name || area.areaId}</strong><small className="muted">{definition?.competencies[index] || `Competencia ${index + 1}`}</small></td>{[0, 1, 2, 3].map(bimester => <td key={bimester}><span className={`badge ${grades[bimester] ? '' : 'warning'}`}>{grades[bimester] || '—'}</span></td>)}</tr>); })}</tbody></table></div></details>}
      <label className="field">Vincular a estudiante<select value={targetId} disabled={busy || settings.closed || selected.status === 'duplicate' || selected.status === 'replaced'} onChange={event => { setTargetId(event.target.value); setConfirmMismatch(false); setReplacementId(''); }}><option value="">Selecciona un estudiante</option>{students.map(student => <option key={student.id} value={student.id}>{student.code} · {student.name}</option>)}</select></label>
      {mismatch && <label className="notice warning checkbox-row"><input type="checkbox" checked={confirmMismatch} onChange={event => setConfirmMismatch(event.target.checked)}/><span>El código reconocido ({selected.extractedCode}) no coincide con {target?.code}. Revisé el original y confirmo que pertenece a este estudiante.</span></label>}
      {targetId && <label className="field">¿Reemplaza una libreta anterior?<select value={replacementId} onChange={event => setReplacementId(event.target.value)} disabled={settings.closed || busy}><option value="">No: vincular como documento nuevo</option>{pdfs.filter(pdf => pdf.studentId === targetId && pdf.id !== selected.id && pdf.status !== 'duplicate' && pdf.status !== 'replaced').map(pdf => <option key={pdf.id} value={pdf.id}>{pdf.name} · {new Date(pdf.uploadedAt).toLocaleDateString('es-PE')}</option>)}</select><small className="muted">El reemplazo conserva el original y su trazabilidad.</small></label>}
      <div className="button-row"><button className="button primary" disabled={busy || settings.closed || !targetId || (selected.studentId === targetId && !replacementId) || (mismatch && !confirmMismatch) || ['duplicate', 'replaced', 'failed'].includes(selected.status)} onClick={() => void link(replacementId ? 'replace' : 'link')}><Link2 size={16}/>{replacementId ? 'Reemplazar y conservar historial' : selected.studentId === targetId ? 'Libreta ya vinculada' : 'Vincular libreta'}</button><button className="button secondary" disabled={busy || settings.closed || ['duplicate', 'replaced', 'failed'].includes(selected.status)} onClick={() => setCreating(!creating)}><Plus size={16}/>Nuevo estudiante</button></div>
      {selected.studentId && <div className="button-row"><button className="button secondary" onClick={() => onOpenStudent(selected.studentId!)}>Abrir ficha y corregir notas</button><button className="button secondary" disabled={busy || settings.closed || selected.status === 'validated' || selected.status === 'replaced'} onClick={() => void link('validate', selected.studentId!)}><CircleCheck size={16}/>Confirmar lectura</button></div>}
      {creating && <div className="import-create"><h3>Crear estudiante con estos datos</h3><p className="muted">Comprueba la identidad antes de guardar. El código debe ser único.</p><div className="form-grid">{(['code', 'name', 'grade', 'section'] as const).map(key => <label className="field" key={key}>{{ code: 'Código', name: 'Nombres y apellidos', grade: 'Grado', section: 'Sección' }[key]}<input value={newStudent[key]} onChange={event => setNewStudent(current => ({ ...current, [key]: event.target.value }))}/></label>)}</div>{selected.extractedCode && selected.extractedCode.trim().toUpperCase() !== newStudent.code.trim().toUpperCase() && <p className="notice warning">Para corregir un código reconocido, crea la ficha desde Estudiantes y vincúlala confirmando la diferencia.</p>}<button className="button primary" disabled={busy || !newStudent.code.trim() || !newStudent.name.trim() || !newStudent.grade.trim() || !newStudent.section.trim() || (!!selected.extractedCode && selected.extractedCode.trim().toUpperCase() !== newStudent.code.trim().toUpperCase())} onClick={() => void createAndLink()}>Crear y vincular</button></div>}
      <details><summary>Texto original extraído</summary><pre className="extracted-text">{selected.text || 'No se pudo reconocer texto. Consulta el documento original y completa la ficha manualmente.'}</pre></details>
      </div></div>
    </section>}
    <section className="card import-tabular"><div className="card-header"><div><p className="eyebrow">REGISTROS REPETITIVOS</p><h2><Table2 size={21}/> Importar asistencia</h2><p className="muted">Usa el código del estudiante para actualizar días lectivos, eximidos, asistencias e ingresos puntuales.</p></div></div><div className="button-row"><a className="button secondary" href={templateUrl(dataset)} download="Plantilla_asistencia.csv"><Download size={16}/>Descargar plantilla CSV</a><button className="button secondary" disabled={busy || settings.closed} onClick={() => tabularInput.current?.click()}><UploadCloud size={16}/>Importar Excel o CSV</button></div><input ref={tabularInput} type="file" accept=".csv,.xlsx" hidden onChange={event => void importRecords(event.target.files?.[0])}/><p className="muted">Las filas importadas quedan sin validar. Las incidencias y compromisos se registran en la ficha para conservar fecha y evidencia.</p>{tabularResult && <div className="notice"><div><strong>{tabularResult.updated} registros actualizados</strong>{tabularResult.errors.length > 0 && <ul>{tabularResult.errors.map((issue, index) => <li key={index}>{typeof issue === 'string' ? issue : JSON.stringify(issue)}</li>)}</ul>}</div></div>}</section>
  </div>;
}
