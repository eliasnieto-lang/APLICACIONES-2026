import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { State } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { readAuditoriumDisplay, visitRemaining, type AuditoriumDisplay } from '../../shared/auditorium';
import EditorialInstructions from './EditorialInstructions';

/** A deleted editorial must never remain visible through an old projection snapshot. */
export function visibleAuditoriumDisplay(state: Pick<State, 'settings' | 'publishers'>): AuditoriumDisplay | null {
  const display = readAuditoriumDisplay(state.settings.auditoriumDisplay);
  if (!display || display.mode === 'instructions') return display;
  const available = new Set(state.publishers.map(publisher => publisher.id));
  const categories = display.categories.filter(category => category.publishers.every(publisher => available.has(publisher.id)));
  return categories.length ? { ...display, categories } : null;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
const score = (value: number) => value.toLocaleString('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

export default function AuditoriumScreen({ state, now }: { state: State; now: number }) {
  const display = visibleAuditoriumDisplay(state);
  const panel = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  useEffect(() => {
    const changed = () => setFull(Boolean(panel.current && document.fullscreenElement === panel.current));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  if (!display) return null;
  const remaining = visitRemaining(display.visit, now);
  const finished = display.mode === 'samples' && (display.visit?.status === 'finished' || remaining === 0);
  async function fullscreen() {
    setFullscreenError('');
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else if (panel.current?.requestFullscreen) await panel.current.requestFullscreen();
      else throw new Error('Pantalla completa no disponible.');
    } catch { setFullscreenError('Puede usar la opción de pantalla completa de su navegador para proyectar esta información.'); }
  }
  return <section ref={panel} className={`auditorium-screen stack ${display.mode === 'samples' ? 'auditorium-samples' : 'auditorium-instructions'}`} aria-label={display.mode === 'samples' ? 'Visita a mesas de muestra' : 'Indicaciones para las editoriales'}>
    <style>{styles}</style>
    <div className="row between auditorium-screen-toolbar"><span className="eyebrow">{display.mode === 'samples' ? 'TRES FINALISTAS POR ÁREA Y GRUPO DE GRADOS' : 'INDICACIONES GENERALES'}</span><button type="button" className="secondary no-print" onClick={() => void fullscreen()}>{full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}{full ? 'Salir de pantalla completa' : 'Pantalla completa'}</button></div>
    {fullscreenError && <p className="notice warning" role="status">{fullscreenError}</p>}
    {display.mode === 'instructions' ? <EditorialInstructions settings={state.settings} compact /> : <>
      <header className="auditorium-visit-header"><div><h2>Visita a las mesas de muestra</h2><p>Busque su área y grupo de grados. Acérquese a las mesas de las tres editoriales finalistas y revise sus ejemplares antes de votar.</p></div><div className="auditorium-visit-time"><span className="status">{finished ? 'Visita concluida' : display.visit?.status === 'paused' ? 'Visita pausada' : 'Tiempo para visitar las mesas'}</span><div role="timer" aria-label="Tiempo restante para visitar las mesas" className={`auditorium-visit-clock ${finished ? 'visit-complete' : ''}`}>{clock(remaining)}</div></div></header>
      {finished && <p className="notice success auditorium-visit-finished"><strong>Tiempo de visita concluido.</strong> Regresen al auditorio para la votación. Cada aula recibirá su ficha A5 con las tres propuestas finalistas de Matemática y Comunicación; marque una opción por área.</p>}
      {display.visit?.status === 'paused' && !finished && <p className="notice">El tiempo está pausado por Subdirección. Las propuestas finalistas continúan visibles para su consulta.</p>}
      <div className="auditorium-finalist-grid">{display.categories.map(category => <article key={`${category.area}-${category.block}`} className="card auditorium-finalist-category" aria-label={`${AREAS.find(area => area.id === category.area)?.label ?? category.area} · ${BLOCKS.find(block => block.id === category.block)?.label ?? category.block}`}>
        <span className="eyebrow">{AREAS.find(area => area.id === category.area)?.label ?? category.area}</span><h3>{BLOCKS.find(block => block.id === category.block)?.label ?? category.block}</h3>
        <ul>{category.publishers.map(publisher => <li key={publisher.id}><strong>{publisher.name}</strong><span>{score(publisher.score)} / 100 <small>Valoración docente</small></span></li>)}</ul>
      </article>)}</div>
      <p className="notice auditorium-family-choice"><strong>Los docentes orientan; las familias deciden.</strong> Las tres propuestas están clasificadas para votar. El primer puesto docente no determina la elección: elija la editorial que considere pertinente después de escuchar la exposición, conocer sus beneficios y precios y revisar el texto físico en las mesas.</p>
    </>}
  </section>;
}

const styles = `.auditorium-screen{min-width:0;border:1px solid var(--line);border-radius:14px;padding:clamp(18px,3vw,32px);background:#fff;color:var(--ink);scroll-margin-top:20px}.auditorium-screen:fullscreen{overflow:auto;border:0;border-radius:0;max-height:100dvh;width:100%;padding:clamp(20px,3vw,45px)}.auditorium-screen-toolbar{gap:12px;align-items:flex-start}.auditorium-screen-toolbar .eyebrow{margin:5px 0 0}.auditorium-screen-toolbar button{font-size:12px;flex-shrink:0}.auditorium-visit-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:24px}.auditorium-visit-header h2{font-size:clamp(24px,3vw,38px);margin:0 0 12px}.auditorium-visit-header p{font-size:clamp(14px,1.4vw,19px);margin:0;max-width:850px}.auditorium-visit-time{text-align:center}.auditorium-visit-clock{font-size:clamp(52px,7vw,100px);line-height:1.15;font-weight:750;font-variant-numeric:tabular-nums;color:#174d85;letter-spacing:-2px}.auditorium-visit-clock.visit-complete{color:#286243}.auditorium-finalist-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.auditorium-finalist-category{padding:18px;min-width:0}.auditorium-finalist-category>.eyebrow{font-size:11px;color:#174d85;margin-bottom:8px;letter-spacing:1.5px}.auditorium-finalist-category h3{font-size:clamp(15px,1.4vw,21px);margin:0 0 14px}.auditorium-finalist-category ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}.auditorium-finalist-category li{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-top:1px solid var(--line);padding-top:10px}.auditorium-finalist-category li strong{overflow-wrap:anywhere;font-size:clamp(14px,1.4vw,20px);min-width:0}.auditorium-finalist-category li>span{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:650;font-size:13px;flex-shrink:0}.auditorium-finalist-category small{display:block;font-size:9px;color:var(--muted);font-weight:400}.auditorium-screen .notice{margin:0}.auditorium-family-choice{font-size:clamp(13px,1.2vw,17px)}@media(max-width:1050px){.auditorium-finalist-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.auditorium-visit-header{grid-template-columns:minmax(0,1fr);gap:15px}.auditorium-finalist-grid{grid-template-columns:minmax(0,1fr)}.auditorium-visit-clock{font-size:65px}.auditorium-screen-toolbar{flex-direction:column}.auditorium-finalist-category li>span{white-space:normal;min-width:70px}.auditorium-screen-toolbar button{max-width:100%}}`;
