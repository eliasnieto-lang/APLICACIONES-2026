import { useEffect, useId, useState } from 'react';
import type { Turn, ViewProps } from '../../shared/types';
import type { PresentationDraw } from '../../shared/jornada';
import { AREAS } from '../../shared/domain';
import { isQuestionAnswered, presentationQuestionForPublisher, type PresentationQuestion } from '../../shared/questions';
import { timerAudioSample, useTimerSound } from '../timer-audio';

export function useServerClock(serverNow: string) {
  const [offset, setOffset] = useState(() => Date.parse(serverNow) - Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setOffset(Date.parse(serverNow) - Date.now()); }, [serverNow]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  return now + offset;
}

export function turnTiming(turn: Turn, now: number, presentationSeconds: number, transitionSeconds: number) {
  const end = turn.status === 'paused' && turn.pausedAt ? Date.parse(turn.pausedAt) : now;
  const elapsed = turn.status === 'finished' && turn.pausedAt
    ? presentationSeconds + Math.max(0, (now - Date.parse(turn.pausedAt)) / 1000)
    : turn.startedAt ? Math.max(0, (end - Date.parse(turn.startedAt) - turn.pausedMilliseconds) / 1000) : 0;
  const transition = elapsed >= presentationSeconds;
  const remaining = Math.max(0, Math.ceil((transition ? presentationSeconds + transitionSeconds : presentationSeconds) - elapsed));
  const warning = !transition && elapsed >= Math.max(0, presentationSeconds - 60);
  const finalSeconds = turn.status === 'running' && !transition && elapsed >= Math.max(0, presentationSeconds - 5);
  return { elapsed, transition, remaining, warning, finalSeconds };
}

export function clockText(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }

export const ROOM_SCRIPT = [
  ['0–1', 'Identificación y cobertura curricular'], ['1–3', 'Matemática'], ['3–5', 'Comunicación'],
  ['5–7', 'Capítulos, temas por bimestre y práctica por tema'], ['7–9', 'Paquete, acceso y demostración de recursos'], ['9–10', 'Precios'],
];

export function PresentationOrder({ draw, currentPublisherId }: { draw: PresentationDraw; currentPublisherId: string | null }) {
  return <section className="card stack" aria-label="Orden de participación">
    <div><span className="eyebrow">SORTEO CONFIRMADO</span><h2>Orden de participación</h2><p className="muted">El mismo orden está disponible en las fichas de todos los docentes.</p></div>
    <ol className="live-participation-order">{draw.publishers.map((publisher, index) => {
      const completed = draw.completedPublisherIds.includes(publisher.id);
      const current = currentPublisherId === publisher.id && !completed;
      return <li key={publisher.id} aria-current={current ? 'step' : undefined} style={{ background: current ? '#edf4ff' : completed ? '#f4f8f5' : '#fff', border: `1px solid ${current ? '#91b3df' : '#e1e7ef'}`, borderRadius: 8, padding: '11px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span><strong style={{ color: '#174d85', marginRight: 12 }}>{index + 1}.</strong>{publisher.name}</span>
        <span className="status">{completed ? 'Finalizada' : current ? 'Turno actual' : 'Por participar'}</span>
      </li>;
    })}</ol>
    <p className="muted small">{draw.completedPublisherIds.length} de {draw.publishers.length} presentaciones finalizadas · Sorteo del {new Date(draw.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</p>
    <style>{`.live-participation-order{display:flex;flex-direction:column;gap:9px;list-style:none;margin:0;padding:0}.live-participation-order li>span:first-child{min-width:0;overflow-wrap:anywhere}.live-participation-order .status{flex-shrink:0}@media(max-width:520px){.live-participation-order li{align-items:flex-start!important;flex-direction:column}}`}</style>
  </section>;
}

export function TimerSoundControls({ sound }: { sound: ReturnType<typeof useTimerSound> }) {
  return <div className="stack" style={{ gap: 8 }}>
    <div className="row"><button type="button" onClick={() => sound.enabled ? sound.disable() : void sound.enable()} aria-pressed={sound.enabled}>{sound.enabled ? 'Silenciar avisos' : 'Activar sonido'}</button>{sound.enabled && <button type="button" onClick={() => void sound.enable(true)}>Probar sonido</button>}<span className="muted small">{sound.enabled ? 'Sonido activado en este equipo' : 'Sonido desactivado en este equipo'}</span></div>
    <p className="muted small" style={{ margin: 0 }}>Un pitido al iniciar, una alarma cuando falten 5 segundos y otra al terminar. Active el sonido en el equipo conectado a los parlantes.</p>
    {sound.error && <div className="notice danger" role="alert">{sound.error}</div>}
  </div>;
}

interface QuestionFields { representativeName: string; area: '' | 'MAT' | 'COM'; question: string; answer: string }
const questionFields = (question?: PresentationQuestion): QuestionFields => ({ representativeName: question?.representativeName ?? '', area: question?.area ?? '', question: question?.question ?? '', answer: question?.answer ?? '' });

function MandatoryQuestion({ snapshot, api, refresh, notify, publisherId, publisherName, disabled }: ViewProps & { publisherId: string; publisherName: string; disabled: boolean }) {
  const prefix = useId();
  const record = presentationQuestionForPublisher(snapshot.state, publisherId);
  const [fields, setFields] = useState<QuestionFields>(() => questionFields(record));
  const [baseVersion, setBaseVersion] = useState(record?.version ?? 0);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false); const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(''); const [error, setError] = useState(''); const [remoteChanged, setRemoteChanged] = useState(false);
  const finished = Boolean(snapshot.state.presentationDraw?.completedPublisherIds.includes(publisherId)
    || snapshot.state.turn.publisherId === publisherId && snapshot.state.turn.status === 'finished'
    || snapshot.state.presentationEvaluations.some(evaluation => {
      const graded = evaluation as typeof evaluation & { questionVersion?: number; responseScore?: number | null };
      return graded.publisherId === publisherId && graded.status === 'closed' && graded.questionVersion === record?.version && typeof graded.responseScore === 'number';
    }));
  const answered = isQuestionAnswered(record);
  const readOnly = answered && (!editing || finished);
  const canConfirm = Boolean(fields.representativeName.trim() && fields.area && fields.question.trim() && fields.answer.trim()
    && confirmed && (!answered || reason.trim().length >= 8) && snapshot.state.turn.publisherId === publisherId
    && ['running', 'paused', 'finished'].includes(snapshot.state.turn.status));
  useEffect(() => {
    const nextVersion = record?.version ?? 0;
    if (nextVersion === baseVersion) return;
    if (dirty) { setRemoteChanged(true); return; }
    setFields(questionFields(record)); setBaseVersion(nextVersion); setEditing(false); setConfirmed(false); setRemoteChanged(false);
  }, [record?.id, record?.version]);
  function change<K extends keyof QuestionFields>(key: K, value: QuestionFields[K]) { setFields(current => ({ ...current, [key]: value })); setDirty(true); setConfirmed(false); }
  function reload() { setFields(questionFields(record)); setBaseVersion(record?.version ?? 0); setDirty(false); setEditing(false); setConfirmed(false); setRemoteChanged(false); setError(''); }
  async function save(status: 'draft' | 'answered') {
    if (disabled || busy || readOnly || remoteChanged || !fields.area || status === 'answered' && !canConfirm) return;
    setBusy(true); setError('');
    try {
      const saved = await api.call<PresentationQuestion>('presentation_question_save', { publisherId, expectedVersion: baseVersion,
        ...fields, status, ...(answered ? { reason: reason.trim() } : {}) });
      setFields(questionFields(saved)); setBaseVersion(saved.version); setDirty(false); setEditing(false); setConfirmed(false); setReason('');
      await refresh(); notify(status === 'answered' ? 'Pregunta y respuesta confirmadas. Ya puede finalizar esta exposición.' : 'Borrador de pregunta guardado.');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'No se pudo guardar la pregunta.'); }
    finally { setBusy(false); }
  }
  return <section className="card stack" aria-label="Pregunta obligatoria de la editorial" id="pregunta-obligatoria">
    <div><span className="eyebrow">CIERRE DE CADA EXPOSICIÓN</span><h2>Pregunta obligatoria · {publisherName}</h2><p>Un representante docente debe formular una pregunta, de Matemática o Comunicación, y la editorial debe responder antes de finalizar su turno.</p><p className="muted">Después de escuchar la respuesta, cada docente la puntuará de 0 a 4 en el criterio 11 de su ficha. Esa valoración orienta la clasificación; la elección final corresponde a los padres.</p></div>
    {answered && <div className="notice"><strong>Pregunta y respuesta registradas.</strong> La valoración docente orienta la clasificación; los padres eligen finalmente entre las editoriales clasificadas.</div>}
    {error && <div className="notice danger" role="alert">{error}</div>}
    {remoteChanged && <div className="notice warning" role="alert">El registro cambió en otra pantalla. Su texto local se conserva. <button type="button" disabled={busy} onClick={reload}>Consultar el registro del servidor</button></div>}
    <div className="field-row"><label className="field" htmlFor={`${prefix}-representative`}>Representante docente que pregunta<input id={`${prefix}-representative`} aria-label="Representante docente que pregunta" disabled={disabled || busy || readOnly || remoteChanged} autoComplete="name" maxLength={160} value={fields.representativeName} onChange={event => change('representativeName', event.target.value)} placeholder="Apellidos y nombres" /></label>
      <label className="field" htmlFor={`${prefix}-area`}>Área de la pregunta<select id={`${prefix}-area`} aria-label="Área de la pregunta" disabled={disabled || busy || readOnly || remoteChanged} value={fields.area} onChange={event => change('area', event.target.value as QuestionFields['area'])}><option value="">Seleccione el área</option>{AREAS.map(area => <option key={area.id} value={area.id}>{area.label}</option>)}</select></label></div>
    <label className="field" htmlFor={`${prefix}-question`}>Pregunta formulada a la editorial<textarea id={`${prefix}-question`} aria-label="Pregunta formulada a la editorial" disabled={disabled || busy || readOnly || remoteChanged} maxLength={2000} value={fields.question} onChange={event => change('question', event.target.value)} placeholder="Registre la pregunta que hizo el representante" /></label>
    <label className="field" htmlFor={`${prefix}-answer`}>Resumen de la respuesta de la editorial<textarea id={`${prefix}-answer`} aria-label="Resumen de la respuesta de la editorial" disabled={disabled || busy || readOnly || remoteChanged} maxLength={3000} value={fields.answer} onChange={event => change('answer', event.target.value)} placeholder="Anote lo principal de la respuesta observada" /></label>
    {readOnly ? finished ? <p className="muted">La exposición ya finalizó o su respuesta fue valorada. Este registro se conserva para que todos evalúen la misma respuesta.</p>
      : <button type="button" disabled={disabled || busy} onClick={() => { setEditing(true); setConfirmed(false); }}>Corregir registro antes de finalizar</button>
      : <>
        {answered && <label className="field" htmlFor={`${prefix}-reason`}>Motivo de la corrección<textarea id={`${prefix}-reason`} aria-label="Motivo de la corrección" disabled={disabled || busy || remoteChanged} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explique el motivo; el registro anterior se conserva en el historial" /></label>}
        <label className="row"><input type="checkbox" disabled={disabled || busy || remoteChanged} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo que el representante hizo la pregunta y que la editorial respondió.</label>
        <div className="row">{!answered && <button type="button" className="secondary" disabled={disabled || busy || remoteChanged || !fields.area || !dirty} onClick={() => void save('draft')}>Guardar borrador de pregunta</button>}<button type="button" className="primary" disabled={disabled || busy || remoteChanged || !canConfirm} onClick={() => void save('answered')}>{busy ? 'Guardando…' : 'Confirmar pregunta y respuesta'}</button>{answered && <button type="button" className="secondary" disabled={busy} onClick={reload}>Cancelar corrección</button>}</div>
        {!['running', 'paused', 'finished'].includes(snapshot.state.turn.status) && <p className="muted">Puede preparar la pregunta. Su respuesta se confirma durante la exposición de esta editorial.</p>}
      </>}
  </section>;
}

export default function LiveRoom({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const draw = state.presentationDraw;
  const now = useServerClock(snapshot.serverNow);
  const [publisherId, setPublisherId] = useState(state.turn.publisherId || state.publishers[0]?.id || '');
  const [busy, setBusy] = useState(false); const [drawing, setDrawing] = useState(false);
  const [arrivalsConfirmed, setArrivalsConfirmed] = useState(false); const [drawReason, setDrawReason] = useState('');
  const [withdrawal, setWithdrawal] = useState(state.settings.withdrawalReference);
  const [sampleNotes, setSampleNotes] = useState<Record<string, string>>({});
  const canManage = snapshot.actor.role === 'coordinator' || snapshot.actor.role === 'secretary';
  const timing = turnTiming(state.turn, now, state.settings.rules.presentationSeconds, state.settings.rules.transitionSeconds);
  const sound = useTimerSound(timerAudioSample(state.turn, timing.elapsed, state.settings.rules.presentationSeconds));
  const current = state.publishers.find(p => p.id === state.turn.publisherId);
  const currentQuestion = current ? presentationQuestionForPublisher(state, current.id) : undefined;
  const questionComplete = isQuestionAnswered(currentQuestion);
  const nextPublisher = draw?.publishers.find(publisher => !draw.completedPublisherIds.includes(publisher.id));
  const scheduledId = draw ? nextPublisher?.id || '' : publisherId;
  const unscheduled = draw ? state.publishers.filter(publisher => !draw.publishers.some(item => item.id === publisher.id)) : [];
  const repeatAllowed = draw && draw.completedPublisherIds.length === 0 && !state.turn.startedAt && state.turn.status === 'ready';
  useEffect(() => { if (!publisherId && state.publishers.length) setPublisherId(state.publishers[0].id); }, [state.publishers, publisherId]);
  useEffect(() => { setWithdrawal(state.settings.withdrawalReference); }, [state.settings.withdrawalReference]);
  async function action(command: 'start' | 'pause' | 'resume' | 'finish' | 'next') {
    setBusy(true);
    try {
      if (command === 'start' || command === 'next') await sound.enable(false);
      await api.call('turn_control', { command, expectedTurn: state.turn, ...(['start', 'next'].includes(command) ? { publisherId: scheduledId } : {}) }); await refresh();
    } catch (e) { notify(e instanceof Error ? e.message : 'No se pudo actualizar el turno.', true); }
    finally { setBusy(false); }
  }
  async function runDraw() {
    if (!arrivalsConfirmed) return;
    setBusy(true); setDrawing(true);
    try {
      await api.call('presentation_draw', { expectedVersion: draw?.version ?? 0, confirmArrivals: true, ...(draw ? { reason: drawReason.trim() } : {}) });
      await refresh(); setDrawReason(''); setArrivalsConfirmed(false); notify('Sorteo guardado. Todos los docentes reciben el mismo orden de participación.');
    } catch (e) { notify(e instanceof Error ? e.message : 'No se pudo confirmar el sorteo. Actualice la información antes de reintentar.', true); }
    finally { setBusy(false); setDrawing(false); }
  }
  async function saveSample(id: string, samplesReceived: boolean) {
    const publisher = state.publishers.find(p => p.id === id)!;
    setBusy(true);
    try { await api.call('publisher_save', { publisher: { ...publisher, samplesReceived, sampleNote: sampleNotes[id] ?? publisher.sampleNote } }); await refresh(); notify('Recepción de muestras guardada.'); }
    catch (e) { notify(e instanceof Error ? e.message : 'No se pudo registrar la muestra.', true); }
    finally { setBusy(false); }
  }
  async function saveWithdrawal() {
    if (!withdrawal.trim()) return notify('Indique la constancia del retiro de las editoriales.', true);
    setBusy(true);
    try { await api.call('settings_save', { settings: { ...state.settings, editorsWithdrawn: true, withdrawalReference: withdrawal.trim() }, expectedVersion: state.settings.version }); await refresh(); notify('Retiro de editoriales registrado.'); }
    catch (e) { notify(e instanceof Error ? e.message : 'No se pudo guardar el retiro.', true); }
    finally { setBusy(false); }
  }
  const status = { ready: 'Preparado', running: 'En curso', paused: 'Pausado', finished: 'Finalizado' }[state.turn.status];
  return <div className="stack">
    <div className="row between"><div><h1>Sala en vivo</h1><p className="muted">Reloj común del servidor · exposición de {Math.round(state.settings.rules.presentationSeconds / 60)} min + registro y cambio de {Math.round(state.settings.rules.transitionSeconds / 60)} min</p></div><button disabled={busy} onClick={() => void refresh()}>Sincronizar</button></div>
    {snapshot.actor.role === 'coordinator' && <section className="card stack" aria-label="Sorteo de editoriales">
      <div><h2>{draw ? 'Sorteo de editoriales realizado' : 'Sortear el orden de participación'}</h2><p>Registre todas las editoriales que llegaron antes de sortear. El resultado se guarda y se comparte con cada docente.</p></div>
      {(!draw || repeatAllowed) && <><p><strong>{state.publishers.length} editoriales registradas:</strong> {state.publishers.map(publisher => publisher.name).join(' · ') || 'Ninguna todavía'}</p>
        <label><input type="checkbox" checked={arrivalsConfirmed} disabled={busy} onChange={event => setArrivalsConfirmed(event.target.checked)} />Confirmo que ya registré todas las editoriales que llegaron.</label>
        {draw && <label className="field">Motivo para repetir el sorteo<textarea disabled={busy} value={drawReason} onChange={event => setDrawReason(event.target.value)} placeholder="Explique el motivo antes de iniciar las exposiciones" /></label>}
        <button type="button" className="primary" disabled={busy || state.publishers.length === 0 || !arrivalsConfirmed || Boolean(draw && drawReason.trim().length < 8)} onClick={() => void runDraw()}>{drawing ? 'Sorteando y guardando el orden…' : draw ? 'Repetir sorteo con motivo' : 'Sortear orden de participación'}</button>
      </>}
      {drawing && <div role="status" className="notice row" aria-live="polite"><span className="draw-spinner" aria-hidden="true" />Realizando el sorteo en vivo. El orden aparecerá al confirmarse el resultado.</div>}
      <style>{`.draw-spinner{width:24px;height:24px;border:3px solid #cad9ee;border-top-color:#174d85;border-radius:50%;animation:draw-spin .7s linear infinite}@keyframes draw-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.draw-spinner{animation:none}}`}</style>
      {draw && !repeatAllowed && <p className="notice">El orden se conserva durante las presentaciones. Finalice cada turno y continúe con la siguiente editorial de la lista.</p>}
      {unscheduled.length > 0 && <p className="notice warning">Se registraron después del sorteo: {unscheduled.map(publisher => publisher.name).join(', ')}. No forman parte del orden confirmado.{repeatAllowed ? ' Registre el motivo y repita el sorteo antes de iniciar.' : ' Revise la incidencia con Subdirección antes de continuar.'}</p>}
    </section>}
    {draw && <PresentationOrder draw={draw} currentPublisherId={state.turn.status === 'ready' ? null : state.turn.publisherId} />}
    <section className={`card room-clock ${timing.warning ? 'clock-warning' : ''}`}>
      <span className="status" aria-live="polite">{status} · {timing.transition ? 'Registro y cambio' : 'Exposición'}</span>
      <h2>{current?.name || nextPublisher?.name || 'Seleccione una editorial'}</h2>
      <div role="timer" aria-label={timing.transition ? 'Tiempo de registro y cambio' : 'Tiempo de exposición'} style={{ fontSize: 'clamp(4rem, 13vw, 8rem)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, fontWeight: 750, color: timing.finalSeconds ? '#b52c3c' : undefined }}>{clockText(timing.remaining)}</div>
      {timing.finalSeconds ? <p className="notice danger">Últimos 5 segundos de exposición.</p> : timing.warning && <p className="notice">Último minuto: cierre la exposición.</p>}
      {timing.transition && <p>{timing.remaining ? 'Exposición terminada. Tiempo de registro, consultas breves y cambio de editorial.' : 'Tiempo agotado. Subdirección puede iniciar el siguiente turno.'}</p>}
      {snapshot.actor.role === 'coordinator' && <div className="stack">
        {draw ? <p><strong>{!scheduledId ? 'Todas las editoriales del sorteo finalizaron.' : `${['running', 'paused'].includes(state.turn.status) ? 'Editorial en curso' : 'Próxima editorial del orden'}: ${nextPublisher?.name}`}</strong></p> : <label className="field">Editorial del próximo turno<select value={publisherId} onChange={e => setPublisherId(e.target.value)} disabled={busy}>{state.publishers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <div className="row">
          <button disabled={busy || !scheduledId || state.turn.status !== 'ready'} onClick={() => void action('start')}>Iniciar</button>
          <button disabled={busy || state.turn.status !== 'running'} onClick={() => void action('pause')}>Pausar</button>
          <button disabled={busy || state.turn.status !== 'paused'} onClick={() => void action('resume')}>Reanudar</button>
          <button disabled={busy || !['running', 'paused'].includes(state.turn.status) || !questionComplete} onClick={() => void action('finish')}>Finalizar</button>
          <button disabled={busy || !scheduledId || state.turn.status !== 'finished'} onClick={() => void action('next')}>Siguiente editorial</button>
        </div>
      </div>}
      {snapshot.actor.role === 'coordinator' && ['running', 'paused'].includes(state.turn.status) && !questionComplete && <p className="notice warning">Antes de finalizar, registre y confirme la pregunta obligatoria y la respuesta de la editorial en el formulario siguiente.</p>}
      {snapshot.actor.role === 'secretary' && <p className="muted">Subdirección controla los turnos. Secretaría puede registrar aquí la recepción de muestras.</p>}
      <hr /><TimerSoundControls sound={sound} />
    </section>
    {snapshot.actor.role === 'coordinator' && current && <MandatoryQuestion key={current.id} snapshot={snapshot} api={api} refresh={refresh} notify={notify} publisherId={current.id} publisherName={current.name} disabled={busy} />}
    <section className="card"><h2>Guion de exposición</h2><div className="table-wrap"><table><thead><tr><th>Minutos de referencia</th><th>Contenido</th></tr></thead><tbody>{ROOM_SCRIPT.map(([time, label]) => <tr key={time}><th>{time}</th><td>{label}</td></tr>)}</tbody></table></div><p className="muted">El docente valora la exposición y revisa el ejemplar físico. El fin del tiempo conserva las fichas guardadas.</p></section>
    {canManage && <section className="card"><h2>Recepción de muestras</h2>{!state.publishers.length && <p>Registre primero las editoriales en Preparación.</p>}<div className="stack">{state.publishers.map(p => <div className="row" key={p.id}><strong>{p.name}</strong><span className="status">{p.samplesReceived ? 'Recibidas' : 'Pendiente'}</span><input aria-label={`Constancia de muestras de ${p.name}`} placeholder="Mesa, cantidad o constancia" value={sampleNotes[p.id] ?? p.sampleNote} onChange={e => setSampleNotes(old => ({ ...old, [p.id]: e.target.value }))} /><button disabled={busy} onClick={() => void saveSample(p.id, true)}>Guardar recepción</button></div>)}</div></section>}
    {snapshot.actor.role === 'coordinator' && <section className="card"><h2>Retiro de las editoriales</h2><p>Después de la última exposición, registre el retiro de todas las editoriales antes de publicar las ternas.</p><label className="field">Constancia o referencia<input value={withdrawal} onChange={e => setWithdrawal(e.target.value)} /></label><button disabled={busy || !withdrawal.trim()} onClick={() => void saveWithdrawal()}>{state.settings.editorsWithdrawn ? 'Actualizar constancia de retiro' : 'Confirmar retiro de todas las editoriales'}</button>{state.settings.editorsWithdrawn && <p className="status">Retiro registrado: {state.settings.withdrawalReference}</p>}</section>}
  </div>;
}
