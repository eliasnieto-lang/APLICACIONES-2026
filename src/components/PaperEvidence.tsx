import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, RefreshCw, Trash2, X } from 'lucide-react';
import type { Api, ViewProps } from '../../shared/types';
import type { PaperPoll } from '../../shared/paper-vote';

interface Evidence { id: string; pollId: string; classroomId: string; filename: string; mimeType: string; bytes: number; createdAt: string; duplicate?: boolean }
interface EvidenceFile extends Evidence { data: string }
const message = (error: unknown) => error instanceof Error ? error.message : 'No se pudo confirmar la operación.';
const cleanFilename = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150);

async function photoForUpload(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('Elija una foto JPG, PNG o WebP de hasta 12 MB.');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = source; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('No se pudo abrir esa foto.');
    for (const edge of [1600, 1280, 1000, 800]) {
      const ratio = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = canvas.getContext('2d'); if (!context) throw new Error('Este navegador no pudo preparar la foto.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', .82).split(',')[1];
      if (data && Math.floor(data.length * 3 / 4) <= 1024 * 1024) return { filename: cleanFilename(file.name.replace(/\.[^.]*$/, '')) + '.jpg', mimeType: 'image/jpeg', data };
    }
    throw new Error('La foto es demasiado grande. Elija una imagen más pequeña.');
  } catch (error) { throw new Error(error instanceof Error ? error.message : 'No se pudo preparar esa foto.'); }
  finally { URL.revokeObjectURL(source); }
}

function evidenceBlob(file: EvidenceFile) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimeType)) throw new Error('La foto guardada no tiene un formato permitido.');
  const binary = atob(file.data); return new Blob([Uint8Array.from(binary, value => value.charCodeAt(0))], { type: file.mimeType });
}

/** Optional evidence is private and separate from every vote/attendance operation. */
export default function PaperEvidence({ poll, api, notify }: { poll: PaperPoll; api: Api; notify: ViewProps['notify'] }) {
  const [items, setItems] = useState<Evidence[]>([]);
  const [classroomId, setClassroomId] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const input = useRef<HTMLInputElement>(null); const epoch = useRef(0); const previewRef = useRef<string | null>(null);
  const classroom = (id: string) => poll.classrooms?.find(item => item.id === id);
  function clearPreview() { if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = null; setPreview(null); }
  async function load() {
    const current = epoch.current; setError(''); setBusy(true);
    try { const result = await api.call<Evidence[]>('paper_evidence_list', { pollId: poll.id }); if (current === epoch.current) setItems(result); }
    catch (problem) { if (current === epoch.current) setError(message(problem)); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  useEffect(() => {
    epoch.current++; setItems([]); setClassroomId(''); setFile(null); setError(''); clearPreview();
    return () => { epoch.current++; if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = null; };
  }, [poll.id, api.dataset]);
  async function save() {
    if (!file || !classroomId || busy) return;
    const current = epoch.current; setBusy(true); setError('');
    try {
      const prepared = await photoForUpload(file);
      const result = await api.call<Evidence>('paper_evidence_add', { pollId: poll.id, classroomId, ...prepared });
      if (current !== epoch.current) return;
      setItems(previous => previous.some(item => item.id === result.id) ? previous : [...previous, result]); setFile(null); if (input.current) input.current.value = '';
      notify(result.duplicate ? 'Esta foto ya estaba guardada.' : 'Foto de respaldo guardada. Los votos no se modificaron.');
    } catch (problem) { if (current === epoch.current) setError(message(problem)); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  async function open(item: Evidence, download: boolean) {
    const current = epoch.current; setBusy(true); setError('');
    try {
      const result = await api.call<EvidenceFile>('paper_evidence_get', { pollId: poll.id, evidenceId: item.id });
      if (current !== epoch.current) return;
      const url = URL.createObjectURL(evidenceBlob(result));
      if (download) { const link = document.createElement('a'); link.href = url; link.download = cleanFilename(result.filename); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      else { clearPreview(); previewRef.current = url; setPreview({ url, label: `${classroom(item.classroomId)?.label ?? item.classroomId} · ${item.filename}` }); }
    } catch (problem) { if (current === epoch.current) setError(message(problem)); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  async function remove(item: Evidence) {
    const current = epoch.current; setBusy(true); setError('');
    try { await api.call('paper_evidence_delete', { pollId: poll.id, evidenceId: item.id }); if (current === epoch.current) { setItems(previous => previous.filter(entry => entry.id !== item.id)); clearPreview(); notify('Foto eliminada; el voto se conserva.'); } }
    catch (problem) { if (current === epoch.current) setError(message(problem)); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  if (poll.rosterVersion !== 1) return null;
  return <details className="card stack" onToggle={event => { if (event.currentTarget.open && !items.length && !busy) void load(); }}>
    <summary style={{ cursor: 'pointer', fontWeight: 700 }}><ImagePlus size={17} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 7 }} />Fotos de respaldo (opcional)</summary>
    <div className="stack" style={{ marginTop: 16 }}>
      <p>Puede adjuntar las fotos ahora o después, incluso cuando la votación ya esté cerrada. No se leen automáticamente ni cambian los votos registrados.</p>
      <div className="grid"><label className="field">Aula de la ficha<select aria-label="Aula de la ficha" value={classroomId} disabled={busy} onChange={event => setClassroomId(event.target.value)}><option value="">Seleccione el aula</option>{poll.classrooms?.map(item => <option key={item.id} value={item.id}>{item.folio} · {item.label}</option>)}</select></label>
        <label className="field">Foto de respaldo<input ref={input} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }} /></label></div>
      <div className="row"><button type="button" className="primary" disabled={busy || !classroomId || !file} onClick={() => void save()}>{busy ? 'Procesando…' : 'Guardar foto de respaldo'}</button><button type="button" className="secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />Actualizar fotos</button></div>
      {file && <p className="muted">Seleccionada: {file.name}. Falta guardarla.</p>}
      {error && <div className="notice danger" role="alert">{error}</div>}
      <p className="muted">Las fotos son privadas para Subdirección. Descárguelas por separado y consérvelas junto con sus respaldos; el respaldo JSON de la jornada no incluye las imágenes.</p>
      {items.length ? <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{items.map(item => <li key={item.id} style={{ padding: '12px 0', borderTop: '1px solid var(--line)', overflowWrap: 'anywhere' }}><strong>{classroom(item.classroomId)?.folio} · {classroom(item.classroomId)?.label ?? item.classroomId}</strong><p className="muted" style={{ margin: '4px 0 9px' }}>{item.filename} · {new Date(item.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</p><div className="row" style={{ flexWrap: 'wrap' }}><button type="button" disabled={busy} onClick={() => void open(item, false)}>Ver foto</button><button type="button" disabled={busy} onClick={() => void open(item, true)}><Download size={15} />Descargar foto</button><button type="button" disabled={busy} onClick={() => void remove(item)}><Trash2 size={15} />Eliminar foto</button></div></li>)}</ul> : <p className="muted">No hay fotos cargadas en esta vista. Use Actualizar fotos para consultar el respaldo guardado.</p>}
      {preview && <div className="stack"><div className="row"><strong>{preview.label}</strong><button type="button" disabled={busy} aria-label="Cerrar foto" onClick={clearPreview}><X size={16} /></button></div><img src={preview.url} alt={`Respaldo de ${preview.label}`} style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain', alignSelf: 'flex-start' }} /></div>}
    </div>
  </details>;
}
