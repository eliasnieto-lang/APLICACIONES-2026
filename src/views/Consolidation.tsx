import { useState } from 'react';
import type { Book, CategoryAssessment, GradeId, Offer, Rules, Shortlist, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS, CHECKS, GRADES, assessBook, assessCategory, scoreEvaluation } from '../../shared/domain';

const labels: Record<string, string> = { review: 'En revisión', ready: 'Lista para validar', tie: 'Empate de corte', less_than_three: 'Menos de tres opciones comunes', published: 'Publicada', eligible: 'Apto', ineligible: 'No apto', pending: 'Pendiente', not_offered: 'Sin oferta para el grado', withdrawn: 'Retirada', pass: 'Conforme', fail: 'No conforme' };
const format = (value: number | null) => value === null ? 'Pendiente' : value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function Consolidation(props: ViewProps) {
  const { snapshot, api, refresh, notify } = props;
  const state = snapshot.state;
  const [categoryId, setCategoryId] = useState('MAT-P1');
  const [statement, setStatement] = useState('');
  const [folio, setFolio] = useState('');
  const [approved, setApproved] = useState(false);
  const [reviewUnit, setReviewUnit] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [exceptionGrade, setExceptionGrade] = useState<GradeId>('PRI1');
  const [exceptionOffers, setExceptionOffers] = useState<string[]>([]);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionFolio, setExceptionFolio] = useState('');
  const [exceptionResolution, setExceptionResolution] = useState('');
  const [exceptionApproved, setExceptionApproved] = useState(false);
  const [article113, setArticle113] = useState(false);
  const [reopening, setReopening] = useState<{ kind: 'shortlist' | 'evaluation'; id: string; label: string } | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const assessment = assessCategory(state, categoryId);
  const [areaId, blockId] = categoryId.split('-');
  const block = BLOCKS.find(item => item.id === blockId)!;
  const offers = state.offers.filter(item => item.area === areaId && item.block === blockId);
  const shortlists = state.shortlists.filter(item => item.categoryId === categoryId).sort((a, b) => b.version - a.version);
  const published = shortlists.filter(item => item.status === 'published');
  const reviews = state.reviews.filter(item => item.categoryId === categoryId);
  const offeredForGrade = offers.filter(offer => offer.status === 'offered').map(offer => {
    const book = state.books.find(item => item.offerId === offer.id && item.gradeId === exceptionGrade && item.active);
    return { offer, book, result: book ? assessBook(state, book) : null };
  });
  const gradePending = offeredForGrade.some(item => item.result?.state === 'pending');
  const eligibleForGrade = offeredForGrade.filter(item => item.result?.state === 'eligible');
  const chosenValid = exceptionOffers.length > 0 && exceptionOffers.length <= 3 && exceptionOffers.every(id => eligibleForGrade.some(item => item.offer.id === id));
  const needs113 = exceptionOffers.length < 3;
  const resolved113 = state.incidents.some(item => item.folio === exceptionFolio.trim() && item.resolution.trim());
  const canException = assessment.state === 'less_than_three' && !gradePending && chosenValid && exceptionReason.trim() && exceptionFolio.trim() && exceptionApproved && (!needs113 || (article113 && (resolved113 || exceptionResolution.trim())));

  function offerName(offer: Offer | string) {
    const item = typeof offer === 'string' ? state.offers.find(entry => entry.id === offer) : offer;
    const series = state.series.find(entry => entry.id === item?.seriesId);
    const publisher = state.publishers.find(entry => entry.id === series?.publisherId);
    return `${series?.name ?? 'Serie sin nombre'} · ${publisher?.name ?? 'Editorial pendiente'} · ${item?.edition ?? ''}`;
  }
  async function action(name: string, payload: Record<string, unknown>, success: string, after?: () => void) {
    setBusy(true); setError('');
    try { await api.call(name, payload); await refresh(); notify(success); after?.(); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  async function publishException() {
    setBusy(true); setError('');
    try {
      if (needs113 && !resolved113) await api.call('incident_save', { incident: { id: '', version: 1, scope: 'article113', referenceId: `${categoryId}/${exceptionGrade}`, description: exceptionReason, resolution: exceptionResolution, folio: exceptionFolio.trim(), actor: snapshot.actor.name, createdAt: new Date().toISOString() } });
      await api.call('shortlist_exception', { gradeId: exceptionGrade, area: areaId, offerIds: exceptionOffers, reason: exceptionReason, folio: exceptionFolio.trim(), directorApproved: exceptionApproved, article113: needs113 && article113 });
      await refresh(); notify('Acuerdo específico del grado publicado con su incidencia y folio.');
      setExceptionOffers([]); setExceptionReason(''); setExceptionFolio(''); setExceptionResolution(''); setExceptionApproved(false); setArticle113(false);
    } catch (problem) { setError(errorMessage(problem)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  function changeCategory(value: string) {
    setCategoryId(value); setStatement(''); setFolio(''); setApproved(false); setReviewUnit(''); setReviewReason('');
    setExceptionGrade(BLOCKS.find(item => item.id === value.split('-')[1])!.gradeIds[0]);
    setExceptionOffers([]); setExceptionReason(''); setExceptionFolio(''); setExceptionResolution(''); setExceptionApproved(false); setArticle113(false); setError('');
  }
  if (snapshot.actor.role !== 'coordinator') return <div className="notice">La consolidación y la validación de ternas requieren acceso de Dirección o Subdirección.</div>;

  return <div className="stack">
    <div><h1>Consolidación técnica</h1><p className="muted">Las ternas corresponden a un área y bloque. Las familias eligen después por grado y área. Los precios y la cantidad de tomos no forman parte de la nota.</p></div>
    <div className="grid">{AREAS.flatMap(area => BLOCKS.map(item => {
      const id = `${area.id}-${item.id}`;
      const result = assessCategory(state, id);
      return <button type="button" className={`card ${id === categoryId ? 'selected' : 'secondary'}`} key={id} aria-pressed={id === categoryId} onClick={() => changeCategory(id)}><strong>{area.label} · {item.label}</strong><span style={{ display: 'block' }}>{labels[result.state]}</span></button>;
    }))}</div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="card stack">
      <div className="row"><h2>{AREAS.find(item => item.id === areaId)?.label} · {block.label}</h2><span className="status">{labels[assessment.state]}</span></div>
      <p>Reglas vigentes: versión {state.settings.rules.version} · corte por grado ≥ {state.settings.rules.threshold}/100 · {state.settings.rules.teacherCount} docentes distintos · diez indicadores de igual peso · desempate I2.</p>
      <p className="muted">{state.settings.rules.lockedAt ? `Reglas bloqueadas desde ${new Date(state.settings.rules.lockedAt).toLocaleString('es-PE')}. Las publicaciones conservan la versión aplicada.` : 'Las reglas se bloquearán con la primera evaluación recibida.'}</p>
      {assessment.reasons.length > 0 && <ul>{assessment.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      <div className="table-wrap"><table><thead><tr><th>Serie y editorial</th><th>Estado</th><th>Nota de bloque</th><th>I2</th><th>Revisión adicional</th><th>Motivos</th></tr></thead><tbody>{assessment.ranked.map(result => <tr key={result.offerId}><td>{offerName(result.offerId)}{assessment.finalists.includes(result.offerId) && <div className="status">Plaza técnica propuesta</div>}{assessment.tied.includes(result.offerId) && <div className="status">Empate de corte</div>}</td><td>{labels[result.state]}</td><td>{format(result.score)}</td><td>{format(result.i2)}</td><td>{result.additional === null ? 'No corresponde / pendiente' : format(result.additional)}</td><td>{result.reasons.join(' · ') || 'Verificaciones conformes'}</td></tr>)}</tbody></table></div>
      {offers.length === 0 && <div className="notice">No hay ofertas registradas en esta categoría. Una ausencia no se reemplaza por una nota cero.</div>}
    </section>

    <section className="card stack"><h2>Detalle por grado</h2><p className="muted">Cada grado debe superar el corte por sí mismo. El promedio del bloque no compensa una nota inferior al corte.</p>
      <div className="table-wrap"><table><thead><tr><th>Serie / título exacto y edición</th><th>Grado</th><th>Docentes cerrados</th><th>Nota</th><th>Filtros y expediente</th><th>Estado y causas</th></tr></thead><tbody>{offers.flatMap(offer => block.gradeIds.map(gradeId => {
        const book = state.books.find(item => item.offerId === offer.id && item.gradeId === gradeId && item.active);
        const result = book ? assessBook(state, book) : null;
        const initialAssignments = state.assignments.filter(item => item.bookId === book?.id && item.kind === 'initial');
        const closedAssignments = initialAssignments.filter(item => state.evaluations.some(entry => entry.assignmentId === item.id && entry.status === 'closed'));
        const distinct = new Set(closedAssignments.map(item => item.teacherId)).size;
        return <tr key={`${offer.id}-${gradeId}`}><td><strong>{offerName(offer)}</strong><div>{book ? `${book.title} · ${book.edition}` : 'Sin título ofrecido para este grado'}</div></td><td>{GRADES.find(item => item.id === gradeId)?.label}</td><td>{distinct}/{state.settings.rules.teacherCount}{initialAssignments.map(item => {
          const evaluation = state.evaluations.find(entry => entry.assignmentId === item.id);
          const teacher = state.teachers.find(entry => entry.id === item.teacherId);
          return <div key={item.id}>{teacher?.name ?? 'Docente'}: {evaluation?.status === 'closed' ? `${format(scoreEvaluation(evaluation))}/100 · cerrada` : 'pendiente'}{evaluation?.status === 'closed' && <button type="button" className="secondary" onClick={() => { setReopening({ kind: 'evaluation', id: item.id, label: `${teacher?.name ?? 'Docente'} · ${book?.title}` }); setReopenReason(''); }}>Reabrir con motivo</button>}</div>;
        })}</td><td>{format(result?.score ?? null)}</td><td>{book ? <><div>{book.dossierClosed ? 'Expediente cerrado' : 'Expediente pendiente'}</div>{CHECKS.map((check, index) => <div key={check.id}>{check.label}: {labels[book.checks[index]?.status ?? 'pending']}</div>)}</> : 'Sin oferta'}</td><td>{labels[result?.state ?? 'not_offered']}{result?.reasons.length ? <ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}</td></tr>;
      }))}</tbody></table></div>
    </section>

    {assessment.state === 'tie' && <section className="card stack"><h2>Segunda revisión comparable del empate de corte</h2><p>Los puntajes e I2 no separan la última plaza. Se solicitará la misma ficha y una unidad adicional a los mismos docentes de las series empatadas. Los puntajes originales se conservan.</p><ul>{assessment.tied.map(id => <li key={id}>{offerName(id)}</li>)}</ul><label className="field">Unidad adicional común y referencia<input value={reviewUnit} onChange={event => setReviewUnit(event.target.value)} placeholder="Unidad, páginas y criterio comparable" /></label><label className="field">Motivo documentado<textarea value={reviewReason} onChange={event => setReviewReason(event.target.value)} /></label><button type="button" disabled={busy || !reviewUnit.trim() || !reviewReason.trim() || assessment.tied.length < 2} onClick={() => void action('review_request', { categoryId, offerIds: assessment.tied, unitReference: reviewUnit, reason: reviewReason }, 'Revisión adicional asignada a los mismos docentes.')}>Solicitar revisión adicional</button></section>}
    {reviews.length > 0 && <section className="card stack"><h2>Revisiones adicionales registradas</h2>{reviews.map(review => <div key={review.id}><strong>Versión {review.version}: {review.unitReference}</strong><p>{review.reason}</p><p>{review.offerIds.map(offerName).join(' / ')}</p></div>)}</section>}

    {assessment.state !== 'published' && <section className="card stack"><h2>Validar y publicar terna común</h2><p>Solo se publican tres series aptas cuando no queden ofertas pendientes en esta categoría. Un empate que afecta la tercera plaza debe quedar resuelto.</p><div className="notice">Retiro de editoriales: {state.settings.editorsWithdrawn ? `confirmado · ${state.settings.withdrawalReference || 'sin referencia'}` : 'pendiente de registrar en la preparación de la jornada'}.</div><label className="field">Apreciación general del portavoz docente<textarea value={statement} onChange={event => setStatement(event.target.value)} placeholder="Apreciación cualitativa; no agrega puntos" rows={3} /></label><label className="field">Folio del acuerdo de validación<input value={folio} onChange={event => setFolio(event.target.value)} /></label><label className="row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Dirección validó esta terna y su acuerdo</label><button type="button" disabled={busy || assessment.state !== 'ready' || assessment.finalists.length !== 3 || !state.settings.editorsWithdrawn || !state.settings.withdrawalReference.trim() || !approved || !folio.trim() || !statement.trim()} onClick={() => void action('shortlist_publish', { categoryId, directorApproved: approved, statement, folio }, 'Terna publicada con su versión y reglas históricas.')}>{busy ? 'Procesando…' : 'Publicar versión validada de la terna'}</button></section>}

    {assessment.state === 'less_than_three' && <section className="card stack"><h2>Alternativas justificadas por grado</h2><p>Si no existen tres opciones comunes aptas, examine una terna específica del grado. Una ficha pendiente no acredita falta de pluralidad. Seleccione únicamente títulos aptos.</p><label className="field">Grado<select value={exceptionGrade} onChange={event => { setExceptionGrade(event.target.value as GradeId); setExceptionOffers([]); setArticle113(false); }}>{block.gradeIds.map(id => <option key={id} value={id}>{GRADES.find(item => item.id === id)?.label}</option>)}</select></label>
      <div className="table-wrap"><table><thead><tr><th>Incluir</th><th>Alternativa</th><th>Nota por grado</th><th>Estado y motivos</th></tr></thead><tbody>{offeredForGrade.map(({ offer, book, result }) => <tr key={offer.id}><td><input type="checkbox" aria-label={`Incluir ${offerName(offer)}`} checked={exceptionOffers.includes(offer.id)} disabled={result?.state !== 'eligible' || (!exceptionOffers.includes(offer.id) && exceptionOffers.length >= 3)} onChange={event => setExceptionOffers(current => event.target.checked ? [...current, offer.id] : current.filter(id => id !== offer.id))} /></td><td>{offerName(offer)}<div>{book?.title ?? 'Sin oferta para este grado'}</div></td><td>{format(result?.score ?? null)}</td><td>{labels[result?.state ?? 'not_offered']} · {result?.reasons.join(' · ')}</td></tr>)}</tbody></table></div>
      {gradePending && <div className="notice">Hay verificaciones pendientes en este grado. Complete la revisión antes de documentar falta real de opciones.</div>}
      <label className="field">Procedimiento, justificación y acuerdo documentado<textarea value={exceptionReason} onChange={event => setExceptionReason(event.target.value)} rows={4} /></label><label className="field">Folio del acuerdo e incidencia<input value={exceptionFolio} onChange={event => setExceptionFolio(event.target.value)} /></label>
      {needs113 && <div className="notice stack"><strong>Incidencia formal por falta de pluralidad — artículo 11.3</strong><p>La propuesta tiene {exceptionOffers.length} opciones. Debe constar la falta real y justificada de pluralidad, el procedimiento seguido y el acuerdo formal antes de habilitarla.</p>{resolved113 ? <p>Ya consta una incidencia resuelta con este folio.</p> : <label className="field">Resolución formal de la incidencia y acuerdo adoptado<textarea value={exceptionResolution} onChange={event => setExceptionResolution(event.target.value)} rows={3} /></label>}<label className="row"><input type="checkbox" checked={article113} onChange={event => setArticle113(event.target.checked)} />La incidencia y el procedimiento del artículo 11.3 están formalmente documentados</label></div>}
      <label className="row"><input type="checkbox" checked={exceptionApproved} onChange={event => setExceptionApproved(event.target.checked)} />Dirección aprobó el acuerdo específico de este grado</label><div className="notice">Retiro de editoriales: {state.settings.editorsWithdrawn ? 'confirmado' : 'pendiente'}.</div><button type="button" disabled={busy || !canException || !state.settings.editorsWithdrawn || !state.settings.withdrawalReference.trim()} onClick={() => void publishException()}>Registrar y publicar acuerdo específico del grado</button>
    </section>}

    <section className="card stack"><h2>Versiones de ternas</h2>{shortlists.length === 0 ? <p className="muted">Todavía no hay versiones publicadas.</p> : shortlists.map(shortlist => <ShortlistVersion key={shortlist.id} shortlist={shortlist} names={shortlist.offerIds.map(offerName)} onReopen={() => { setReopening({ kind: 'shortlist', id: shortlist.id, label: `${categoryId}, versión ${shortlist.version}` }); setReopenReason(''); }} busy={busy} />)}{published.length > 0 && <p className="muted">Las versiones publicadas conservan sus reglas y puntajes históricos. Una reapertura debe crear una nueva versión con motivo.</p>}</section>
    {reopening && <section className="card stack" role="dialog" aria-label="Reapertura documentada"><h2>Reabrir {reopening.kind === 'shortlist' ? 'terna' : 'ficha'}</h2><p>{reopening.label}</p><p>La acción conserva el historial y exige una nueva versión. Coordinación no modifica los puntajes emitidos por el docente.</p><label className="field">Motivo obligatorio<textarea value={reopenReason} onChange={event => setReopenReason(event.target.value)} autoFocus rows={3} /></label><div className="row"><button type="button" disabled={busy || !reopenReason.trim()} onClick={() => void action(reopening.kind === 'shortlist' ? 'shortlist_reopen' : 'evaluation_reopen', { [reopening.kind === 'shortlist' ? 'shortlistId' : 'assignmentId']: reopening.id, reason: reopenReason }, 'Reapertura documentada; se conserva el historial.', () => setReopening(null))}>Confirmar reapertura documentada</button><button type="button" className="secondary" disabled={busy} onClick={() => setReopening(null)}>Cancelar</button></div></section>}
  </div>;
}

function ShortlistVersion({ shortlist, names, onReopen, busy }: { shortlist: Shortlist; names: string[]; onReopen(): void; busy: boolean }) {
  const history = shortlist.snapshot && typeof shortlist.snapshot === 'object' ? shortlist.snapshot as { rules?: Rules; books?: Book[]; assessment?: CategoryAssessment } : null;
  return <article className="stack" style={{ borderTop: '1px solid var(--line, #ddd)', paddingTop: 16 }}><div className="row"><strong>Versión {shortlist.version} · {shortlist.status === 'published' ? 'publicada' : shortlist.status === 'superseded' ? 'reemplazada; historial' : 'borrador'}</strong><span className="status">Reglas {shortlist.rulesVersion}</span></div><p>{shortlist.scope === 'block' ? 'Terna común del bloque' : `Acuerdo por grado: ${shortlist.gradeIds.map(id => GRADES.find(item => item.id === id)?.label).join(', ')}`}{shortlist.article113 ? ' · Incidencia formal artículo 11.3' : ''}</p><ol>{names.map((name, index) => <li key={index}>{name}</li>)}</ol><p>Folio: {shortlist.folio} · Validación de Dirección: {shortlist.directorApproved ? 'sí' : 'pendiente'}</p>{shortlist.statement && <p>Apreciación del portavoz: {shortlist.statement}</p>}{shortlist.reason && <p>Acuerdo / motivo: {shortlist.reason}</p>}{shortlist.publishedAt && <p className="muted">Publicada: {new Date(shortlist.publishedAt).toLocaleString('es-PE')}. Snapshot histórico conservado.</p>}{history && <details><summary>Consultar títulos, notas y reglas de esta publicación</summary>{history.rules && <p>Reglas históricas {history.rules.version}: corte {history.rules.threshold}/100, {history.rules.teacherCount} docentes, {history.rules.indicatorCount} indicadores.</p>}{Array.isArray(history.books) && <div className="table-wrap"><table><thead><tr><th>Título publicado</th><th>Edición</th><th>Grado</th><th>Nota histórica</th></tr></thead><tbody>{history.books.map(book => <tr key={book.id}><td>{book.title}</td><td>{book.edition}</td><td>{GRADES.find(item => item.id === book.gradeId)?.label}</td><td>{format(history.assessment?.ranked.flatMap(item => item.grades).find(item => item.bookId === book.id)?.score ?? null)}</td></tr>)}</tbody></table></div>}</details>}{shortlist.status === 'published' && <button type="button" className="secondary" disabled={busy} onClick={onReopen}>Reabrir con motivo y nueva versión</button>}</article>;
}
