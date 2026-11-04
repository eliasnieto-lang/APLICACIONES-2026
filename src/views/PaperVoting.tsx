import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, Download, FilePlus2, Printer, RefreshCw, Upload, X } from 'lucide-react';
import type { Area, Block, State, ViewProps } from '../../shared/types';
import type { PaperPoll } from '../../shared/paper-vote';
import type { PresentationRanking } from '../../shared/jornada';
import { AREAS, BLOCKS } from '../../shared/domain';
import { buildPaperVotingPdf } from '../paper-reports';
import { scanPaperBallot } from '../paper-scan';
import { downloadBytes } from '../reports';

type PaperState = State & { paperPolls?: PaperPoll[]; presentationRanking?: PresentationRanking & { stale?: boolean } };
type Choices = Partial<Record<Area, string | null | '__invalid__'>>;
type ReadStatus = 'analyzing' | 'review' | 'submitting' | 'accepted' | 'duplicate' | 'error' | 'rejected';
interface Reading {
  id: string; name: string; previewUrl: string; status: ReadStatus;
  code: string; pollId: string | null; choices: Choices; reasons: string[]; error: string;
  reviewed: boolean;
}
interface PrintBatch { poll: PaperPoll; codes: string[]; bytes?: Uint8Array; url?: string }
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_BATCH_PHOTOS = 100;
const MAX_BATCH_BYTES = 80 * 1024 * 1024;
const areaName = (area: Area) => AREAS.find(item => item.id === area)?.label ?? area;
const categoryName = (block: Block) => BLOCKS.find(item => item.id === block)?.label ?? block;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'No se pudo confirmar la operación.';
const statusName: Record<ReadStatus, string> = { analyzing: 'Leyendo foto', review: 'Revisión necesaria', submitting: 'Guardando', accepted: 'Contada', duplicate: 'Ya había sido contada', error: 'Sin confirmar', rejected: 'No se puede leer' };
const choiceName = (poll: PaperPoll, area: Area, value: string | null | undefined) => value === null ? 'En blanco' : value === '__invalid__' ? 'Nulo' : value === undefined ? 'Pendiente de revisar' : poll.options[area]?.find(option => option.id === value)?.name ?? 'Opción desconocida';
function validChoices(poll: PaperPoll, choices: Choices) { return poll.areas.every(area => Object.hasOwn(choices, area) && (choices[area] === null || choices[area] === '__invalid__' || poll.options[area]?.some(option => option.id === choices[area]))); }
function isDuplicate(error: unknown) { return /ya (?:ha |había |fue )?(?:sido )?(?:registrad|recibid|contad|contabilizad|procesad)|cédula.*(?:usad|consumid)|duplicad/i.test(messageOf(error)); }

export default function PaperVoting({ snapshot, api, refresh, notify }: ViewProps) {
  const state = snapshot.state as PaperState;
  const rank = state.presentationRanking;
  const [block, setBlock] = useState<Block>('P1');
  const areas: Area[] = ['MAT', 'COM'];
  const [selectedId, setSelectedId] = useState(() => state.paperPolls?.find(poll => poll.status === 'open')?.id ?? state.paperPolls?.at(-1)?.id ?? '');
  const [updatedPolls, setUpdatedPolls] = useState<Record<string, PaperPoll>>({});
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [autoProcess, setAutoProcess] = useState(true);
  const [count, setCount] = useState('20');
  const [error, setError] = useState('');
  const [readings, setReadings] = useState<Reading[]>([]);
  const [printBatch, setPrintBatch] = useState<PrintBatch | null>(null);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reviewedSamples, setReviewedSamples] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const autoRef = useRef(autoProcess);
  const urlRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Set<string>());
  const printRef = useRef<PrintBatch | null>(null);
  autoRef.current = autoProcess;
  printRef.current = printBatch;
  const polls = [...(state.paperPolls ?? [])];
  for (const poll of Object.values(updatedPolls)) {
    const index = polls.findIndex(item => item.id === poll.id);
    if (index < 0) polls.push(poll); else if (poll.version >= polls[index].version) polls[index] = poll;
  }
  const poll = polls.find(item => item.id === selectedId);
  const coordinator = snapshot.actor.role === 'coordinator';
  const locked = busy || processing;
  const pending = readings.filter(item => ['review', 'error', 'analyzing', 'submitting'].includes(item.status)).length;
  const rankingReady = !!rank && !rank.provisional && !rank.stale;
  const configuredAreasReady = areas.length > 0 && areas.every(area => (rank?.categories.find(category => category.area === area && category.block === block)?.ranked.filter(row => row.score !== null).length ?? 0) >= 2);

  useEffect(() => {
    if (!selectedId && polls.length) setSelectedId(polls.find(item => item.status === 'open')?.id ?? polls.at(-1)!.id);
  }, [selectedId, state.paperPolls, updatedPolls]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; for (const url of urlRef.current) URL.revokeObjectURL(url); urlRef.current.clear(); };
  }, []);
  useEffect(() => { setConfirmClose(false); }, [selectedId, poll?.version]);

  function keepUrl(blob: Blob) { const url = URL.createObjectURL(blob); urlRef.current.add(url); return url; }
  function dropUrl(url?: string) { if (url) { URL.revokeObjectURL(url); urlRef.current.delete(url); } }
  function rememberPoll(value: PaperPoll) { if (mountedRef.current) setUpdatedPolls(current => ({ ...current, [value.id]: value })); }
  function changeReading(id: string, values: Partial<Reading>) { if (mountedRef.current) setReadings(current => current.map(item => item.id === id ? { ...item, ...values } : item)); }
  async function sync() { try { await refresh(); } catch { notify('La operación ya fue confirmada. No se pudo actualizar la vista; use Actualizar.', true); } }
  function clearReadings() { if (activeRef.current) return; for (const item of readings) dropUrl(item.previewUrl); setReadings([]); }
  function choosePoll(id: string) { if (activeRef.current || busy) return; clearReadings(); setSelectedId(id); setError(''); setConfirmClose(false); }

  async function createPoll() {
    if (!rank || !rankingReady || !configuredAreasReady || !reviewedSamples) return;
    setBusy(true); setError('');
    try {
      const result = await api.call<PaperPoll>('paper_poll_create', { block, areas, rankingId: rank.id, expectedRankingVersion: rank.version });
      rememberPoll(result); clearReadings(); setSelectedId(result.id); setReviewedSamples(false); await sync();
      notify('Votación en papel preparada. Genere e imprima las fichas A5 para entregarlas a las familias.');
    } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function preparePdf(batch: PrintBatch) {
    const bytes = await buildPaperVotingPdf(state, batch.poll, batch.codes, { demo: snapshot.dataset === 'demo', generatedAt: new Date().toISOString() });
    const url = keepUrl(new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }));
    if (!mountedRef.current) { dropUrl(url); return; }
    dropUrl(printRef.current?.url);
    setPdfLoaded(false); setPrintBatch({ ...batch, bytes, url });
  }
  async function generate() {
    const amount = Number(count);
    if (!poll || poll.status !== 'open' || !Number.isInteger(amount) || amount < 1 || amount > 200) return;
    setBusy(true); setError('');
    try {
      const result = await api.call<{ poll: PaperPoll; codes: string[] }>('paper_ballots_generate', { pollId: poll.id, expectedVersion: poll.version, count: amount });
      rememberPoll(result.poll);
      const batch = { poll: result.poll, codes: result.codes };
      dropUrl(printRef.current?.url); setPrintBatch(batch); printRef.current = batch;
      await preparePdf(batch); await sync(); notify(`${result.codes.length} fichas A5 listas. Imprima a tamaño real, sin recortar las marcas ni el QR.`);
    } catch (problem) { setError(`${messageOf(problem)}${printRef.current && !printRef.current.bytes ? ' Puede reintentar preparar el mismo PDF sin generar fichas nuevas.' : ''}`); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function retryPdf() {
    if (!printBatch) return;
    setBusy(true); setError('');
    try { await preparePdf(printBatch); } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  function print() {
    if (!printBatch?.url || !pdfLoaded) return;
    try { const win = frameRef.current?.contentWindow; if (!win) throw new Error(); win.focus(); win.print(); }
    catch { window.open(printBatch.url, '_blank', 'noopener,noreferrer'); }
  }

  async function cast(row: Reading, selectedPoll: PaperPoll, manual: boolean) {
    if (inFlightRef.current.has(row.id)) return;
    if (selectedPoll.status !== 'open') return changeReading(row.id, { status: 'error', error: 'Esta votación ya está cerrada.' });
    if (!row.code.trim() || !validChoices(selectedPoll, row.choices) || (row.pollId && row.pollId !== selectedPoll.id)) return changeReading(row.id, { status: 'review', error: 'Revise el código y una respuesta de cada área. La foto debe corresponder a esta votación.' });
    if (manual && !row.reviewed) return changeReading(row.id, { status: 'review', error: 'Confirme que comparó la lectura con el papel original.' });
    inFlightRef.current.add(row.id);
    changeReading(row.id, { status: 'submitting', error: '' });
    try {
      const result = await api.call<{ poll: PaperPoll; accepted: boolean }>('paper_scan_cast', { pollId: selectedPoll.id, code: row.code.trim(), choices: row.choices });
      if (!result.accepted) throw new Error('El servidor no confirmó la recepción de esta ficha.');
      rememberPoll(result.poll); changeReading(row.id, { status: 'accepted', code: '', reviewed: false, reasons: [] });
      await sync();
    } catch (problem) {
      const duplicate = isDuplicate(problem);
      changeReading(row.id, { status: duplicate ? 'duplicate' : 'error', error: duplicate ? 'La ficha ya fue registrada; esta foto no añadió votos.' : messageOf(problem), ...(duplicate ? { code: '' } : {}) });
      if (duplicate) await sync();
    } finally { inFlightRef.current.delete(row.id); }
  }
  async function confirmReading(row: Reading, selectedPoll: PaperPoll) {
    if (busy || activeRef.current) return;
    setBusy(true);
    try { await cast(row, selectedPoll, true); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function loadPhotos(files: FileList | File[]) {
    if (!poll || poll.status !== 'open' || activeRef.current || busy) return;
    const batch = Array.from(files);
    if (!batch.length) return;
    if (batch.length > MAX_BATCH_PHOTOS) { setError(`Seleccione como máximo ${MAX_BATCH_PHOTOS} fotos por lote.`); return; }
    if (batch.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) { setError('El lote supera 80 MB. Cargue las fotos en grupos más pequeños.'); return; }
    activeRef.current = true; setProcessing(true); setError('');
    const selectedPoll = poll;
    try {
      for (const file of batch) {
        if (!mountedRef.current) break;
        const row: Reading = { id: crypto.randomUUID(), name: file.name, previewUrl: '', status: 'analyzing', code: '', pollId: null, choices: {}, reasons: [], error: '', reviewed: false };
        const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
        if (!allowed || !file.size || file.size > MAX_PHOTO_BYTES) {
          row.status = 'rejected'; row.error = !allowed ? 'Use una foto JPEG, PNG o WebP.' : 'La foto debe pesar hasta 12 MB y contener una imagen.';
          setReadings(current => [...current, row]); continue;
        }
        row.previewUrl = keepUrl(file); setReadings(current => [...current, row]);
        try {
          const result = await scanPaperBallot(file, selectedPoll, snapshot.dataset);
          if (!mountedRef.current) break;
          const samePoll = !result.pollId || result.pollId === selectedPoll.id;
          const complete = validChoices(selectedPoll, result.choices);
          const ready: Reading = { ...row, code: result.code ?? '', pollId: result.pollId, choices: result.choices, reasons: [...result.reasons], status: 'review' };
          if (!samePoll) ready.reasons.push('El QR pertenece a otra votación. Seleccione la votación correcta y vuelva a cargar la foto.');
          if (!result.code) ready.reasons.push('No se pudo leer el código. Escríbalo desde la ficha original.');
          if (!complete) ready.reasons.push('Complete la revisión de todas las áreas.');
          changeReading(row.id, ready);
          if (!result.needsReview && samePoll && result.code && complete && autoRef.current) await cast(ready, selectedPoll, false);
        } catch (problem) { changeReading(row.id, { status: 'review', reasons: ['No se pudo completar la lectura automática. Revise el papel original.'], error: messageOf(problem) }); }
      }
    } finally {
      activeRef.current = false;
      if (mountedRef.current) setProcessing(false);
      if (inputRef.current) inputRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  }
  async function closePoll() {
    if (!poll || !confirmClose || pending || activeRef.current) return;
    setBusy(true); setError('');
    try { const result = await api.call<PaperPoll>('paper_poll_close', { pollId: poll.id, expectedVersion: poll.version }); rememberPoll(result); await sync(); notify('Recepción cerrada. El resultado distingue ganadores, empates, blancos y nulos.'); }
    catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  const removeReading = (row: Reading) => { if (['analyzing', 'submitting'].includes(row.status)) return; dropUrl(row.previewUrl); setReadings(current => current.filter(item => item.id !== row.id)); };

  if (!coordinator) return <section className="card"><h1>Votación familiar en papel</h1><p>La generación y lectura de fichas corresponde a Subdirección.</p></section>;
  return <div className="paper-voting stack"><style>{paperStyles}</style>
    <div><span className="eyebrow">ELECCIÓN DE LAS FAMILIAS</span><h1>Votación en papel</h1><p className="muted">Imprima fichas A5, lea sus fotos y revise el escrutinio de cada área.</p></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <details open={!polls.length}><summary>Preparar votación desde el ranking final</summary><div className="stack">
      {!rankingReady && <div className="notice warning">Primero complete las presentaciones y las fichas docentes y genere el ranking final en <strong>Ranking / Top</strong>. Un ranking provisional o desactualizado no abre la votación.</div>}
      <div className="field-row"><label className="field">Categoría de la votación<select aria-label="Categoría de la votación" disabled={locked} value={block} onChange={event => setBlock(event.target.value as Block)}>{BLOCKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><div className="notice"><strong>Matemática y Comunicación</strong><br />Ambas áreas en una misma ficha A5, para esta categoría.</div></div>
      <p className="muted">Se usarán hasta las tres primeras editoriales del ranking de cada área y categoría. La ficha no pide nombre ni sección del votante.</p>
      {areas.length > 0 && <div className="grid">{areas.map(area => { const category = rank?.categories.find(item => item.area === area && item.block === block); return <div key={area}><h3>{areaName(area)}</h3><ol>{category?.ranked.filter(item => item.score !== null).slice(0, 3).map(item => <li key={item.publisherId}>{state.publishers.find(publisher => publisher.id === item.publisherId)?.name ?? item.publisherId}</li>)}</ol>{(category?.ranked.filter(item => item.score !== null).length ?? 0) < 2 && <p className="notice warning">Se necesitan al menos dos editoriales valoradas para esta área.</p>}</div>; })}</div>}
      <label><input type="checkbox" disabled={locked} checked={reviewedSamples} onChange={event => setReviewedSamples(event.target.checked)} />Confirmo que las familias pudieron revisar los ejemplares físicos y que estas son las opciones que se imprimirán.</label>
      <button className="primary" disabled={locked || !rankingReady || !configuredAreasReady || !reviewedSamples} onClick={() => void createPoll()}><FilePlus2 size={18} />Crear votación en papel</button>
    </div></details>
    <section className="card stack"><div className="row between"><h2>Fichas y recepción</h2><button disabled={locked} onClick={() => void sync()}><RefreshCw size={16} />Actualizar</button></div>
      <label className="field">Votación<select aria-label="Votación" disabled={locked} value={selectedId} onChange={event => choosePoll(event.target.value)}><option value="">Seleccione una votación</option>{polls.map(item => <option key={item.id} value={item.id}>{categoryName(item.block)} · {item.areas.map(areaName).join(' y ')} · {item.status === 'open' ? 'Abierta' : 'Cerrada'} · {new Date(item.createdAt).toLocaleString('es-PE')}</option>)}</select></label>
      {!poll && <div className="empty-state">Cree una votación para generar sus fichas.</div>}
      {poll && <><div className="paper-stats"><span><strong>{poll.generated}</strong> fichas generadas</span><span><strong>{poll.received}</strong> fichas recibidas</span><span className={`status ${poll.status === 'open' ? 'pending' : 'closed'}`}>{poll.status === 'open' ? 'Recepción abierta' : 'Recepción cerrada'}</span></div>
        {poll.status === 'open' && <><div className="paper-print-controls"><label className="field">Cantidad de fichas A5<input type="number" min={1} max={200} step={1} value={count} disabled={locked} onChange={event => setCount(event.target.value)} /></label><button className="primary" disabled={locked || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 200} onClick={() => void generate()}><Printer size={18} />Generar fichas A5</button></div><p className="muted">Cada ficha tiene un código anónimo de un solo uso. Imprima a tamaño real (100 %), con las cuatro esquinas y el QR completos. No fotocopie la misma ficha para distintos votos.</p></>}
        {printBatch && printBatch.poll.id === poll.id && <section className="paper-print-preview stack" aria-label="Fichas A5 preparadas"><div className="row between"><h3>{printBatch.codes.length} fichas A5 preparadas</h3><button className="secondary" disabled={locked} onClick={() => { dropUrl(printBatch.url); setPrintBatch(null); }}><X size={16} />Cerrar PDF</button></div>{printBatch.bytes && printBatch.url ? <><div className="row"><button disabled={locked || !pdfLoaded} onClick={print}><Printer size={18} />Imprimir fichas A5</button><button disabled={locked} onClick={() => downloadBytes(printBatch.bytes!, `fichas-A5-${poll.block}.pdf`, 'application/pdf')}><Download size={18} />Descargar PDF A5</button><a href={printBatch.url} target="_blank" rel="noreferrer">Abrir PDF</a></div><iframe ref={frameRef} src={printBatch.url} onLoad={() => setPdfLoaded(true)} title="Vista previa de las fichas A5" /></> : <><p>Los códigos ya fueron generados. Prepare el mismo archivo para no emitir fichas nuevas.</p><button disabled={locked} onClick={() => void retryPdf()}>Reintentar preparar PDF</button></>}</section>}
        {poll.status === 'open' && <section className="paper-upload stack"><h3>Cargar y leer fotos</h3><p>Fotografíe una ficha completa por imagen, sobre una superficie lisa y bien iluminada. Las fotos se analizan en este dispositivo; se envían únicamente los votos y el código anónimo.</p><label><input type="checkbox" checked={autoProcess} onChange={event => setAutoProcess(event.target.checked)} disabled={locked} />Registrar automáticamente las lecturas claras</label><p className="muted">Las lecturas dudosas requieren revisión. El servidor rechaza una ficha ya contada, aunque se fotografíe otra vez.</p><div className="row"><button className="primary" disabled={locked} onClick={() => inputRef.current?.click()}><Upload size={18} />{processing ? 'Procesando fotos…' : 'Cargar fotos de las fichas'}</button><button disabled={locked} onClick={() => cameraRef.current?.click()}><Camera size={18} />Tomar foto</button></div><input className="visually-hidden" disabled={locked} ref={inputRef} aria-label="Archivos de fotos para leer" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event => { if (event.target.files) void loadPhotos(event.target.files); }} /><input className="visually-hidden" disabled={locked} ref={cameraRef} aria-label="Archivo de foto tomada con cámara" type="file" capture="environment" accept="image/jpeg,image/png,image/webp" onChange={event => { if (event.target.files) void loadPhotos(event.target.files); }} /><small>JPEG, PNG o WebP · hasta 12 MB por foto · hasta {MAX_BATCH_PHOTOS} fotos por lote (80 MB en total).</small></section>}
        <section className="stack" aria-label="Resultados de la votación"><h3>Resultado por área</h3><p className="muted">Cada ficha recibida suma una respuesta por área. Las casillas sin marcar son votos en blanco; varias opciones marcadas son nulos.</p><div className="grid">{poll.areas.map(area => { const counts = poll.counts[area]; const result = poll.results[area]; const resultText = result?.state === 'winner' ? `Mayoría: ${poll.options[area]?.find(item => item.id === result.winnerId)?.name ?? 'opción ganadora'}` : result?.state === 'tie' ? `Empate: ${(result.tiedIds ?? []).map(id => poll.options[area]?.find(item => item.id === id)?.name ?? id).join(' / ')}` : result?.state === 'no_valid_votes' ? 'Sin votos válidos para determinar una mayoría.' : 'Conteo provisional · recepción abierta'; return <div className="card stack" key={area}><h3>{areaName(area)}</h3><div className="table-wrap"><table><thead><tr><th>Editorial</th><th>Votos</th></tr></thead><tbody>{poll.options[area]?.map(option => <tr key={option.id}><td>{option.name}</td><td>{counts?.options[option.id] ?? 0}</td></tr>)}<tr><td>En blanco</td><td>{counts?.blank ?? 0}</td></tr><tr><td>Nulos</td><td>{counts?.invalid ?? 0}</td></tr></tbody></table></div><strong>{resultText}</strong></div>; })}</div></section>
        {!!readings.length && <section className="stack" aria-label="Lecturas de las fotos"><div className="row between"><h3>Lecturas de este dispositivo</h3><button disabled={locked} onClick={clearReadings}>Limpiar lista de fotos</button></div><p className="muted">{readings.filter(item => item.status === 'accepted').length} contadas ahora · {readings.filter(item => item.status === 'duplicate').length} repetidas · {pending} por revisar o confirmar.</p>{readings.map(row => <article className="paper-reading card stack" key={row.id}><div className="row between"><div><strong>{row.name}</strong><br /><span className={`status ${row.status === 'accepted' ? 'closed' : ['review', 'error', 'rejected'].includes(row.status) ? 'pending' : ''}`}>{row.status === 'accepted' && <CheckCircle2 size={13} />}{statusName[row.status]}</span></div><button aria-label={`Quitar ${row.name} de la lista`} disabled={locked || ['analyzing', 'submitting'].includes(row.status)} onClick={() => removeReading(row)}><X size={16} /></button></div><div className="paper-reading-layout">{row.previewUrl && <a href={row.previewUrl} target="_blank" rel="noreferrer"><img src={row.previewUrl} alt={`Foto de la ficha ${row.name}`} /></a>}<div className="stack">{row.reasons.length > 0 && <ul className="paper-reading-reasons">{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}{row.error && <div className="notice danger" role="alert">{row.error}</div>}{['review', 'error'].includes(row.status) && poll.status === 'open' ? <><label className="field">Código anónimo de la ficha<input value={row.code} autoComplete="off" spellCheck={false} disabled={locked} onChange={event => changeReading(row.id, { code: event.target.value, reviewed: false })} /></label>{poll.areas.map(area => <label className="field" key={area}>{areaName(area)} · lectura<select aria-label={`${areaName(area)} · lectura`} value={Object.hasOwn(row.choices, area) ? row.choices[area] === null ? '__blank__' : row.choices[area] : '__pending__'} disabled={locked} onChange={event => changeReading(row.id, { choices: { ...row.choices, [area]: event.target.value === '__blank__' ? null : event.target.value }, reviewed: false })}><option value="__pending__">Seleccione después de revisar</option>{poll.options[area]?.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}<option value="__blank__">En blanco</option><option value="__invalid__">Nulo · varias marcas o voto no válido</option></select></label>)}<label><input type="checkbox" checked={row.reviewed} disabled={locked} onChange={event => changeReading(row.id, { reviewed: event.target.checked })} />Comparé esta lectura con la ficha original.</label><button className="primary" disabled={locked || !row.reviewed || !row.code.trim() || !validChoices(poll, row.choices) || !!row.pollId && row.pollId !== poll.id} onClick={() => void confirmReading(row, poll)}>Confirmar y contar esta ficha</button></> : row.status !== 'rejected' && <ul>{poll.areas.map(area => <li key={area}><strong>{areaName(area)}:</strong> {choiceName(poll, area, row.choices[area])}</li>)}</ul>}</div></div></article>)}</section>}
        {poll.status === 'open' && <section className="notice stack"><strong>Cerrar recepción</strong><p>Revise todos los papeles y las incidencias antes de cerrar. Después no se aceptarán más fichas en esta votación.</p>{pending > 0 && <p>Hay {pending} lecturas sin resolver en este dispositivo. Revise o retire esas fotos de la lista antes de cerrar.</p>}<label><input type="checkbox" disabled={locked || pending > 0} checked={confirmClose} onChange={event => setConfirmClose(event.target.checked)} />Confirmo que terminó la recepción y revisé el escrutinio.</label><button className="danger" disabled={locked || pending > 0 || !confirmClose} onClick={() => void closePoll()}>Cerrar votación y calcular resultado</button></section>}
      </>}
    </section>
  </div>;
}

const paperStyles = `
.paper-voting{min-width:0}.paper-voting h2,.paper-voting h3{margin-bottom:0}.paper-voting table{min-width:0;width:100%;table-layout:fixed}.paper-voting th:last-child,.paper-voting td:last-child{width:64px;text-align:right;white-space:nowrap}.paper-voting td:first-child{overflow-wrap:anywhere}.paper-voting th,.paper-voting td{padding:10px 8px}.paper-area-options{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.paper-area-options label{font-weight:500}.paper-stats{display:flex;gap:24px;flex-wrap:wrap;align-items:center;color:var(--muted)}.paper-stats strong{font-size:21px;color:var(--ink);margin-right:5px}.paper-print-controls{display:flex;gap:15px;align-items:flex-end;flex-wrap:wrap}.paper-print-controls .field{width:180px}.paper-print-preview{border:1px solid var(--line);border-radius:10px;padding:18px;background:#f7f9fc}.paper-print-preview iframe{width:100%;height:450px;border:1px solid var(--line);border-radius:8px;background:#fff}.paper-upload{padding:20px;border:1px dashed #9cb3ce;border-radius:10px;background:#f6faff}.paper-reading{padding:18px}.paper-reading-layout{display:grid;grid-template-columns:minmax(150px,260px) 1fr;gap:20px;align-items:start}.paper-reading-layout img{display:block;max-width:100%;max-height:340px;object-fit:contain;border:1px solid var(--line);border-radius:7px;background:#f4f6f9}.paper-reading-layout .field{min-width:0}.paper-reading-reasons{padding-left:19px;margin:0;font-size:13px;color:#876329}.paper-voting .notice p:last-child{margin-bottom:0}@media(max-width:680px){.paper-reading-layout{grid-template-columns:1fr}.paper-reading-layout img{max-height:260px}.paper-stats{gap:12px}.paper-print-controls{align-items:stretch;flex-direction:column}.paper-print-controls .field{width:100%}.paper-print-preview iframe{height:330px}.paper-voting h1{font-size:27px}}
`;
