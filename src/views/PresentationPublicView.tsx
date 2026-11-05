import MineduReference from '../components/MineduReference';
import PublicPaperLedger from '../components/PublicPaperLedger';
import { useEffect, useState } from 'react';
import type { Snapshot } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { timerAudioSample, useTimerSound } from '../timer-audio';
import { ROOM_SCRIPT, clockText, turnTiming, useServerClock, PresentationOrder, TimerSoundControls } from './LiveRoom';

export default function PresentationPublicView({ data, refresh }: { data: Snapshot; refresh(): Promise<void> }) {
  const { state: s } = data;
  const now = useServerClock(data.serverNow);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const current = s.publishers.find(publisher => publisher.id === s.turn.publisherId);
  const active = s.turn.status === 'running' || s.turn.status === 'paused';
  const timing = turnTiming(s.turn, now, s.settings.rules.presentationSeconds, s.settings.rules.transitionSeconds);
  const sound = useTimerSound(timerAudioSample(s.turn, timing.elapsed, s.settings.rules.presentationSeconds));
  const published = (s.presentationShortlists ?? []).filter(item => item.status === 'published');
  useEffect(() => { if (window.location.hash === '#votacion-padres') document.getElementById('votacion-padres')?.scrollIntoView(); }, [s.paperPolls?.length]);
  const sync = async () => { setBusy(true); setError(''); try { await refresh(); } catch (problem) { setError((problem as Error).message); } finally { setBusy(false); } };
  return <main className="stack" style={{ maxWidth: 1400, margin: '0 auto', padding: 'clamp(18px,4vw,45px)' }}>
    <header className="row between"><div><span className="eyebrow">{s.settings.school} · {data.dataset === 'demo' ? 'DEMOSTRACIÓN' : 'SALA PÚBLICA'}</span><h1>{s.settings.title}</h1></div><button disabled={busy} onClick={() => void sync()}>{busy ? 'Actualizando…' : 'Actualizar'}</button></header>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <PublicPaperLedger polls={s.paperPolls ?? []} />
    <MineduReference compact />
    {(active || published.length === 0 || Boolean(s.presentationDraw && s.presentationDraw.completedPublisherIds.length < s.presentationDraw.publishers.length)) && <>
      <section className="card stack" style={{ textAlign: 'center' }}>
        <span className="status">{s.turn.status === 'paused' ? 'Exposición pausada' : timing.transition ? 'Registro y cambio' : s.turn.status === 'ready' ? 'Antes de iniciar' : 'Exposición editorial'}</span>
        <h2>{current?.name ?? 'Próximamente iniciaremos las exposiciones'}</h2>
        <div role="timer" aria-label={timing.transition ? 'Tiempo de registro y cambio' : 'Tiempo de exposición'} className={`timer ${timing.warning ? 'warning' : ''} ${timing.finalSeconds ? 'expired' : ''}`}>{clockText(timing.remaining)}</div>
        {timing.finalSeconds ? <p className="notice danger">Últimos 5 segundos de exposición.</p> : timing.warning && <p className="notice warning">Último minuto de exposición.</p>}
        {timing.transition && <p>La exposición terminó. Registro y cambio de editorial.</p>}
        <p>Escuche la exposición y revise el texto físico entregado por la editorial.</p>
        <TimerSoundControls sound={sound} />
      </section>
      {s.presentationDraw && <PresentationOrder draw={s.presentationDraw} currentPublisherId={s.turn.status === 'ready' ? null : s.turn.publisherId} />}
      <section className="card"><h2>Guion de la exposición</h2>{ROOM_SCRIPT.map(([time, text]) => <p key={time}><strong>{time} min</strong> · {text}</p>)}<div className="notice">Las valoraciones individuales se registran en la sesión privada de cada docente. Los resultados se mostrarán después de su publicación por el Subdirector.</div></section>
    </>}
    {!active && published.map(list => <section key={list.id} className="card stack"><div><span className="status">Resumen publicado</span><h2>{AREAS.find(area => area.id === list.area)?.label} · {BLOCKS.find(block => block.id === list.block)?.label}</h2><p>Valoración de la exposición y del texto físico por categoría.</p></div><div className="grid">{list.publisherIds.map(id => {
      const publisher = list.snapshot.publishers.find(item => item.id === id);
      const row = list.snapshot.assessment.ranked.find(item => item.publisherId === id);
      return <article key={id} className="card"><h3>{publisher?.name ?? 'Editorial finalista'}</h3><p>Valoración de la exposición: <strong>{row?.score === null || row?.score === undefined ? 'Pendiente' : `${row.score.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 100`}</strong></p><p>{row?.closed ?? 0} valoraciones cerradas.</p></article>;
    })}</div><p>{list.statement}</p><p className="muted">Folio {list.folio} · versión {list.version} · {new Date(list.publishedAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })}</p></section>)}
  </main>;
}
