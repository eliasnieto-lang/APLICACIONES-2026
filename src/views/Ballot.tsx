import { useEffect, useRef, useState } from 'react';
import { AREAS, GRADES } from '../../shared/domain';
import type { Api, Area, GradeId } from '../../shared/types';

interface BallotOption { id: string; label: string; title: string; edition: string; publisher: string }
interface Preview { roundId: string; gradeId: GradeId; number: number; areas: Area[]; options: Partial<Record<Area, BallotOption[]>> }

export default function Ballot({ api, onExit }: { api: Api; onExit(): void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Partial<Record<Area, string | null>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const submitting = useRef(false);
  useEffect(() => { let active = true; api.call<Preview>('vote_preview').then(value => { if (active) setPreview(value); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'No se pudo consultar la ficha.'); }); return () => { active = false; }; }, [api]);
  async function cast() {
    if (submitting.current || !preview || !confirmed || preview.areas.some(area => !(area in choices))) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await api.call<{ accepted: boolean }>('vote_cast', { choices, confirmed: true });
      if (!result.accepted) throw new Error('No se recibió una confirmación válida del servidor.');
      setAccepted(true); setChoices({}); setConfirmed(false);
    } catch (e) { setError((e instanceof Error ? e.message : 'No se recibió confirmación del servidor.') + ' Si se interrumpió la conexión, reintente con la misma ficha. Solo la respuesta del servidor confirma la recepción.'); }
    finally { submitting.current = false; setBusy(false); }
  }
  if (accepted) return <div className="card stack" style={{ maxWidth: 720, margin: '2rem auto' }}><span className="status">Cédula recibida</span><h1>El servidor confirmó su voto</h1><p>Su ficha anónima quedó consumida. Gracias por participar.</p><button onClick={onExit}>Salir</button></div>;
  return <main className="stack" style={{ maxWidth: 850, margin: '2rem auto', padding: '0 1rem' }}>
    <div className="row"><h1>Votación familiar anónima</h1><button onClick={onExit} disabled={busy}>Salir</button></div>
    <p className="notice">Seleccione una opción o voto en blanco en cada área. Su ficha no solicita nombre ni sección. Revise sus elecciones antes de confirmar.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!preview ? <div className="card"><p>{error ? 'La ficha no está disponible. Puede salir e ingresar nuevamente su código.' : 'Consultando ficha en el servidor…'}</p></div> : <>
      <p><strong>{GRADES.find(g => g.id === preview.gradeId)?.label || preview.gradeId}</strong> · Ronda {preview.number}</p>
      {preview.areas.map(area => <fieldset className="card stack" key={area} disabled={busy}><legend><h2>{AREAS.find(a => a.id === area)?.label || area}</h2></legend>{(preview.options[area] || []).map(option => <label className="row ballot-choice" key={option.id} style={{ alignItems: 'flex-start', padding: '1rem', border: '1px solid #d8e1ed', borderRadius: 10 }}><input type="radio" name={area} checked={choices[area] === option.id} onChange={() => { setChoices(old => ({ ...old, [area]: option.id })); setConfirmed(false); }} /><span><strong>{option.title || option.label}</strong><br />{option.publisher} · Edición {option.edition}<br /><span className="muted">{option.label}</span></span></label>)}<label className="row" style={{ padding: '1rem' }}><input type="radio" name={area} checked={area in choices && choices[area] === null} onChange={() => { setChoices(old => ({ ...old, [area]: null })); setConfirmed(false); }} /><strong>Voto en blanco para esta área</strong></label></fieldset>)}
      <section className="card stack"><h2>Revise su cédula</h2>{preview.areas.map(area => <p key={area}><strong>{AREAS.find(a => a.id === area)?.label}: </strong>{!(area in choices) ? 'Falta seleccionar' : choices[area] === null ? 'En blanco' : preview.options[area]?.find(o => o.id === choices[area])?.title}</p>)}<label className="row"><input type="checkbox" checked={confirmed} disabled={busy || preview.areas.some(area => !(area in choices))} onChange={e => setConfirmed(e.target.checked)} />He revisado mi cédula y confirmo el envío definitivo.</label><button disabled={busy || !confirmed || preview.areas.some(area => !(area in choices))} onClick={() => void cast()}>{busy ? 'Esperando confirmación del servidor…' : 'Enviar cédula definitiva'}</button></section>
    </>}
  </main>;
}
