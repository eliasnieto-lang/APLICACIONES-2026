import { useEffect, useState } from 'react';
import type { Turn, ViewProps } from '../../shared/types';

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
  const warning = !transition && elapsed >= presentationSeconds * .9;
  return { elapsed, transition, remaining, warning };
}

export function clockText(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }

export const ROOM_SCRIPT = [
  ['0–1', 'Identificación y cobertura curricular'], ['1–3', 'Matemática'], ['3–5', 'Comunicación'],
  ['5–7', 'Capítulos, temas por bimestre y práctica por tema'], ['7–9', 'Paquete, acceso y demostración de recursos'], ['9–10', 'Precios'],
];

export default function LiveRoom({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const now = useServerClock(snapshot.serverNow);
  const [publisherId, setPublisherId] = useState(state.turn.publisherId || state.publishers[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [withdrawal, setWithdrawal] = useState(state.settings.withdrawalReference);
  const [sampleNotes, setSampleNotes] = useState<Record<string, string>>({});
  const canManage = snapshot.actor.role === 'coordinator' || snapshot.actor.role === 'secretary';
  const timing = turnTiming(state.turn, now, state.settings.rules.presentationSeconds, state.settings.rules.transitionSeconds);
  const current = state.publishers.find(p => p.id === state.turn.publisherId);
  useEffect(() => { if (!publisherId && state.publishers.length) setPublisherId(state.publishers[0].id); }, [state.publishers, publisherId]);
  useEffect(() => { setWithdrawal(state.settings.withdrawalReference); }, [state.settings.withdrawalReference]);
  async function action(command: 'start' | 'pause' | 'resume' | 'finish' | 'next') {
    setBusy(true);
    try { await api.call('turn_control', { command, ...(['start', 'next'].includes(command) ? { publisherId } : {}) }); await refresh(); }
    catch (e) { notify(e instanceof Error ? e.message : 'No se pudo actualizar el turno.', true); }
    finally { setBusy(false); }
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
    <div className="row"><div><h1>Sala en vivo</h1><p className="muted">Reloj común del servidor · exposición de {Math.round(state.settings.rules.presentationSeconds / 60)} min + registro y cambio de {Math.round(state.settings.rules.transitionSeconds / 60)} min</p></div><button onClick={() => void refresh()}>Sincronizar</button></div>
    <section className={`card room-clock ${timing.warning ? 'clock-warning' : ''}`} aria-live="polite">
      <span className="status">{status} · {timing.transition ? 'Registro y cambio' : 'Exposición'}</span>
      <h2>{current?.name || 'Seleccione una editorial'}</h2>
      <div style={{ fontSize: 'clamp(4rem, 13vw, 8rem)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, fontWeight: 750 }}>{clockText(timing.remaining)}</div>
      {timing.warning && <p className="notice">Último minuto: presentar precios y cerrar la exposición.</p>}
      {timing.transition && <p>{timing.remaining ? 'Tiempo de registro, consultas breves y cambio de editorial.' : 'Tiempo agotado. La coordinación puede iniciar el siguiente turno.'}</p>}
      {snapshot.actor.role === 'coordinator' && <div className="stack">
        <label className="field">Editorial del próximo turno<select value={publisherId} onChange={e => setPublisherId(e.target.value)} disabled={busy}>{state.publishers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="row">
          <button disabled={busy || !publisherId || ['running', 'paused'].includes(state.turn.status)} onClick={() => void action('start')}>Iniciar</button>
          <button disabled={busy || state.turn.status !== 'running'} onClick={() => void action('pause')}>Pausar</button>
          <button disabled={busy || state.turn.status !== 'paused'} onClick={() => void action('resume')}>Reanudar</button>
          <button disabled={busy || !['running', 'paused'].includes(state.turn.status)} onClick={() => void action('finish')}>Finalizar</button>
          <button disabled={busy || !publisherId || ['running', 'paused'].includes(state.turn.status)} onClick={() => void action('next')}>Siguiente editorial</button>
        </div>
      </div>}
      {snapshot.actor.role === 'secretary' && <p className="muted">Coordinación controla los turnos. Secretaría puede registrar aquí la recepción de muestras.</p>}
    </section>
    <section className="card"><h2>Guion de exposición</h2><div className="table-wrap"><table><thead><tr><th>Minutos</th><th>Contenido</th></tr></thead><tbody>{ROOM_SCRIPT.map(([time, label]) => <tr key={time}><th>{time}</th><td>{label}</td></tr>)}</tbody></table></div><p className="muted">Los detalles por grado se consultan en los expedientes precargados. El fin del tiempo conserva los borradores y las ternas requieren su propia validación.</p></section>
    {canManage && <section className="card"><h2>Recepción de muestras</h2>{!state.publishers.length && <p>Registre primero las editoriales en Preparación.</p>}<div className="stack">{state.publishers.map(p => <div className="row" key={p.id}><strong>{p.name}</strong><span className="status">{p.samplesReceived ? 'Recibidas' : 'Pendiente'}</span><input aria-label={`Constancia de muestras de ${p.name}`} placeholder="Mesa, cantidad o constancia" value={sampleNotes[p.id] ?? p.sampleNote} onChange={e => setSampleNotes(old => ({ ...old, [p.id]: e.target.value }))} /><button disabled={busy} onClick={() => void saveSample(p.id, true)}>Guardar recepción</button></div>)}</div></section>}
    {snapshot.actor.role === 'coordinator' && <section className="card"><h2>Retiro de las editoriales</h2><p>Después de la última exposición, registre el retiro de todas las editoriales antes de publicar las ternas.</p><label className="field">Constancia o referencia<input value={withdrawal} onChange={e => setWithdrawal(e.target.value)} /></label><button disabled={busy || !withdrawal.trim()} onClick={() => void saveWithdrawal()}>{state.settings.editorsWithdrawn ? 'Actualizar constancia de retiro' : 'Confirmar retiro de todas las editoriales'}</button>{state.settings.editorsWithdrawn && <p className="status">Retiro registrado: {state.settings.withdrawalReference}</p>}</section>}
  </div>;
}
