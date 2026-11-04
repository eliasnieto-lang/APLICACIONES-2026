import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Trash2, X } from 'lucide-react';
import type { ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { downloadBytes } from '../reports';

type Scope = 'all' | 'publisher' | 'teacher' | 'presentationEvaluation' | 'paperPoll' | 'draw' | 'ranking' | 'historical' | 'series' | 'offer' | 'book' | 'section' | 'incident' | 'question';
interface Preview { stateVersion: number; scope: Scope; ids: string[]; labels: string[]; counts: Record<string, number>; consequences: string[]; requiresFullConfirmation: boolean }
interface Choice { id: string; label: string }
const options: { value: Scope; label: string; multiple?: boolean }[] = [
  { value: 'publisher', label: 'Editoriales y sus registros asociados', multiple: true },
  { value: 'teacher', label: 'Docentes y sus evaluaciones', multiple: true },
  { value: 'presentationEvaluation', label: 'Fichas de evaluación', multiple: true },
  { value: 'question', label: 'Preguntas y respuestas de editoriales', multiple: true },
  { value: 'paperPoll', label: 'Votaciones de padres y sus votos', multiple: true },
  { value: 'draw', label: 'Sorteo y cronómetro' }, { value: 'ranking', label: 'Ranking / Top' },
  { value: 'series', label: 'Series del catálogo', multiple: true }, { value: 'offer', label: 'Ofertas del catálogo', multiple: true },
  { value: 'book', label: 'Títulos del catálogo', multiple: true }, { value: 'section', label: 'Secciones del padrón', multiple: true },
  { value: 'incident', label: 'Incidencias', multiple: true }, { value: 'historical', label: 'Archivo de elección anterior' },
  { value: 'all', label: 'Toda la información ingresada en este espacio' },
];
const countLabels: Record<string, string> = { publishers: 'Editoriales', teachers: 'Docentes', series: 'Series', offers: 'Ofertas', books: 'Títulos', assignments: 'Asignaciones', evaluations: 'Fichas históricas', presentationEvaluations: 'Fichas de exposición', presentationQuestions: 'Preguntas y respuestas', questions: 'Preguntas y respuestas', paperPolls: 'Votaciones de padres', paperTokens: 'Fichas A5 emitidas', responseScores: 'Valoraciones de respuestas', voteAggregates: 'Conteos históricos', presentationDraw: 'Sorteo', presentationRanking: 'Ranking', draws: 'Sorteos', rankings: 'Rankings', shortlists: 'Ternas históricas', presentationShortlists: 'Ternas de exposición', rounds: 'Rondas de elección', sections: 'Secciones', deliveries: 'Entregas', incidents: 'Incidencias', reviews: 'Revisiones', teacherAccesses: 'Accesos docentes', access: 'Accesos docentes', ballots: 'Códigos de voto históricos', aggregates: 'Conteos históricos', history: 'Registros de historial', audit: 'Registros de actividad' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'No se pudo completar la operación.';
const keyOf = (scope: Scope, ids: string[]) => JSON.stringify([scope, [...ids].sort()]);

export default function DataCleanup({ snapshot, api, refresh, notify }: ViewProps) {
  const state = snapshot.state;
  const [scope, setScope] = useState<Scope>('publisher'); const [ids, setIds] = useState<string[]>([]); const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null); const [confirmed, setConfirmed] = useState(false); const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const version = useRef(state.version); version.current = state.version;
  const request = useRef(''); request.current = keyOf(scope, ids);
  const areaName = (area?: string) => AREAS.find(item => item.id === area)?.label ?? area ?? '';
  const blockName = (block?: string) => BLOCKS.find(item => item.id === block)?.label ?? block ?? '';
  const publisherName = (id?: string) => state.publishers.find(item => item.id === id)?.name ?? 'Editorial no disponible';
  let choices: Choice[] = [];
  if (scope === 'publisher') choices = state.publishers.map(item => ({ id: item.id, label: item.name }));
  if (scope === 'teacher') choices = state.teachers.map(item => ({ id: item.id, label: item.name + (item.area ? ' · ' + areaName(item.area) : '') }));
  if (scope === 'presentationEvaluation') choices = (state.presentationEvaluations ?? []).map(item => ({ id: item.id, label: (state.teachers.find(teacher => teacher.id === item.teacherId)?.name ?? 'Docente no disponible') + ' · ' + publisherName(item.publisherId) + ' · ' + areaName(item.area) + ' · ' + blockName(item.block) + ' · ' + (item.status === 'closed' ? 'Cerrada' : 'Borrador') }));
  if (scope === 'question') choices = (state.presentationQuestions ?? []).map(item => ({ id: item.id, label: publisherName(item.publisherId) + ' · ' + item.question }));
  if (scope === 'paperPoll') choices = (state.paperPolls ?? []).map(item => ({ id: item.id, label: blockName(item.block) + ' · ' + item.areas.map(areaName).join(' y ') + ' · ' + (item.status === 'closed' ? 'Cerrada' : 'Abierta') + ' · ' + item.received + ' fichas recibidas' }));
  if (scope === 'series') choices = state.series.map(item => ({ id: item.id, label: publisherName(item.publisherId) + ' · ' + item.name }));
  if (scope === 'offer') choices = state.offers.map(item => ({ id: item.id, label: (state.series.find(series => series.id === item.seriesId)?.name ?? 'Serie no disponible') + ' · ' + areaName(item.area) + ' · ' + blockName(item.block) + ' · ' + item.edition }));
  if (scope === 'book') choices = state.books.map(item => ({ id: item.id, label: item.code + ' · ' + item.title + ' · ' + item.edition }));
  if (scope === 'section') choices = state.sections.map(item => ({ id: item.id, label: item.sourceGrade + ' · ' + item.label }));
  if (scope === 'incident') choices = state.incidents.map(item => ({ id: item.id, label: item.scope + ' · ' + item.description }));
  choices.sort((a, b) => a.label.localeCompare(b.label, 'es'));
  const multiple = options.find(item => item.value === scope)?.multiple;
  const shown = choices.filter(item => item.label.toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es')));
  const stale = Boolean(preview && preview.stateVersion !== state.version);
  const selectedPreview = preview && keyOf(preview.scope, preview.ids ?? []) === keyOf(scope, ids);
  const canApply = Boolean(selectedPreview && !stale && confirmed && (scope !== 'all' || phrase === 'ELIMINAR TODO'));
  useEffect(() => { if (stale) { setConfirmed(false); setPhrase(''); } }, [stale]);
  function clearPreview() { setPreview(null); setConfirmed(false); setPhrase(''); setError(''); }
  function changeScope(value: Scope) { setScope(value); setIds([]); setSearch(''); clearPreview(); setSuccess(''); }
  function select(value: string, checked: boolean) { setIds(current => checked ? [...new Set([...current, value])] : current.filter(id => id !== value)); clearPreview(); setSuccess(''); }
  async function examine() {
    if (busy || snapshot.actor.role !== 'coordinator') return;
    const current = request.current; setBusy(true); setError(''); setSuccess(''); setConfirmed(false); setPhrase('');
    try {
      const result = await api.call<Preview>('data_delete_preview', { scope, ids: [...ids].sort() });
      if (request.current !== current) return;
      setPreview(result);
      if (result.stateVersion !== version.current) setError('La información cambió mientras se preparaba el resumen. Revise nuevamente antes de eliminar.');
    } catch (problem) { setPreview(null); setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  async function erase() {
    if (busy || !canApply || !preview || snapshot.actor.role !== 'coordinator') return;
    setBusy(true); setError('');
    try {
      const result = await api.call<{ deleted: boolean }>('data_delete_apply', { scope: preview.scope, ids: preview.ids, expectedVersion: preview.stateVersion, confirmation: scope === 'all' ? 'ELIMINAR TODO' : 'ELIMINAR' });
      if (!result.deleted) throw new Error('El servidor no confirmó la eliminación. Actualice antes de continuar.');
      clearPreview(); setIds([]); setSuccess('Información eliminada. El acceso de Subdirección permanece activo.');
      notify('Información eliminada desde el servidor.');
      await refresh().catch(() => notify('La eliminación fue confirmada. Pulse Actualizar información para consultar la jornada.', true));
    } catch (problem) { setError(errorMessage(problem)); setConfirmed(false); setPhrase(''); const failure = problem as { status?: number; code?: string }; if (failure?.status === 409 || failure?.code === 'PT409') await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  async function backup() {
    setBusy(true); setError('');
    try { const result = await api.call('backup_get'); downloadBytes(JSON.stringify(result, null, 2), 'respaldo-antes-de-eliminar-' + snapshot.dataset + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', 'application/json'); notify('Respaldo privado descargado.'); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  if (snapshot.actor.role !== 'coordinator') return <section className="card"><h1>Eliminar información</h1><p>Esta opción corresponde únicamente a Subdirección.</p></section>;
  return <div className="data-cleanup stack"><style>{styles}</style>
    <header><span className="eyebrow">ADMINISTRACIÓN DE LA JORNADA</span><h1>Eliminar información</h1><p>Retire registros concretos o vacíe la información ingresada en este espacio.</p></header>
    <div className="notice cleanup-context"><strong>{snapshot.dataset === 'real' ? 'Información de Jornada real' : 'Información de Demostración'}</strong><span>Las acciones se aplican al espacio indicado. Su acceso de Subdirección y la configuración de la jornada se conservan.</span></div>
    {error && <div className="notice danger" role="alert">{error}</div>}{success && <div className="notice" role="status">{success}</div>}
    <section className="card stack"><div className="row between"><div><h2>1. Elija qué desea eliminar</h2><p className="muted">Primero revise la selección y los registros asociados. Abrir esta pantalla no elimina información.</p></div><button type="button" className="secondary" disabled={busy} onClick={() => void backup()}><Download size={17} />Descargar respaldo antes de eliminar</button></div>
      <label className="field">Información que deseas eliminar<select aria-label="Información que deseas eliminar" value={scope} disabled={busy} onChange={event => changeScope(event.target.value as Scope)}>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      {multiple ? <><label className="field">Buscar registros<input type="search" aria-label="Buscar registros" disabled={busy} value={search} onChange={event => setSearch(event.target.value)} placeholder="Nombre, editorial, docente o categoría" /></label><div className="row between"><span className="muted">{ids.length} seleccionados · {shown.length} resultados</span><div className="row"><button type="button" className="secondary" disabled={busy || !shown.length} onClick={() => { setIds(current => [...new Set([...current, ...shown.map(item => item.id)])]); clearPreview(); }}>Seleccionar todos los resultados</button><button type="button" className="secondary" disabled={busy || !ids.length} onClick={() => { setIds([]); clearPreview(); }}>Quitar selección</button></div></div>{shown.length ? <div className="cleanup-choices" role="group" aria-label="Registros para eliminar">{shown.map(item => <label key={item.id} className="cleanup-choice"><input type="checkbox" disabled={busy} checked={ids.includes(item.id)} onChange={event => select(item.id, event.target.checked)} aria-label={'Seleccionar ' + item.label} /><span>{item.label}</span></label>)}</div> : <p className="empty-state">No hay registros con esta selección.</p>}</> : <p className="notice">{scope === 'all' ? 'Se revisará toda la información ingresada: editoriales, docentes, evaluaciones, preguntas, votaciones y resultados. La confirmación final exige escribir ELIMINAR TODO.' : scope === 'draw' ? 'Se revisarán el sorteo y el cronómetro para volver a organizar los turnos.' : scope === 'ranking' ? 'Se revisará el ranking generado. Las fichas docentes se conservarán.' : 'Se revisará el archivo del procedimiento anterior por libro y grado.'}</p>}
      <button type="button" className="primary cleanup-preview-button" disabled={busy || Boolean(multiple && !ids.length)} onClick={() => void examine()}><RefreshCw size={17} />{busy ? 'Procesando…' : 'Revisar qué se eliminará'}</button>
    </section>
    {preview && selectedPreview && <section className="card stack cleanup-preview" aria-label="Resumen de eliminación"><div className="row between"><h2>2. Revise antes de confirmar</h2><button type="button" className="secondary" disabled={busy} onClick={clearPreview}><X size={16} />Cancelar eliminación</button></div><strong>{snapshot.dataset === 'real' ? 'Jornada real' : 'Demostración'} · {options.find(item => item.value === preview.scope)?.label}</strong>
      {stale && <div className="notice warning" role="alert">La información cambió desde esta revisión. Pulse «Revisar qué se eliminará» para preparar un resumen actualizado.</div>}
      {preview.labels?.length > 0 && <ul className="cleanup-labels">{preview.labels.map((label, index) => <li key={index}>{label}</li>)}</ul>}
      <div className="cleanup-counts" aria-label="Cantidad de registros asociados">{Object.entries(preview.counts ?? {}).filter(([, count]) => count > 0).map(([name, count]) => <div key={name}><strong>{count}</strong><span>{countLabels[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2')}</span></div>)}</div>
      {preview.consequences?.length > 0 && <div className="notice warning"><strong>También se aplicarán estos cambios:</strong><ul>{preview.consequences.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
      {(scope === 'all' || scope === 'teacher') && <p>Los docentes eliminados deberán registrarse nuevamente; sus accesos anteriores dejarán de funcionar.</p>}
      <p className="muted">La eliminación se confirma en el servidor. Conserve el respaldo si necesita una copia de esta información.</p>
      {scope === 'all' && <label className="field">Escribe ELIMINAR TODO<input aria-label="Escribe ELIMINAR TODO" autoComplete="off" spellCheck={false} disabled={busy || stale} value={phrase} onChange={event => setPhrase(event.target.value)} placeholder="ELIMINAR TODO" /></label>}
      <label className="cleanup-confirm"><input type="checkbox" disabled={busy || stale} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Confirmo que deseo eliminar la información indicada.</span></label>
      <button type="button" className="danger cleanup-delete-button" disabled={busy || !canApply} onClick={() => void erase()}><Trash2 size={18} />{busy ? 'Procesando…' : scope === 'all' ? 'Eliminar toda la información' : 'Eliminar información seleccionada'}</button>
    </section>}
  </div>;
}
const styles = '.data-cleanup{min-width:0}.data-cleanup h1{margin-bottom:8px}.data-cleanup h2{margin-top:0}.data-cleanup header p{margin-top:0}.data-cleanup .row{flex-wrap:wrap}.data-cleanup .cleanup-context{display:flex;flex-direction:column;gap:5px}.data-cleanup .cleanup-choices{display:grid;gap:6px;max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px}.data-cleanup .cleanup-choice{display:flex;gap:10px;padding:11px;border-radius:7px;align-items:flex-start;cursor:pointer;overflow-wrap:anywhere}.data-cleanup .cleanup-choice:hover{background:#f3f6fb}.data-cleanup .cleanup-choice input,.data-cleanup .cleanup-confirm input{flex:0 0 auto;width:18px;height:18px;margin-top:2px}.data-cleanup .cleanup-choice span{min-width:0}.data-cleanup .cleanup-counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.data-cleanup .cleanup-counts>div{display:flex;gap:8px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.data-cleanup .cleanup-counts strong{font-size:23px;color:var(--navy)}.data-cleanup .cleanup-counts span{font-size:12px}.data-cleanup .cleanup-labels{max-height:200px;overflow:auto;padding-left:23px;overflow-wrap:anywhere}.data-cleanup .cleanup-preview{border-color:#e8b4bd}.data-cleanup .cleanup-preview .notice ul{margin:7px 0 0;padding-left:22px}.data-cleanup .cleanup-confirm{display:flex;gap:10px;align-items:flex-start}.data-cleanup .cleanup-preview-button,.data-cleanup .cleanup-delete-button{align-self:flex-start}.data-cleanup .field{min-width:0}.data-cleanup select,.data-cleanup input[type=search]{width:100%;min-width:0}@media(max-width:620px){.data-cleanup .card{padding:18px}.data-cleanup h1{font-size:27px}.data-cleanup h2{font-size:20px}.data-cleanup button{max-width:100%;white-space:normal}.data-cleanup .row.between{align-items:flex-start;gap:12px}.data-cleanup .cleanup-counts{grid-template-columns:1fr 1fr}.data-cleanup .cleanup-counts>div{flex-direction:column;align-items:flex-start}.data-cleanup .cleanup-preview-button,.data-cleanup .cleanup-delete-button{width:100%}}';
