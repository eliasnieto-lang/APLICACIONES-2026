import PaperEvidence from '../components/PaperEvidence';
import { useEffect, useRef, useState } from 'react';
import { Download, FilePlus2, PencilLine, Printer, RefreshCw, X } from 'lucide-react';
import type { Area, Block, State, ViewProps } from '../../shared/types';
import type { PaperAttendance, PaperBallotsGenerated, PaperClassroom, PaperClassroomBallot, PaperPoll } from '../../shared/paper-vote';
import type { PresentationRanking } from '../../shared/jornada';
import { AREAS, BLOCKS, GRADES } from '../../shared/domain';
import { paperClassroomRoster } from '../../shared/paper-vote';
import { buildPaperVotingPdf } from '../paper-reports';
import { downloadBytes } from '../reports';

type PaperState = State & { paperPolls?: PaperPoll[]; presentationRanking?: PresentationRanking & { stale?: boolean } };
type Choices = Partial<Record<Area, string | null | '__invalid__'>>;
interface PrintBatch { poll: PaperPoll; codes: string[]; ballots?: PaperClassroomBallot[]; bytes?: Uint8Array; url?: string }
const areaName = (area: Area) => AREAS.find(item => item.id === area)?.label ?? area;
const categoryName = (block: Block) => BLOCKS.find(item => item.id === block)?.label ?? block;
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'No se pudo confirmar la operación.';
const choiceName = (poll: PaperPoll, area: Area, value: string | null | undefined) => value === null ? 'En blanco' : value === '__invalid__' ? 'Nulo' : value === undefined ? 'Pendiente' : poll.options[area]?.find(option => option.id === value)?.name ?? 'Opción no disponible';
const attendanceName: Record<PaperAttendance, string> = { pending: 'Pendiente de confirmar', present: 'Con asistencia', absent: 'Sin asistencia' };
function validChoices(poll: PaperPoll, choices: Choices) {
  return poll.areas.every(area => Object.hasOwn(choices, area) && (choices[area] === null || choices[area] === '__invalid__' || poll.options[area]?.some(option => option.id === choices[area])));
}

export default function PaperVoting({ snapshot, api, refresh, notify }: ViewProps) {
  const state = snapshot.state as PaperState;
  const rank = state.presentationRanking;
  const [block, setBlock] = useState<Block>('P1');
  const areas: Area[] = ['MAT', 'COM'];
  const [selectedId, setSelectedId] = useState(() => state.paperPolls?.find(item => item.status === 'open')?.id ?? state.paperPolls?.at(-1)?.id ?? '');
  const [updatedPolls, setUpdatedPolls] = useState<Record<string, PaperPoll>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [printBatch, setPrintBatch] = useState<PrintBatch | null>(null);
  const [pdfLoaded, setPdfLoaded] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reviewedSamples, setReviewedSamples] = useState(false);
  const [gradeFilter, setGradeFilter] = useState('all');
  const [attendanceFilter, setAttendanceFilter] = useState('all');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualClassroomId, setManualClassroomId] = useState('');
  const [manualChoices, setManualChoices] = useState<Choices>({});
  const [manualReviewed, setManualReviewed] = useState(false);
  const [manualCorrection, setManualCorrection] = useState(false);
  const [manualVoteVersion, setManualVoteVersion] = useState(0);
  const [manualReason, setManualReason] = useState('');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const mountedRef = useRef(true);
  const urlRef = useRef(new Set<string>());
  const printRef = useRef<PrintBatch | null>(null);
  printRef.current = printBatch;

  const polls = [...(state.paperPolls ?? [])];
  for (const value of Object.values(updatedPolls)) {
    const index = polls.findIndex(item => item.id === value.id);
    if (index < 0) polls.push(value); else if (value.version >= polls[index].version) polls[index] = value;
  }
  const poll = polls.find(item => item.id === selectedId);
  const classrooms = poll?.rosterVersion === 1 ? poll.classrooms ?? [] : [];
  const classroomPoll = poll?.rosterVersion === 1;
  const availablePrint = classrooms.filter(item => !item.received && !item.ballotIssued && item.attendance !== 'absent');
  const shownClassrooms = classrooms.filter(item => (gradeFilter === 'all' || item.gradeId === gradeFilter)
    && (attendanceFilter === 'all' || attendanceFilter === 'received' && item.received || item.attendance === attendanceFilter));
  const manualClassroom = classrooms.find(item => item.id === manualClassroomId);
  const coordinator = snapshot.actor.role === 'coordinator';
  const rankingReady = !!rank && !rank.provisional && !rank.stale;
  const configuredAreasReady = areas.every(area => (rank?.categories.find(category => category.area === area && category.block === block)?.ranked.filter(row => row.score !== null).length ?? 0) >= 3);
  const publicUrl = '/?vista=publica' + (snapshot.dataset === 'demo' ? '&datos=demo' : '') + '#votacion-padres';

  useEffect(() => {
    if (!selectedId && polls.length) setSelectedId(polls.find(item => item.status === 'open')?.id ?? polls.at(-1)!.id);
  }, [selectedId, state.paperPolls, updatedPolls]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; for (const url of urlRef.current) URL.revokeObjectURL(url); urlRef.current.clear(); };
  }, []);
  useEffect(() => { setConfirmClose(false); }, [selectedId, poll?.version]);
  useEffect(() => {
    setGradeFilter('all'); setAttendanceFilter('all'); setManualOpen(false);
    setManualClassroomId(''); setManualChoices({}); setManualReviewed(false); setManualCorrection(false); setManualReason('');
  }, [selectedId]);

  function dropUrl(url?: string) { if (url) { URL.revokeObjectURL(url); urlRef.current.delete(url); } }
  function rememberPoll(value: PaperPoll) { if (mountedRef.current) setUpdatedPolls(current => ({ ...current, [value.id]: value })); }
  async function sync() {
    try { await refresh(); }
    catch { notify('No se pudo actualizar la vista. Use Actualizar para consultar la información del servidor.', true); }
  }
  function choosePoll(id: string) {
    if (busy) return;
    setSelectedId(id); setError(''); setSuccess(''); setConfirmClose(false);
  }
  async function createPoll() {
    if (!rank || !rankingReady || !configuredAreasReady || !reviewedSamples) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.call<PaperPoll>('paper_poll_create', { block, areas, rankingId: rank.id, expectedRankingVersion: rank.version });
      rememberPoll(result); setSelectedId(result.id); setReviewedSamples(false); await sync();
      notify('Votación preparada con cinco secciones por grado y una ficha por aula.');
    } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function preparePdf(batch: PrintBatch) {
    const bytes = await buildPaperVotingPdf(state, batch.poll, batch.codes, { demo: snapshot.dataset === 'demo', generatedAt: new Date().toISOString(), ballots: batch.ballots });
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }));
    urlRef.current.add(url);
    if (!mountedRef.current) { dropUrl(url); return; }
    dropUrl(printRef.current?.url); setPdfLoaded(false); setPrintBatch({ ...batch, bytes, url });
  }
  async function generate(classroomIds?: string[]) {
    if (!poll || !classroomPoll || poll.status !== 'open' || busy || !classroomIds && !availablePrint.length) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.call<PaperBallotsGenerated>('paper_ballots_generate', { pollId: poll.id, expectedVersion: poll.version, ...(classroomIds ? { classroomIds } : {}) });
      rememberPoll(result.poll);
      const batch: PrintBatch = { poll: result.poll, codes: result.codes, ballots: result.ballots };
      dropUrl(printRef.current?.url); setPrintBatch(batch); printRef.current = batch;
      await preparePdf(batch); await sync();
      notify(result.codes.length + ' fichas A5 listas, identificadas por aula y folio.');
    } catch (problem) { setError(messageOf(problem) + (printRef.current && !printRef.current.bytes ? ' Puede reintentar preparar el mismo PDF.' : '')); }
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
  async function saveAttendance(classroom: PaperClassroom, attendance: PaperAttendance) {
    if (!poll || poll.status !== 'open' || busy || classroom.received) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.call<PaperPoll>('paper_attendance_save', { pollId: poll.id, classroomId: classroom.id, attendance, expectedVersion: poll.version });
      rememberPoll(result); await sync(); notify(classroom.label + ': ' + attendanceName[attendance] + '.');
    } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  function openManual(classroomId = '', correction = false) {
    const classroom = classrooms.find(item => item.id === classroomId);
    setManualOpen(true); setManualClassroomId(classroomId);
    setManualCorrection(correction); setManualChoices(correction ? { ...classroom?.choices } : {});
    setManualVoteVersion(classroom?.voteVersion ?? 0); setManualReason(''); setManualReviewed(false); setError(''); setSuccess('');
  }
  async function saveManual() {
    if (!poll || poll.status !== 'open' || !manualClassroom || busy || manualClassroom.attendance === 'absent'
      || !manualReviewed || !validChoices(poll, manualChoices) || manualCorrection && manualReason.trim().length < 8
      || !manualCorrection && manualClassroom.received) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.call<{ poll: PaperPoll; accepted: boolean }>(manualCorrection ? 'paper_manual_correct' : 'paper_manual_cast', {
        pollId: poll.id, classroomId: manualClassroom.id, choices: manualChoices, expectedVersion: poll.version,
        ...(manualCorrection ? { expectedVoteVersion: manualVoteVersion, reason: manualReason.trim() } : { confirmation: true }),
      });
      if (!result.accepted) throw new Error('El servidor no confirmó el registro del voto.');
      rememberPoll(result.poll);
      setSuccess(manualCorrection ? 'Voto de ' + manualClassroom.label + ' corregido. Se ajustó el conteo sin sumar otra ficha.' : 'Voto de ' + manualClassroom.label + ' registrado.');
      setManualOpen(false); setManualClassroomId(''); setManualChoices({}); setManualReviewed(false); setManualReason('');
      await sync();
    } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }
  async function closePoll() {
    if (!poll || !confirmClose || busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.call<PaperPoll>('paper_poll_close', { pollId: poll.id, expectedVersion: poll.version });
      rememberPoll(result); setManualOpen(false); await sync(); notify('Votación cerrada. El resultado distingue ganadores, empates, blancos y nulos.');
    } catch (problem) { setError(messageOf(problem)); }
    finally { if (mountedRef.current) setBusy(false); }
  }

  if (!coordinator) return <section className="card"><h1>Votación familiar en papel</h1><p>El registro de la votación corresponde a Subdirección.</p></section>;
  return <div className="paper-voting stack"><style>{paperStyles}</style>
    <div><span className="eyebrow">ELECCIÓN DE LAS FAMILIAS</span><h1>Votación en papel</h1><p className="muted">Una ficha A5 por aula, con Matemática y Comunicación. Transcriba los votos del papel para actualizar el conteo y la tabla que pueden consultar los padres.</p></div>
    {error && <div className="notice danger" role="alert">{error}</div>}
    {success && <div className="notice" role="status">{success}</div>}
    <details open={!polls.length}><summary>Preparar votación desde el ranking final</summary><div className="stack">
      {!rankingReady && <div className="notice warning">Primero complete las presentaciones y las fichas docentes y genere el ranking final en <strong>Ranking / Top</strong>. Un ranking provisional o desactualizado no abre la votación.</div>}
      <div className="field-row"><label className="field">Categoría de la votación<select aria-label="Categoría de la votación" disabled={busy} value={block} onChange={event => setBlock(event.target.value as Block)}>{BLOCKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><div className="notice"><strong>Matemática y Comunicación</strong><br />Ambas áreas en una misma ficha A5, para esta categoría.</div></div>
      <p className="muted">Se prepararán {paperClassroomRoster(block).length} aulas: cinco secciones por grado, de la A a la E. Se usarán las tres editoriales clasificadas de cada área. La valoración docente orienta; las familias eligen.</p>
      <div className="grid">{areas.map(area => { const category = rank?.categories.find(item => item.area === area && item.block === block); return <div key={area}><h3>{areaName(area)}</h3><ol>{category?.ranked.filter(item => item.score !== null).slice(0, 3).map(item => <li key={item.publisherId}>{state.publishers.find(publisher => publisher.id === item.publisherId)?.name ?? item.publisherId}</li>)}</ol>{(category?.ranked.filter(item => item.score !== null).length ?? 0) < 3 && <p className="notice warning">Se necesitan tres editoriales valoradas para esta área.</p>}</div>; })}</div>
      <label><input type="checkbox" disabled={busy} checked={reviewedSamples} onChange={event => setReviewedSamples(event.target.checked)} />Confirmo que las familias pudieron revisar los ejemplares físicos y que estas son las opciones que se imprimirán.</label>
      <button className="primary" disabled={busy || !rankingReady || !configuredAreasReady || !reviewedSamples} onClick={() => void createPoll()}><FilePlus2 size={18} />Crear votación en papel</button>
    </div></details>
    <section className="card stack"><div className="row between"><h2>Fichas y recepción</h2><button disabled={busy} onClick={() => void sync()}><RefreshCw size={16} />Actualizar</button></div>
      <label className="field">Votación<select aria-label="Votación" disabled={busy} value={selectedId} onChange={event => choosePoll(event.target.value)}><option value="">Seleccione una votación</option>{polls.map(item => <option key={item.id} value={item.id}>{categoryName(item.block)} · {item.areas.map(areaName).join(' y ')} · {item.status === 'open' ? 'Abierta' : 'Cerrada'} · {new Date(item.createdAt).toLocaleString('es-PE')}</option>)}</select></label>
      {!poll && <div className="empty-state">Cree una votación para preparar sus fichas por aula.</div>}
      {poll && <>
        <div className="paper-stats">{classroomPoll && <span><strong>{classrooms.length}</strong> aulas</span>}<span><strong>{poll.generated}</strong> fichas habilitadas</span><span><strong>{poll.received}</strong> fichas recibidas</span><span className={'status ' + (poll.status === 'open' ? 'pending' : 'closed')}>{poll.status === 'open' ? 'Recepción abierta' : 'Recepción cerrada'}</span></div>
        {!classroomPoll && <div className="notice warning">Esta votación anterior conserva sus resultados sin asignarlos retroactivamente a un aula. Para usar fichas por aula y transcripción manual, cierre esta votación y prepare una nueva.</div>}
        {classroomPoll && <section className="stack" aria-label="Padrón de aulas">
          <div className="row between"><h3>Padrón de aulas y votos</h3><a href={publicUrl} target="_blank" rel="noreferrer">Tabla pública para padres ↗</a></div>
          <p className="muted">{classrooms.filter(item => item.attendance === 'present').length} con asistencia · {classrooms.filter(item => item.attendance === 'absent').length} sin asistencia · {classrooms.filter(item => item.attendance === 'pending').length} pendientes de confirmar. Cada aula tiene un folio y una sola ficha para ambas áreas.</p>
          <div className="field-row"><label className="field">Filtrar por grado<select aria-label="Filtrar por grado" value={gradeFilter} onChange={event => setGradeFilter(event.target.value)}><option value="all">Todos los grados</option>{GRADES.filter(item => item.block === poll.block).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="field">Filtrar aulas<select aria-label="Filtrar aulas" value={attendanceFilter} onChange={event => setAttendanceFilter(event.target.value)}><option value="all">Todas las aulas</option><option value="pending">Asistencia pendiente</option><option value="present">Con asistencia</option><option value="absent">Sin asistencia</option><option value="received">Voto registrado</option></select></label></div>
          <div className="paper-classroom-list">{shownClassrooms.map(classroom => <article className="paper-classroom-row" key={classroom.id} aria-label={classroom.label}>
            <div><h3>{classroom.label}</h3><span className="paper-folio">Folio {classroom.folio}</span><br /><small>{classroom.received ? 'Voto registrado' : classroom.ballotIssued ? 'Ficha habilitada' : 'Ficha pendiente'}</small></div>
            <label className="field">Asistencia<select aria-label={'Asistencia · ' + classroom.label} value={classroom.attendance} disabled={busy || poll.status !== 'open' || classroom.received} onChange={event => void saveAttendance(classroom, event.target.value as PaperAttendance)}><option value="pending">Pendiente de confirmar</option><option value="present">Con asistencia</option><option value="absent">Sin asistencia</option></select></label>
            <div className="paper-classroom-votes">{poll.areas.map(area => <div key={area}><strong>{areaName(area)}</strong><span>{classroom.received ? choiceName(poll, area, classroom.choices?.[area]) : 'Pendiente'}</span></div>)}</div>
            {poll.status === 'open' && <div className="paper-classroom-actions"><button type="button" disabled={busy || classroom.attendance === 'absent'} onClick={() => openManual(classroom.id, classroom.received)}><PencilLine size={15} />{classroom.received ? 'Revisar voto' : 'Transcribir voto'}</button>{!classroom.received && <button type="button" disabled={busy || classroom.attendance === 'absent'} onClick={() => void generate([classroom.id])}><Printer size={15} />{classroom.ballotIssued ? 'Reponer ficha A5' : 'Generar ficha A5'}</button>}</div>}
          </article>)}</div>
          {!shownClassrooms.length && <p className="empty-state">No hay aulas con los filtros elegidos.</p>}
          {poll.status === 'open' && <><div className="paper-print-controls"><button className="primary" disabled={busy || !availablePrint.length} onClick={() => void generate()}><Printer size={18} />Generar fichas A5 del padrón</button><span>{availablePrint.length} fichas pendientes de emitir. Se excluyen las aulas sin asistencia y los votos ya registrados.</span></div><p className="muted">La ficha muestra el aula y su folio corto. Una reposición conserva el mismo folio y no suma otra ficha. Puede registrar la asistencia después de imprimir.</p><button className="primary" type="button" disabled={busy} onClick={() => openManual()}><PencilLine size={18} />Transcribir voto manualmente</button></>}
        </section>}
        {printBatch && printBatch.poll.id === poll.id && <section className="paper-print-preview stack" aria-label="Fichas A5 preparadas"><div className="row between"><h3>{printBatch.codes.length} {printBatch.codes.length === 1 ? 'ficha A5 preparada' : 'fichas A5 preparadas'}</h3><button className="secondary" disabled={busy} onClick={() => { dropUrl(printBatch.url); setPrintBatch(null); }}><X size={16} />Cerrar PDF</button></div>{printBatch.bytes && printBatch.url ? <><div className="row"><button disabled={busy || !pdfLoaded} onClick={print}><Printer size={18} />Imprimir fichas A5</button><button disabled={busy} onClick={() => downloadBytes(printBatch.bytes!, 'fichas-A5-' + poll.block + '.pdf', 'application/pdf')}><Download size={18} />Descargar PDF A5</button><a href={printBatch.url} target="_blank" rel="noreferrer">Abrir PDF</a></div><iframe ref={frameRef} src={printBatch.url} onLoad={() => setPdfLoaded(true)} title="Vista previa de las fichas A5" /></> : <><p>Las fichas ya están habilitadas. Prepare el mismo archivo sin emitirlas otra vez.</p><button disabled={busy} onClick={() => void retryPdf()}>Reintentar preparar PDF</button></>}</section>}
        {manualOpen && classroomPoll && poll.status === 'open' && <form className="paper-manual card stack" aria-label="Transcripción manual del voto" onSubmit={event => { event.preventDefault(); void saveManual(); }}>
          <div className="row between"><h3>{manualCorrection ? 'Revisar y corregir voto' : 'Transcribir voto manualmente'}</h3><button type="button" disabled={busy} onClick={() => { setManualOpen(false); setError(''); }}>Cancelar</button></div>
          <p>Lea la ficha de papel y seleccione lo marcado en cada área. No necesita cargar una foto ni escribir un código largo.</p>
          <label className="field">Aula y folio<select aria-label="Aula del voto manual" disabled={busy || manualCorrection} value={manualClassroomId} onChange={event => openManual(event.target.value)}><option value="">Seleccione el aula</option>{classrooms.map(classroom => <option key={classroom.id} value={classroom.id} disabled={classroom.attendance === 'absent' || !manualCorrection && classroom.received}>{classroom.folio + ' · ' + classroom.label + (classroom.attendance === 'absent' ? ' · Sin asistencia' : classroom.received ? ' · Registrado' : '')}</option>)}</select></label>
          {manualClassroom?.attendance === 'absent' && <p className="notice warning">Esta aula está sin asistencia. Corrija su asistencia antes de registrar un voto.</p>}
          {manualCorrection && manualClassroom && <div className="notice paper-manual-current"><strong>Registro actual · versión {manualVoteVersion}</strong>{poll.areas.map(area => <p key={area}>{areaName(area)}: {choiceName(poll, area, manualClassroom.choices?.[area])}</p>)}<p>La corrección ajusta el conteo; no añade otra ficha recibida.</p></div>}
          <div className="field-row">{poll.areas.map(area => <label className="field" key={area}>{areaName(area)} · voto manual<select aria-label={areaName(area) + ' · voto manual'} value={Object.hasOwn(manualChoices, area) ? manualChoices[area] === null ? '__blank__' : manualChoices[area] : '__pending__'} disabled={busy || !manualClassroom} onChange={event => { setManualChoices(current => ({ ...current, [area]: event.target.value === '__blank__' ? null : event.target.value })); setManualReviewed(false); }}><option value="__pending__" disabled>Seleccione lo marcado en el papel</option>{poll.options[area]?.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}<option value="__blank__">En blanco</option><option value="__invalid__">Nulo · varias marcas o voto no válido</option></select></label>)}</div>
          {manualCorrection && <label className="field">Motivo de la corrección<textarea aria-label="Motivo de la corrección" disabled={busy} minLength={8} maxLength={1000} value={manualReason} onChange={event => setManualReason(event.target.value)} placeholder="Explique brevemente la corrección del registro" /></label>}
          <label><input type="checkbox" checked={manualReviewed} disabled={busy || !manualClassroom} onChange={event => setManualReviewed(event.target.checked)} />Comparé los votos con la ficha de papel original.</label>
          <button className="primary" disabled={busy || !manualClassroom || manualClassroom.attendance === 'absent' || !manualReviewed || !validChoices(poll, manualChoices) || manualCorrection && manualReason.trim().length < 8 || !manualCorrection && manualClassroom.received}>{busy ? 'Guardando…' : manualCorrection ? 'Guardar corrección' : 'Guardar voto manual'}</button>
        </form>}
        <PaperEvidence poll={poll} api={api} notify={notify} />
        <section className="stack" aria-label="Resultados de la votación"><h3>Resultado por área</h3><p className="muted">Cada ficha recibida suma una respuesta por área. Los votos en blanco y los nulos se registran por separado.</p><div className="grid">{poll.areas.map(area => { const counts = poll.counts[area]; const result = poll.results[area]; const resultText = result?.state === 'winner' ? 'Editorial elegida: ' + (poll.options[area]?.find(item => item.id === result.winnerId)?.name ?? 'opción ganadora') : result?.state === 'tie' ? 'Empate: ' + (result.tiedIds ?? []).map(id => poll.options[area]?.find(item => item.id === id)?.name ?? id).join(' / ') : result?.state === 'no_valid_votes' ? 'Sin editorial elegida: no hubo votos válidos.' : 'Conteo provisional · recepción abierta'; return <div className="card stack" key={area}><h3>{areaName(area)}</h3><div className="table-wrap"><table><thead><tr><th>Editorial</th><th>Votos</th></tr></thead><tbody>{poll.options[area]?.map(option => <tr key={option.id}><td>{option.name}</td><td>{counts?.options[option.id] ?? 0}</td></tr>)}<tr><td>En blanco</td><td>{counts?.blank ?? 0}</td></tr><tr><td>Nulos</td><td>{counts?.invalid ?? 0}</td></tr></tbody></table></div><strong>{resultText}</strong></div>; })}</div></section>
        {poll.status === 'open' && <section className="notice stack"><strong>Cerrar recepción</strong><p>Revise los votos de la tabla y marque las aulas sin asistencia antes de cerrar. Después no se aceptarán más votos ni correcciones en esta votación.</p><label><input type="checkbox" disabled={busy || manualOpen} checked={confirmClose} onChange={event => setConfirmClose(event.target.checked)} />Confirmo que terminó la recepción y revisé el escrutinio.</label><button className="danger" disabled={busy || manualOpen || !confirmClose} onClick={() => void closePoll()}>Cerrar votación y calcular resultado</button></section>}
      </>}
    </section>
  </div>;
}

const paperStyles = '.paper-voting{min-width:0}.paper-voting h2,.paper-voting h3{margin-bottom:0}.paper-voting table{min-width:0;width:100%;table-layout:fixed}.paper-voting th:last-child,.paper-voting td:last-child{width:64px;text-align:right;white-space:nowrap}.paper-voting td:first-child{overflow-wrap:anywhere}.paper-voting th,.paper-voting td{padding:10px 8px}.paper-stats{display:flex;gap:24px;flex-wrap:wrap;align-items:center;color:var(--muted)}.paper-stats strong{font-size:21px;color:var(--ink);margin-right:5px}.paper-print-controls{display:flex;gap:15px;align-items:center;flex-wrap:wrap}.paper-print-controls span{font-size:13px;color:var(--muted)}.paper-print-preview{border:1px solid var(--line);border-radius:10px;padding:18px;background:#f7f9fc}.paper-print-preview iframe{width:100%;height:450px;border:1px solid var(--line);border-radius:8px;background:#fff}.paper-voting .notice p:last-child{margin-bottom:0}.paper-classroom-list{display:grid;gap:10px}.paper-classroom-row{display:grid;grid-template-columns:minmax(135px,1.1fr) minmax(150px,1fr) minmax(160px,1.2fr) auto;gap:15px;align-items:center;border:1px solid var(--line);border-radius:9px;padding:15px}.paper-classroom-row h3{font-size:14px;margin:0 0 5px}.paper-folio{font-size:12px;font-weight:700;color:var(--navy)}.paper-classroom-row small{color:var(--muted)}.paper-classroom-row .field{min-width:0;font-size:12px}.paper-classroom-votes{display:grid;gap:8px;font-size:12px;overflow-wrap:anywhere}.paper-classroom-votes strong,.paper-classroom-votes span{display:block}.paper-classroom-actions{display:flex;gap:6px;flex-direction:column}.paper-classroom-actions button{font-size:11px;justify-content:center;white-space:normal}.paper-manual{background:#f5f9ff}.paper-manual .field{min-width:0}.paper-manual-current p{margin:5px 0}@media(max-width:1050px){.paper-classroom-row{grid-template-columns:minmax(130px,1fr) minmax(150px,1fr)}.paper-classroom-actions{flex-direction:row;flex-wrap:wrap}}@media(max-width:680px){.paper-classroom-row{grid-template-columns:minmax(0,1fr)}.paper-classroom-actions button{flex:1}.paper-stats{gap:12px}.paper-print-controls{align-items:stretch;flex-direction:column}.paper-print-preview iframe{height:330px}.paper-voting h1{font-size:27px}.paper-manual .field-row{grid-template-columns:minmax(0,1fr)}}';
