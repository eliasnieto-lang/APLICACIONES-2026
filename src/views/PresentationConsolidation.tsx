import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, History, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import type { Area, Block, PresentationEvaluation, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import {
  PRESENTATION_INDICATORS, presentationCategoryAssessment, presentationScaleLabel, presentationScore,
  presentationTeacherInScope, presentationUsesCurrentRubric, presentationMaximum,
} from '../../shared/presentation';

const format = (value: number | null) => value === null ? 'Pendiente' : value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const messageOf = (problem: unknown) => problem instanceof Error ? problem.message : String(problem);
const labels = {
  pending: 'Fichas pendientes', ready: 'Lista para validar', tie: 'Empate de corte',
  less_than_three: 'Se requieren tres editoriales', published: 'Terna publicada',
  eligible: 'Completa', ineligible: 'Completa',
};
type StatusFilter = 'all' | 'closed' | 'pending' | 'historical';
type DialogState = { kind: 'publish' | 'history' } | { kind: 'criteria'; publisherId: string }
  | { kind: 'individual'; publisherId: string; teacherId: string }
  | { kind: 'reopen'; evaluationId: string; label: string };

const currentClosed = (evaluation: PresentationEvaluation | undefined): evaluation is PresentationEvaluation =>
  !!evaluation && presentationUsesCurrentRubric(evaluation) && evaluation.status === 'closed' && presentationScore(evaluation) !== null;

export default function PresentationConsolidation({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const currentClosedInState = currentClosed;
  const fieldPrefix = useId();
  const [area, setArea] = useState<Area>('MAT');
  const [block, setBlock] = useState<Block>('P1');
  const [publisherFilter, setPublisherFilter] = useState('all');
  const [teacherFilter, setTeacherFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tab, setTab] = useState<'results' | 'individuals'>('results');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [statement, setStatement] = useState('');
  const [folio, setFolio] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  if (snapshot.actor.role !== 'coordinator') return <div className="notice">La consolidación y las fichas individuales requieren el acceso del subdirector.</div>;

  // The assessment always receives the whole category. Display filters never alter the official mean or terna.
  const assessment = presentationCategoryAssessment(state, area, block);
  const teachers = state.teachers.filter(teacher => presentationTeacherInScope(teacher, area, block));
  const evaluations = (state.presentationEvaluations ?? []).filter(evaluation => evaluation.area === area && evaluation.block === block);
  const shortlists = (state.presentationShortlists ?? []).filter(shortlist => shortlist.area === area && shortlist.block === block).slice().sort((a, b) => b.version - a.version);
  const categoryLabel = `${AREAS.find(item => item.id === area)?.label} · ${BLOCKS.find(item => item.id === block)?.label}`;
  const publisherName = (id: string) => state.publishers.find(publisher => publisher.id === id)?.name ?? 'Editorial';
  const historicalFor = (publisherId: string) => evaluations.filter(evaluation => evaluation.publisherId === publisherId
    && !presentationUsesCurrentRubric(evaluation) && teachers.some(teacher => teacher.id === evaluation.teacherId));
  const visibleResults = assessment.ranked.filter(result => (publisherFilter === 'all' || result.publisherId === publisherFilter)
    && (statusFilter === 'all' || statusFilter === 'closed' && result.closed > 0
      || statusFilter === 'pending' && (result.pending > 0 || result.registered === 0)
      || statusFilter === 'historical' && historicalFor(result.publisherId).length > 0));
  const individualRows = assessment.ranked.filter(result => publisherFilter === 'all' || result.publisherId === publisherFilter)
    .flatMap(result => teachers.filter(teacher => teacherFilter === 'all' || teacher.id === teacherFilter).map(teacher => {
      const evaluation = evaluations.find(item => item.publisherId === result.publisherId && item.teacherId === teacher.id);
      const historical = !!evaluation && !presentationUsesCurrentRubric(evaluation);
      return { publisherId: result.publisherId, teacher, evaluation, historical };
    })).filter(row => statusFilter === 'all' || statusFilter === 'closed' && currentClosedInState(row.evaluation)
      || statusFilter === 'pending' && !currentClosedInState(row.evaluation) || statusFilter === 'historical' && row.historical);
  const canPublish = assessment.state === 'ready' && assessment.pending === 0 && assessment.finalists.length === 3
    && state.settings.editorsWithdrawn && !!state.settings.withdrawalReference.trim() && approved && !!folio.trim() && !!statement.trim();
  const dialogEvaluation = dialog?.kind === 'individual'
    ? evaluations.find(item => item.publisherId === dialog.publisherId && item.teacherId === dialog.teacherId) : undefined;
  const dialogTeacher = dialog?.kind === 'individual' ? teachers.find(teacher => teacher.id === dialog.teacherId) : undefined;
  const criteriaResult = dialog?.kind === 'criteria' ? assessment.ranked.find(result => result.publisherId === dialog.publisherId) : undefined;
  const selectedClosed = criteriaResult ? teachers.flatMap(teacher => {
    const own = evaluations.filter(evaluation => evaluation.publisherId === criteriaResult.publisherId && evaluation.teacherId === teacher.id);
    return own.length === 1 && currentClosedInState(own[0]) ? [own[0]] : [];
  }) : [];

  function changeCategory(nextArea: Area, nextBlock: Block) {
    setArea(nextArea); setBlock(nextBlock); setPublisherFilter('all'); setTeacherFilter('all'); setStatusFilter('all');
    setStatement(''); setFolio(''); setApproved(false); setDialog(null); setReason(''); setError('');
  }

  function resetFilters() {
    setPublisherFilter('all'); setTeacherFilter('all'); setStatusFilter('all');
  }

  async function run(action: string, payload: Record<string, unknown>, message: string, after?: () => void) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.call(action, payload);
      after?.(); notify(message);
      await refresh().catch(problem => setError(`La operación fue confirmada. No se pudo actualizar la pantalla: ${messageOf(problem)}`));
    } catch (problem) { setError(messageOf(problem)); }
    finally { setBusy(false); }
  }

  return <div className="stack presentation-consolidation">
    <style>{consolidationStyles}</style>
    <header className="consolidation-heading"><div><span className="eyebrow">PANEL DEL SUBDIRECTOR</span><h1>Consolidación y ternas</h1><p className="muted">Filtra la categoría y revisa sus resultados.</p></div><button type="button" className="secondary" onClick={() => { setError(''); setDialog({ kind: 'history' }); }}><History size={16} aria-hidden="true" />Historial de ternas{shortlists.length > 0 && <span className="status">{shortlists.length}</span>}</button></header>

    <section className="card consolidation-filters" aria-label="Filtros de consolidación">
      <div className="field"><label htmlFor={`${fieldPrefix}-area`}>Área</label><select id={`${fieldPrefix}-area`} value={area} disabled={busy} onChange={event => changeCategory(event.target.value as Area, block)}>{AREAS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${fieldPrefix}-block`}>Categoría</label><select id={`${fieldPrefix}-block`} value={block} disabled={busy} onChange={event => changeCategory(area, event.target.value as Block)}>{BLOCKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
      <div className="field"><label htmlFor={`${fieldPrefix}-publisher`}>Editorial</label><select id={`${fieldPrefix}-publisher`} value={publisherFilter} onChange={event => setPublisherFilter(event.target.value)}><option value="all">Todas las editoriales</option>{assessment.ranked.map(result => <option key={result.publisherId} value={result.publisherId}>{publisherName(result.publisherId)}</option>)}</select></div>
      <div className="field"><label htmlFor={`${fieldPrefix}-teacher`}>Docente <span className="muted">· fichas</span></label><select id={`${fieldPrefix}-teacher`} value={teacherFilter} onChange={event => { setTeacherFilter(event.target.value); if (event.target.value !== 'all') setTab('individuals'); }}><option value="all">Todos los docentes</option>{teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}</select></div>
      <div className="field"><label htmlFor={`${fieldPrefix}-status`}>Estado</label><select id={`${fieldPrefix}-status`} value={statusFilter} onChange={event => { const value = event.target.value as StatusFilter; setStatusFilter(value); if (value === 'historical') setTab('individuals'); }}><option value="all">Todos los estados</option><option value="closed">Cerradas</option><option value="pending">Pendientes</option><option value="historical">Históricas · escala anterior</option></select></div>
      <button type="button" className="consolidation-reset" onClick={resetFilters} disabled={publisherFilter === 'all' && teacherFilter === 'all' && statusFilter === 'all'}><RotateCcw size={15} aria-hidden="true" />Limpiar filtros</button>
    </section>

    {error && !dialog && <div className="notice error" role="alert">{error}</div>}

    <section className="card consolidation-workspace">
      <div className="consolidation-category"><div><h2>{categoryLabel}</h2><p className="muted consolidation-official">Promedio docente de las fichas cerradas de todos los docentes de la categoría. El filtro de docente solo cambia las fichas.</p></div><span className={`status ${assessment.state === 'ready' || assessment.state === 'published' ? 'success' : 'pending'}`}>{labels[assessment.state]}</span></div>
      <div className="consolidation-summary" aria-label="Participación de la categoría"><span><strong>{assessment.registered}</strong> participantes</span><span><strong>{assessment.closed}</strong> fichas cerradas</span><span className={assessment.pending > 0 ? 'consolidation-pending' : ''}><strong>{assessment.pending}</strong> pendientes</span></div>

      <div className="consolidation-proposal"><div><span className="eyebrow">PROPUESTA DE TERNA</span>{assessment.finalists.length ? <ol>{assessment.finalists.map(id => <li key={id}>{publisherName(id)}</li>)}</ol> : <p className="muted">{assessment.state === 'tie' ? 'Empate en el corte: revisión pendiente.' : 'Aún no hay tres editoriales con sus fichas completas.'}</p>}<span className="muted">Todas las editoriales de {area} · {block}, sin filtros. Los padres elegirán entre las tres clasificadas; el primer puesto no determina su elección.</span></div><button type="button" className="primary" onClick={() => { setError(''); setDialog({ kind: 'publish' }); }}>Revisar terna<ChevronRight size={17} aria-hidden="true" /></button></div>

      <div className="tabs consolidation-tabs" role="tablist" aria-label="Vista del consolidado"><button id={`${fieldPrefix}-results-tab`} type="button" role="tab" aria-selected={tab === 'results'} aria-controls={`${fieldPrefix}-results`} className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>Resultados</button><button id={`${fieldPrefix}-individuals-tab`} type="button" role="tab" aria-selected={tab === 'individuals'} aria-controls={`${fieldPrefix}-individuals`} className={tab === 'individuals' ? 'active' : ''} onClick={() => setTab('individuals')}>Fichas docentes</button></div>

      {tab === 'results' ? <div role="tabpanel" id={`${fieldPrefix}-results`} aria-labelledby={`${fieldPrefix}-results-tab`}><div className="consolidation-table-caption"><span>{visibleResults.length} de {assessment.ranked.length} editoriales</span><span>Orden orientativo: promedio de mayor a menor · sin puntaje mínimo</span></div>{visibleResults.length === 0 ? <EmptyResults onReset={resetFilters} /> : <div className="table-wrap"><table className="consolidation-results"><thead><tr><th>Editorial</th><th>Participantes</th><th>Cerradas</th><th>Pendientes</th><th>Promedio /100</th><th>Estado</th><th><span className="visually-hidden">Consultar</span></th></tr></thead><tbody>{visibleResults.map(result => <tr key={result.publisherId}><td data-label="Editorial"><strong>{publisherName(result.publisherId)}</strong>{assessment.finalists.includes(result.publisherId) && <span className="consolidation-rank">Propuesta {assessment.finalists.indexOf(result.publisherId) + 1}</span>}{assessment.tied.includes(result.publisherId) && <span className="status pending">Empate de corte</span>}{historicalFor(result.publisherId).length > 0 && <span className="consolidation-rank">{historicalFor(result.publisherId).length} ficha(s) anteriores pendientes de completar</span>}</td><td data-label="Participantes">{result.registered}</td><td data-label="Cerradas">{result.closed}</td><td data-label="Pendientes" className={result.pending ? 'consolidation-pending' : ''}>{result.pending}</td><td data-label="Promedio /100"><strong className="consolidation-score">{format(result.score)}</strong>{result.score !== null && result.pending > 0 && <span className="consolidation-rank">Provisional</span>}</td><td data-label="Estado"><span className={`status ${result.state === 'eligible' ? 'success' : result.state}`}>{labels[result.state]}</span></td><td className="consolidation-actions"><button type="button" aria-label={`Ver criterios de ${publisherName(result.publisherId)}`} onClick={() => { setError(''); setDialog({ kind: 'criteria', publisherId: result.publisherId }); }}><SlidersHorizontal size={14} aria-hidden="true" />Criterios</button><button type="button" aria-label={`Ver fichas de ${publisherName(result.publisherId)}`} onClick={() => { setPublisherFilter(result.publisherId); setTab('individuals'); }}>Fichas<ChevronRight size={14} aria-hidden="true" /></button></td></tr>)}</tbody></table></div>}</div>
        : <div role="tabpanel" id={`${fieldPrefix}-individuals`} aria-labelledby={`${fieldPrefix}-individuals-tab`}><div className="consolidation-table-caption"><span>{individualRows.length} fichas {teacherFilter !== 'all' ? `· ${teachers.find(teacher => teacher.id === teacherFilter)?.name ?? ''}` : '· todos los docentes'}</span><span>Escala actual 0–4 · las históricas no integran el promedio actual.</span></div>{individualRows.length === 0 ? <EmptyResults onReset={resetFilters} /> : <div className="table-wrap"><table className="consolidation-records"><thead><tr><th>Docente</th><th>Editorial</th><th>Estado de ficha</th><th>Puntaje /100</th><th><span className="visually-hidden">Consultar ficha</span></th></tr></thead><tbody>{individualRows.map(({ publisherId, teacher, evaluation, historical }) => <tr key={`${publisherId}-${teacher.id}`}><td data-label="Docente"><strong>{teacher.name}</strong></td><td data-label="Editorial">{publisherName(publisherId)}</td><td data-label="Estado de ficha"><span className={`status ${currentClosedInState(evaluation) ? 'success' : 'pending'}`}>{historical ? 'Histórica · pendiente de actualizar' : currentClosedInState(evaluation) ? 'Cerrada' : evaluation ? 'Borrador' : 'Sin comenzar'}</span>{historical && <span className="consolidation-rank">Escala anterior 0–2</span>}</td><td data-label="Puntaje /100">{evaluation ? format(presentationScore(evaluation)) : 'Pendiente'}</td><td className="consolidation-actions">{evaluation ? <button type="button" aria-label={`Ver ficha de ${teacher.name} · ${publisherName(publisherId)}`} onClick={() => { setError(''); setDialog({ kind: 'individual', publisherId, teacherId: teacher.id }); }}>Ver ficha<ChevronRight size={14} aria-hidden="true" /></button> : <span className="muted">Sin ficha guardada</span>}</td></tr>)}</tbody></table></div>}</div>}
    </section>

    {dialog && <Modal key={dialog.kind} title={dialog.kind === 'publish' ? 'Revisar terna' : dialog.kind === 'history' ? 'Historial de ternas' : dialog.kind === 'criteria' ? 'Promedios por criterio' : dialog.kind === 'reopen' ? 'Reabrir ficha' : 'Ficha docente'} busy={busy} onClose={() => setDialog(null)}>
      {error && <div className="notice error" role="alert">{error}</div>}
      {dialog.kind === 'publish' && <><p className="muted">{categoryLabel}</p><div className="notice">La valoración docente es orientativa, sin puntaje mínimo. Estas tres editoriales pasan a la votación familiar; los padres eligen la ganadora, independientemente del orden docente.</div><ol className="consolidation-proposed-list">{assessment.finalists.map(id => <li key={id}><strong>{publisherName(id)}</strong><span>{format(assessment.ranked.find(result => result.publisherId === id)?.score ?? null)} /100</span></li>)}</ol>{assessment.finalists.length !== 3 && <div className="notice warning">La votación familiar requiere exactamente tres editoriales clasificadas. No se exige puntaje mínimo.</div>}{assessment.reasons.length > 0 && <div className="notice"><ul>{assessment.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{assessment.state === 'published' ? <div className="notice success">Esta categoría ya tiene una terna publicada. Consulta su acuerdo en el historial.</div> : <><div className={`notice ${state.settings.editorsWithdrawn && state.settings.withdrawalReference.trim() ? 'success' : 'warning'}`}>Retiro de editoriales: {state.settings.editorsWithdrawn && state.settings.withdrawalReference.trim() ? `confirmado · ${state.settings.withdrawalReference}` : 'pendiente de confirmar en Sala en vivo'}.</div><div className="field"><label htmlFor={`${fieldPrefix}-statement`}>Apreciación general del portavoz docente</label><textarea id={`${fieldPrefix}-statement`} rows={3} value={statement} onChange={event => setStatement(event.target.value)} required /></div><div className="field"><label htmlFor={`${fieldPrefix}-folio`}>Folio del acuerdo</label><input id={`${fieldPrefix}-folio`} value={folio} onChange={event => setFolio(event.target.value)} required /></div><label className="row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Dirección validó la terna y su acuerdo.</label><button type="button" className="primary" disabled={busy || !canPublish} onClick={() => void run('presentation_shortlist_publish', { area, block, directorApproved: approved, statement: statement.trim(), folio: folio.trim() }, 'Terna de exposición publicada con su historial.', () => { setStatement(''); setFolio(''); setApproved(false); setDialog(null); })}>{busy ? 'Esperando confirmación…' : 'Publicar terna validada'}</button></>}</>}

      {dialog.kind === 'criteria' && criteriaResult && <><div><h3>{publisherName(criteriaResult.publisherId)}</h3><p className="muted">{categoryLabel} · {selectedClosed.length} fichas cerradas · escala 0–4</p><p><strong>Promedio docente: {format(criteriaResult.score)} /100</strong>{criteriaResult.pending > 0 && ' · provisional'}</p></div><div className="table-wrap"><table><thead><tr><th>Criterio</th><th>Promedio /4</th></tr></thead><tbody>{PRESENTATION_INDICATORS.map((indicator, index) => <tr key={indicator.id}><th scope="row">{indicator.id} · {indicator.label}<span className="consolidation-description">{indicator.variants?.[area]?.description ?? indicator.description}</span></th><td>{format(selectedClosed.length ? selectedClosed.reduce((sum, evaluation) => sum + evaluation.scores[index]!, 0) / selectedClosed.length : null)}</td></tr>)}<tr><th scope="row">I11 · Respuesta a la pregunta obligatoria</th><td>{format(selectedClosed.length ? selectedClosed.reduce((sum, evaluation) => sum + (evaluation.responseScore ?? 0), 0) / selectedClosed.length : null)}</td></tr></tbody></table></div><details><summary>Desempate y cálculo</summary><p>Once criterios de igual peso, incluida la respuesta obligatoria. Suma máxima 44 × 100 / 44 = 100. El cero cuenta como cero; una respuesta pendiente no se promedia.</p><p>I2: {format(criteriaResult.i2)} /4. Los empates se comparan con I2; si persiste un empate en el corte de tres, la publicación queda pendiente.</p></details></>}

      {dialog.kind === 'individual' && dialogEvaluation && <><div><h3>{dialogTeacher?.name}</h3><p className="muted">{publisherName(dialog.publisherId)} · {categoryLabel}</p><span className={`status ${presentationUsesCurrentRubric(dialogEvaluation) ? '' : 'pending'}`}>{presentationUsesCurrentRubric(dialogEvaluation) ? 'Rúbrica actual: once criterios 0–4' : 'Ficha anterior: resultado conservado'}</span><p><strong>Puntaje individual: {format(presentationScore(dialogEvaluation))} /100</strong> · versión {dialogEvaluation.version}{dialogEvaluation.closedAt ? ` · cierre ${new Date(dialogEvaluation.closedAt).toLocaleString('es-PE')}` : ''}</p>{!presentationUsesCurrentRubric(dialogEvaluation) && <div className="notice">Ficha histórica de consulta. El docente debe completarla con la pregunta obligatoria; mientras tanto, cuenta como pendiente en el consolidado actual.</div>}</div><IndividualEvaluation evaluation={dialogEvaluation} />{currentClosedInState(dialogEvaluation) && <button type="button" className="secondary" onClick={() => { setReason(''); setDialog({ kind: 'reopen', evaluationId: dialogEvaluation.id, label: `${dialogTeacher?.name} · ${publisherName(dialog.publisherId)} · ${categoryLabel}` }); }}>Reabrir ficha con motivo</button>}<details><summary>Historial documentado</summary>{state.audit.some(item => item.referenceId === dialogEvaluation.id) ? <ul>{state.audit.filter(item => item.referenceId === dialogEvaluation.id).map(item => <li key={item.id}>{new Date(item.at).toLocaleString('es-PE')} · {item.actor} · {item.summary}{item.reason ? ` · Motivo: ${item.reason}` : ''}</li>)}</ul> : <p className="muted">Sin movimientos documentados para esta ficha.</p>}</details></>}

      {dialog.kind === 'history' && <><p className="muted">{categoryLabel}</p>{shortlists.length === 0 ? <div className="empty-state">Todavía no hay ternas publicadas en esta categoría.</div> : shortlists.map(shortlist => <details key={shortlist.id}><summary>Versión {shortlist.version} · {shortlist.status === 'published' ? 'Publicada' : 'Histórica'} · {shortlist.folio}</summary><ol>{shortlist.publisherIds.map(id => <li key={id}>{shortlist.snapshot.publishers.find(publisher => publisher.id === id)?.name ?? publisherName(id)} · {format(shortlist.snapshot.assessment.ranked.find(result => result.publisherId === id)?.score ?? null)} /100</li>)}</ol><p>Folio: {shortlist.folio} · Reglas versión {shortlist.rulesVersion} · Valoración docente orientativa</p>{shortlist.statement && <p>{shortlist.statement}</p>}{shortlist.publishedAt && <p className="muted">Publicación: {new Date(shortlist.publishedAt).toLocaleString('es-PE')}</p>}</details>)}</>}

      {dialog.kind === 'reopen' && <><p>{dialog.label}</p><div className="notice">La versión anterior se conserva. El docente podrá corregir su ficha. Si existe una terna publicada, pasará al historial y requerirá una nueva validación.</div><div className="field"><label htmlFor={`${fieldPrefix}-reopen-reason`}>Motivo obligatorio</label><textarea id={`${fieldPrefix}-reopen-reason`} rows={3} autoFocus value={reason} onChange={event => setReason(event.target.value)} required /></div><div className="row"><button type="button" className="primary" disabled={busy || !reason.trim()} onClick={() => void run('presentation_reopen', { evaluationId: dialog.evaluationId, reason: reason.trim() }, 'Ficha reabierta; historial conservado.', () => { setDialog(null); setReason(''); })}>Confirmar reapertura documentada</button><button type="button" className="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancelar</button></div></>}
    </Modal>}
  </div>;
}

function EmptyResults({ onReset }: { onReset(): void }) {
  return <div className="empty-state"><strong>No hay resultados con estos filtros.</strong><p>Prueba otra categoría o limpia los filtros de editorial, docente y estado.</p><button type="button" onClick={onReset}>Limpiar filtros</button></div>;
}

function Modal({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialogRef.current;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog className="consolidation-dialog" ref={dialogRef} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="consolidation-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Cerrar ventana" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button></div><div className="stack">{children}</div></dialog>;
}

function IndividualEvaluation({ evaluation }: { evaluation: PresentationEvaluation }) {
  const current = presentationUsesCurrentRubric(evaluation);
  return <div className="stack"><div className="table-wrap"><table><thead><tr><th>Criterio</th><th>Puntaje /{evaluation.scaleMax ?? 2}</th><th>Nota del docente</th></tr></thead><tbody>{PRESENTATION_INDICATORS.map((indicator, index) => <tr key={indicator.id}><th scope="row">{indicator.id} · {indicator.label}</th><td>{evaluation.scores[index] === null || evaluation.scores[index] === undefined ? 'Pendiente' : `${evaluation.scores[index]}${current ? ` · ${presentationScaleLabel(evaluation.scores[index])}` : ''}`}</td><td>{evaluation.notes[index]?.trim() || '—'}</td></tr>)}{current && <tr><th scope="row">I11 · Respuesta a la pregunta obligatoria</th><td>{evaluation.responseScore === null || evaluation.responseScore === undefined ? 'Pendiente' : `${evaluation.responseScore} · ${presentationScaleLabel(evaluation.responseScore)}`}</td><td>Versión de pregunta: {evaluation.questionVersion ?? 'pendiente'}</td></tr>}</tbody></table></div><p className="muted">Máximo de esta ficha: {presentationMaximum(evaluation)} puntos.</p>{evaluation.generalObservation && <p><strong>Observación general:</strong> {evaluation.generalObservation}</p>}{evaluation.physicalText && <p><strong>Texto físico revisado:</strong> {evaluation.physicalText}</p>}</div>;
}

const consolidationStyles = `
.presentation-consolidation{min-width:0}.presentation-consolidation p{margin-top:0}.consolidation-heading,.consolidation-category{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.consolidation-heading h1{margin:3px 0 5px}.consolidation-heading p{margin:0}.consolidation-heading>.secondary{font-size:12px}.consolidation-filters{display:grid;grid-template-columns:minmax(120px,1fr) minmax(170px,1.3fr) minmax(130px,1fr) minmax(140px,1fr) minmax(130px,1fr) auto;gap:12px;padding:18px;align-items:end}.consolidation-filters .field{min-width:0}.consolidation-filters label{font-size:11px;font-weight:700;letter-spacing:.3px}.consolidation-filters select{min-width:0;font-size:12px;padding-left:9px}.consolidation-reset{font-size:11px;min-height:43px;padding:8px}.consolidation-workspace{padding:24px;overflow:hidden}.consolidation-category{align-items:flex-start}.consolidation-category h2{font-size:19px;margin:0 0 6px}.consolidation-official{font-size:12px;margin-bottom:0}.consolidation-summary{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0 20px;color:var(--muted);font-size:12px}.consolidation-summary strong{font-size:17px;color:var(--ink);margin-right:4px}.consolidation-summary .consolidation-pending strong,.consolidation-pending{color:#996923}.consolidation-proposal{display:flex;align-items:center;justify-content:space-between;gap:18px;background:#f4f7fc;border:1px solid #e1e8f2;padding:17px 20px;border-radius:10px;margin-bottom:18px}.consolidation-proposal .eyebrow{font-size:9px;letter-spacing:1.4px}.consolidation-proposal ol{display:flex;flex-wrap:wrap;gap:8px 28px;padding:0 0 0 18px;margin:7px 0 4px;font-size:13px;font-weight:600}.consolidation-proposal .muted{font-size:11px}.consolidation-proposal p{margin:4px 0}.consolidation-proposal>button{flex-shrink:0;font-size:12px}.consolidation-tabs{margin-bottom:12px}.consolidation-tabs button{font-size:13px}.consolidation-table-caption{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--muted);padding:0 0 12px}.consolidation-rank{display:block;font-size:10px;color:var(--muted);margin-top:4px;font-weight:400}.consolidation-score{font-size:16px;color:var(--navy);white-space:nowrap}.consolidation-actions{white-space:nowrap;text-align:right}.consolidation-actions button{font-size:10px;padding:5px 7px;gap:3px}.consolidation-actions button+button{margin-left:5px}.consolidation-description{display:block;font-size:12px;text-transform:none;letter-spacing:0;font-weight:400;margin-top:5px;max-width:580px}.consolidation-dialog{width:min(800px,calc(100vw - 32px));max-height:88dvh;border:1px solid var(--line);border-radius:14px;padding:24px;color:var(--ink);box-shadow:0 24px 90px #102f5640;overscroll-behavior:contain}.consolidation-dialog::backdrop{background:#142d4f88}.consolidation-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:16px}.consolidation-dialog-header h2{margin:0}.consolidation-dialog-header button{padding:6px;border:0}.consolidation-dialog h3{margin:0 0 6px}.consolidation-dialog p{margin-top:0}.consolidation-dialog .notice ul{margin:0;padding-left:18px}.consolidation-proposed-list{padding-left:23px;margin:0}.consolidation-proposed-list li{padding:7px 0}.consolidation-proposed-list li span{margin-left:14px;color:var(--muted);font-size:12px}.consolidation-dialog .stack{gap:16px}
@media(max-width:1350px){.consolidation-filters{grid-template-columns:repeat(3,minmax(0,1fr))}.consolidation-reset{justify-self:start}}@media(max-width:760px){.consolidation-heading h1{font-size:25px}.consolidation-filters{grid-template-columns:repeat(2,minmax(0,1fr));padding:14px;gap:12px}.consolidation-filters .field:nth-child(2){grid-column:2}.consolidation-category h2{font-size:17px}.consolidation-workspace{padding:16px}.consolidation-summary{gap:8px 16px}.consolidation-proposal{align-items:flex-start;flex-direction:column;padding:14px}.consolidation-proposal ol{display:block;margin-left:0}.consolidation-proposal li{padding:2px 0}.consolidation-proposal>button{width:100%}.presentation-consolidation .table-wrap .consolidation-results,.presentation-consolidation .table-wrap .consolidation-records{display:block;min-width:0;width:100%}.consolidation-results thead,.consolidation-records thead{display:none}.consolidation-results tbody,.consolidation-records tbody{display:block}.consolidation-results tr,.consolidation-records tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:9px;margin-bottom:12px;padding:8px;gap:4px}.consolidation-results td,.consolidation-records td{display:block;min-width:0;border:0;padding:7px;overflow-wrap:anywhere}.consolidation-results td:before,.consolidation-records td:before{content:attr(data-label);display:block;font-size:10px;font-weight:400;color:var(--muted);margin-bottom:3px}.consolidation-results td:first-child,.consolidation-records td:first-child{grid-column:1/-1;font-size:14px}.consolidation-results .consolidation-actions,.consolidation-records .consolidation-actions{grid-column:1/-1;text-align:left;border-top:1px solid var(--line);padding-top:11px}.consolidation-actions button{font-size:12px;padding:6px 10px}.consolidation-dialog{padding:18px;max-height:92dvh}.consolidation-dialog th,.consolidation-dialog td{padding:9px}.consolidation-dialog-header h2{font-size:21px}.consolidation-table-caption span{overflow-wrap:anywhere}.consolidation-proposed-list li span{display:block;margin-left:0}}
`;
