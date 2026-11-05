import { useEffect, useMemo, useState } from 'react';
import { Monitor, Pause, Play, Square, RefreshCw } from 'lucide-react';
import type { ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { buildAuditoriumCategories, readAuditoriumDisplay, visitRemaining, type AuditoriumDisplay } from '../../shared/auditorium';

function useCalibratedClock(serverNow: string) {
  const [offset, setOffset] = useState(() => Date.parse(serverNow) - Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setOffset(Date.parse(serverNow) - Date.now()); }, [serverNow]);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(interval); }, []);
  return now + offset;
}
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

export default function AuditoriumControls({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const display = useMemo(() => readAuditoriumDisplay(state.settings.auditoriumDisplay), [state.settings.auditoriumDisplay]);
  const categories = useMemo(() => buildAuditoriumCategories(state), [state]);
  const now = useCalibratedClock(snapshot.serverNow);
  const [minutes, setMinutes] = useState(() => String((display?.visit?.durationSeconds ?? 600) / 60));
  const [durationDirty, setDurationDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [needsRefresh, setNeedsRefresh] = useState(false);
  useEffect(() => { if (!durationDirty && display?.visit) setMinutes(String(display.visit.durationSeconds / 60)); }, [display?.visit?.durationSeconds, durationDirty]);
  if (snapshot.actor.role !== 'coordinator') return null;
  const visit = display?.mode === 'samples' ? display.visit : undefined;
  const remaining = visitRemaining(visit, now);
  const duration = Number(minutes);
  const validDuration = /^\d+$/.test(minutes) && Number.isInteger(duration) && duration >= 1 && duration <= 60;
  const ranking = state.presentationRanking;
  const staleDisplay = display?.mode === 'samples' && (!ranking || ranking.stale || ranking.provisional
    || ranking.id !== display.rankingId || ranking.version !== display.rankingVersion);
  const locked = busy || needsRefresh;
  async function sync() {
    setBusy(true); setError('');
    try { await refresh(); setNeedsRefresh(false); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'No se pudieron actualizar los datos.'); }
    finally { setBusy(false); }
  }
  async function save(next: AuditoriumDisplay | null, success: string) {
    if (locked) return false;
    if (next && !readAuditoriumDisplay(next)) { setError('Revise los finalistas y el tiempo antes de proyectar.'); return false; }
    setBusy(true); setError('');
    try {
      await api.call('settings_save', { settings: { ...state.settings, auditoriumDisplay: next }, expectedVersion: state.settings.version });
      try { await refresh(); notify(success); return true; }
      catch { setNeedsRefresh(true); setError('El cambio se guardó. Actualice los datos para consultar la pantalla vigente.'); notify(success); return false; }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : 'No se pudo guardar la proyección.';
      setError(message);
      if (/409|cambi[oó]|otra sesi[oó]n|versi[oó]n|actuali[cz]/i.test(message)) setNeedsRefresh(true);
      return false;
    } finally { setBusy(false); }
  }
  async function instructions() {
    await save({ schemaVersion: 1, version: (display?.version ?? 0) + 1, mode: 'instructions', categories: [] }, 'Indicaciones guardadas para la pantalla pública.');
  }
  async function start() {
    if (!validDuration || !categories.length || locked) return;
    const durationSeconds = duration * 60;
    const saved = await save({ schemaVersion: 1, version: (display?.version ?? 0) + 1, mode: 'samples', categories,
      rankingId: ranking!.id, rankingVersion: ranking!.version,
      visit: { status: 'running', durationSeconds, remainingSeconds: durationSeconds, startedAt: new Date(now).toISOString(), endsAt: new Date(now + durationSeconds * 1000).toISOString() } }, 'Visita a las mesas iniciada en la pantalla pública.');
    if (saved) setDurationDirty(false);
  }
  async function changeVisit(command: 'pause' | 'resume' | 'finish') {
    if (!display || !visit || locked) return;
    if (command === 'pause' && (visit.status !== 'running' || remaining <= 0)
      || command === 'resume' && (visit.status !== 'paused' || remaining <= 0 || staleDisplay)) return;
    const nextVisit = { ...visit,
      status: command === 'pause' ? 'paused' as const : command === 'resume' ? 'running' as const : 'finished' as const,
      remainingSeconds: command === 'finish' ? 0 : remaining,
      endsAt: command === 'resume' ? new Date(now + remaining * 1000).toISOString() : null };
    await save({ ...display, version: display.version + 1, visit: nextVisit }, command === 'pause' ? 'Visita pausada.' : command === 'resume' ? 'Visita reanudada.' : 'Visita finalizada. Las familias pueden volver para votar.');
  }
  return <section className="card stack auditorium-controls" aria-label="Proyección de indicaciones y visita a mesas">
    <style>{`.auditorium-controls{min-width:0}.auditorium-controls .field{min-width:0}.auditorium-controls .auditorium-actions{display:flex;gap:10px;flex-wrap:wrap}.auditorium-controls button,.auditorium-controls a{white-space:normal}.auditorium-controls .auditorium-remaining{font-size:clamp(2.5rem,7vw,4rem);font-weight:750;font-variant-numeric:tabular-nums;line-height:1.1}.auditorium-controls ul{margin:0;padding-left:20px}.auditorium-controls li{overflow-wrap:anywhere}@media(max-width:600px){.auditorium-controls .auditorium-actions>*{flex:1 1 100%}.auditorium-controls input{max-width:100%}}`}</style>
    <header><h2>Pantalla del auditorio</h2><p>Proyecte las indicaciones generales o las tres finalistas de cada área y categoría durante la visita a las mesas de muestra.</p></header>
    <div className="auditorium-actions"><button type="button" className="secondary" disabled={locked} onClick={() => void instructions()}><Monitor size={17} />Proyectar indicaciones</button>
      <a className="button secondary" href={`/?vista=publica${snapshot.dataset === 'demo' ? '&datos=demo' : ''}`} target="_blank" rel="noreferrer">Abrir pantalla pública</a>
      {display && <button type="button" className="secondary" disabled={locked} onClick={() => void save(null, 'La pantalla pública volvió a Sala en vivo.')}><Square size={16} />Volver a Sala en vivo</button>}</div>
    <p className="muted">La pantalla pública comparte estos cambios. El cronómetro de exposición conserva su estado.</p>
    {display?.mode === 'instructions' && <p className="status">Indicaciones generales en pantalla.</p>}
    <label className="field">Tiempo de visita a las mesas (minutos)<input type="number" aria-label="Tiempo de visita a las mesas (minutos)" min={1} max={60} step={1} value={minutes} disabled={locked} onChange={event => { setMinutes(event.target.value); setDurationDirty(true); }} /></label>
    {!validDuration && <p className="notice warning">Seleccione entre 1 y 60 minutos para la visita.</p>}
    {categories.length ? <><p><strong>{categories.length} categorías con tres finalistas listas para proyectar:</strong></p><ul>{categories.map(group => <li key={`${group.area}-${group.block}`}>{AREAS.find(item => item.id === group.area)?.label} · {BLOCKS.find(item => item.id === group.block)?.label}: {group.publishers.map(publisher => publisher.name).join(' · ')}</li>)}</ul></>
      : <p className="notice">Para mostrar finalistas, finalice las exposiciones, cierre las fichas y genere un ranking final actualizado. Cada área y categoría mostrada debe tener tres propuestas sin empate pendiente.</p>}
    <button type="button" className="primary" disabled={locked || !validDuration || !categories.length} onClick={() => void start()}><Play size={17} />{visit ? 'Iniciar nueva visita a mesas' : 'Iniciar visita a mesas'}</button>
    {visit && <div className="stack" aria-label="Estado de la visita"><span className="status">{visit.status === 'paused' ? 'Visita pausada' : visit.status === 'finished' || remaining === 0 ? 'Tiempo de visita concluido' : 'Visita en curso'}</span><div className="auditorium-remaining" role="timer" aria-label="Tiempo restante de visita a mesas">{clock(remaining)}</div>
      <div className="auditorium-actions"><button type="button" disabled={locked || visit.status !== 'running' || remaining <= 0} onClick={() => void changeVisit('pause')}><Pause size={16} />Pausar visita</button><button type="button" disabled={locked || visit.status !== 'paused' || remaining <= 0 || !!staleDisplay} onClick={() => void changeVisit('resume')}><Play size={16} />Reanudar visita</button><button type="button" disabled={locked || visit.status === 'finished'} onClick={() => void changeVisit('finish')}><Square size={16} />Finalizar visita</button></div>
      <p className="muted">Las familias consultan las muestras de sus tres finalistas y después regresan para marcar su cédula por aula.</p></div>}
    {staleDisplay && <p className="notice warning">La clasificación cambió. Actualice el ranking y vuelva a iniciar la visita para proyectar las finalistas vigentes.</p>}
    {busy && <p role="status">Actualizando la pantalla pública…</p>}
    {error && <div className="notice danger" role="alert">{error}</div>}
    {needsRefresh && <button type="button" className="secondary" disabled={busy} onClick={() => void sync()}><RefreshCw size={16} />Actualizar datos de proyección</button>}
  </section>;
}
