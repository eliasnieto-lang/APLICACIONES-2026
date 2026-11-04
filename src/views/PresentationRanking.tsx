import { useId, useState } from 'react';
import { Trophy, RefreshCw } from 'lucide-react';
import type { Area, Block, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { presentationDrawFinished, presentationRankingRows } from '../../shared/jornada';

const scoreText = (score: number | null) => score === null ? 'Pendiente' : score.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PresentationRanking({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const prefix = useId();
  const [area, setArea] = useState<Area>('MAT');
  const [block, setBlock] = useState<Block>('P1');
  const [top, setTop] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (snapshot.actor.role !== 'coordinator') return <div className="notice">El ranking de la jornada corresponde a Subdirección.</div>;
  const draw = state.presentationDraw;
  const ranking = state.presentationRanking;
  const drawFinished = presentationDrawFinished(state);
  const missingQuestions = draw?.publishers.filter(publisher => !(state.presentationQuestions ?? []).some(question => question.publisherId === publisher.id && question.status === 'answered')).length ?? 0;
  const category = ranking?.categories.find(item => item.area === area && item.block === block);
  const rows = category ? presentationRankingRows(category, top === 'all' ? null : Number(top)) : [];
  const staleDraw = !!ranking && ranking.drawId !== draw?.id;
  const staleResults = !!ranking?.stale;
  const name = (id: string) => state.publishers.find(publisher => publisher.id === id)?.name ?? draw?.publishers.find(publisher => publisher.id === id)?.name ?? 'Editorial no disponible';
  async function generate() {
    setBusy(true); setError('');
    try {
      await api.call('presentation_ranking_generate', { expectedVersion: ranking?.version ?? 0 });
      await refresh(); notify('Ranking generado con las fichas confirmadas en el servidor.');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'No se pudo generar el ranking.'); }
    finally { setBusy(false); }
  }
  return <div className="stack presentation-ranking"><style>{styles}</style>
    <header className="row between"><div><span className="eyebrow">CIERRE DE PRESENTACIONES</span><h1>Ranking y Top de editoriales</h1><p className="muted">Compare los resultados por área y categoría al terminar las exposiciones.</p></div><Trophy size={38} aria-hidden="true" /></header>
    <section className="card stack"><div className="row between"><div><h2>Generar ranking de la jornada</h2><p>{draw ? `${draw.completedPublisherIds.length} de ${draw.publishers.length} presentaciones finalizadas.` : 'Realice primero el sorteo en Sala en vivo.'}</p></div><button type="button" className="primary" disabled={busy || !drawFinished} onClick={() => void generate()}><RefreshCw size={17} />{busy ? 'Generando…' : ranking ? 'Actualizar ranking / Top' : 'Generar ranking / Top'}</button></div>
      {!drawFinished && <p className="notice">{missingQuestions ? `Falta marcar la confirmación de pregunta y respuesta en ${missingQuestions} editorial(es), desde Sala en vivo.` : 'El botón se habilita cuando se finalizan todos los turnos del sorteo desde Sala en vivo.'}</p>}
      <p className="muted">El ranking orientativo usa todas las fichas cerradas de la categoría en once criterios de escala 0–4, incluida la respuesta obligatoria, y no exige puntaje mínimo. Clasifica tres editoriales para la votación familiar; los padres eligen entre ellas y pueden elegir una distinta del primer puesto. Si faltan fichas, el resultado es provisional.</p>
      {error && <div className="notice danger" role="alert">{error}</div>}
    </section>
    {ranking ? <>
      <div className={`notice ${ranking.provisional ? 'warning' : ''}`} role="status"><strong>{ranking.provisional ? 'Ranking provisional: hay fichas pendientes.' : 'Ranking con las fichas cerradas de la jornada.'}</strong><p>Generado el {new Date(ranking.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })} · versión {ranking.version}. Si se guardan nuevas valoraciones, pulse «Actualizar ranking / Top».</p>{staleResults && <p><strong>Las valoraciones o la configuración cambiaron. Actualice el ranking para reflejar esos cambios.</strong></p>}{staleDraw && <p>Este resultado pertenece a un sorteo anterior. Genere el ranking de la jornada actual al finalizar sus presentaciones.</p>}</div>
      <section className="card ranking-filters" aria-label="Filtros del ranking">
        <label className="field" htmlFor={`${prefix}-area`}>Área<select aria-label="Área" id={`${prefix}-area`} value={area} onChange={event => setArea(event.target.value as Area)}>{AREAS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="field" htmlFor={`${prefix}-block`}>Categoría<select aria-label="Categoría" id={`${prefix}-block`} value={block} onChange={event => setBlock(event.target.value as Block)}>{BLOCKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="field" htmlFor={`${prefix}-top`}>Mostrar<select aria-label="Mostrar" id={`${prefix}-top`} value={top} onChange={event => setTop(event.target.value)}><option value="all">Todas las editoriales</option><option value="3">Top 3</option><option value="5">Top 5</option></select></label>
      </section>
      <section className="card stack"><div><h2>{AREAS.find(item => item.id === area)?.label} · {BLOCKS.find(item => item.id === block)?.label}</h2><p className="muted">{category ? `${category.registered} docentes · ${category.closed} fichas cerradas · ${category.pending} pendientes.` : 'No hay un resultado guardado para esta categoría.'}</p></div>
        {!category || category.registered === 0 ? <div className="empty-state">No hay valoraciones de docentes registrados en esta categoría.</div> : rows.length === 0 ? <div className="empty-state">Todavía no hay puntajes para este Top. Revise las fichas pendientes o seleccione todas las editoriales.</div> : <div className="table-wrap"><table className="ranking-table"><thead><tr><th>Puesto</th><th>Editorial</th><th>Promedio /100</th><th>Fichas cerradas</th><th>Situación</th></tr></thead><tbody>{rows.map(({ assessment, position, tied }) => <tr key={assessment.publisherId}>
          <td data-label="Puesto"><strong>{position === null ? '—' : `${position}.`}</strong>{tied && <small>Empate</small>}</td><th scope="row" data-label="Editorial">{name(assessment.publisherId)}</th>
          <td data-label="Promedio /100"><strong className="ranking-score">{scoreText(assessment.score)}</strong></td>
          <td data-label="Fichas cerradas">{assessment.closed} / {assessment.registered}<small>{assessment.pending} pendientes</small></td>
          <td data-label="Situación"><span className={`status ${assessment.pending > 0 || assessment.score === null ? 'pending' : ''}`}>{assessment.score === null ? 'Sin puntaje' : assessment.pending > 0 ? 'Provisional' : 'Valoración completa'}</span></td>
        </tr>)}</tbody></table></div>}
        <p className="muted">La posición docente no determina la elección familiar. Un cero registrado forma parte del promedio. Las fichas pendientes no se convierten en cero. El orden compara promedio e I2; las editoriales empatadas comparten puesto y se incluyen juntas en el límite del Top.</p>
      </section>
    </> : <section className="card empty-state">El ranking aparecerá aquí después de generarlo. Las valoraciones individuales se conservan en sus fichas.</section>}
  </div>;
}
const styles = `.presentation-ranking{min-width:0}.presentation-ranking h1{margin-bottom:8px}.presentation-ranking header p,.presentation-ranking .notice p:last-child{margin-bottom:0}.presentation-ranking .ranking-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.presentation-ranking small{display:block;color:var(--muted);margin-top:4px}.presentation-ranking .ranking-score{font-size:18px;color:var(--navy)}.presentation-ranking .ranking-table th[scope=row]{font-weight:700}.presentation-ranking .ranking-table td,.presentation-ranking .ranking-table th{vertical-align:top}@media(max-width:620px){.presentation-ranking .ranking-filters{grid-template-columns:1fr}.presentation-ranking .ranking-table thead{display:none}.presentation-ranking .ranking-table,.presentation-ranking .ranking-table tbody,.presentation-ranking .ranking-table tr,.presentation-ranking .ranking-table th,.presentation-ranking .ranking-table td{display:block;width:100%;min-width:0}.presentation-ranking .ranking-table tr{padding:14px 0;border-bottom:1px solid var(--line)}.presentation-ranking .ranking-table td,.presentation-ranking .ranking-table th[scope=row]{border:0;padding:6px 0}.presentation-ranking .ranking-table td:before,.presentation-ranking .ranking-table th[scope=row]:before{content:attr(data-label);display:block;color:var(--muted);font-size:10px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:3px}.presentation-ranking .table-wrap{overflow:visible}}`;
