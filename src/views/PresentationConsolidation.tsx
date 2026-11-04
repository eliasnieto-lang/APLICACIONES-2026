import { useId, useState } from 'react';
import type { Area, Block, PresentationEvaluation, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import {
  PRESENTATION_INDICATORS, presentationCategoryAssessment, presentationScore,
  presentationTeacherInScope,
} from '../../shared/presentation';

const format = (value: number | null) => value === null ? 'Pendiente' : value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const messageOf = (problem: unknown) => problem instanceof Error ? problem.message : String(problem);
const labels = {
  pending: 'Fichas pendientes', ready: 'Lista para validar', tie: 'Empate de corte',
  less_than_three: 'Menos de tres opciones aptas', published: 'Publicada',
  eligible: 'Apta', ineligible: 'No alcanza el corte',
};

export default function PresentationConsolidation({ snapshot, api, refresh, notify }: ViewProps) {
  const { state } = snapshot;
  const fieldPrefix = useId();
  const [area, setArea] = useState<Area>('MAT');
  const [block, setBlock] = useState<Block>('P1');
  const [statement, setStatement] = useState('');
  const [folio, setFolio] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reopening, setReopening] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState('');

  if (snapshot.actor.role !== 'coordinator') return <div className="notice">La consolidación y las fichas individuales requieren el acceso de coordinación.</div>;

  const assessment = presentationCategoryAssessment(state, area, block);
  const teachers = state.teachers.filter(teacher => presentationTeacherInScope(teacher, area, block));
  const evaluations = (state.presentationEvaluations ?? []).filter(evaluation => evaluation.area === area && evaluation.block === block);
  const shortlists = (state.presentationShortlists ?? []).filter(shortlist => shortlist.area === area && shortlist.block === block).slice().sort((a, b) => b.version - a.version);
  const categoryLabel = `${AREAS.find(item => item.id === area)?.label} · ${BLOCKS.find(item => item.id === block)?.label}`;
  const publisherName = (id: string) => state.publishers.find(publisher => publisher.id === id)?.name ?? 'Editorial';

  function changeCategory(nextArea: Area, nextBlock: Block) {
    setArea(nextArea); setBlock(nextBlock); setStatement(''); setFolio(''); setApproved(false);
    setReopening(null); setReason(''); setError('');
  }

  async function run(action: string, payload: Record<string, unknown>, message: string, after?: () => void) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.call(action, payload);
      after?.();
      notify(message);
      await refresh().catch(problem => setError(`La operación fue confirmada. No se pudo actualizar la pantalla: ${messageOf(problem)}`));
    } catch (problem) { setError(messageOf(problem)); }
    finally { setBusy(false); }
  }

  return <div className="stack">
    <div><h1>Consolidación de exposiciones</h1><p className="muted">Una ficha por docente, editorial y categoría. Cada promedio incorpora todas las fichas cerradas del área y bloque; es provisional hasta que cierre la totalidad de docentes inscritos.</p></div>

    <div className="grid" aria-label="Categoría de consolidación">{AREAS.flatMap(nextArea => BLOCKS.map(nextBlock => {
      const result = presentationCategoryAssessment(state, nextArea.id, nextBlock.id);
      const selected = area === nextArea.id && block === nextBlock.id;
      return <button type="button" className={`card ${selected ? 'selected' : 'secondary'}`} key={`${nextArea.id}-${nextBlock.id}`} aria-pressed={selected} disabled={busy} onClick={() => changeCategory(nextArea.id, nextBlock.id)}><strong>{nextArea.label} · {nextBlock.label}</strong><span style={{ display: 'block' }}>{labels[result.state]}</span></button>;
    }))}</div>

    {error && <div className="notice error" role="alert">{error}</div>}

    <section className="card stack">
      <div className="row"><h2>{categoryLabel}</h2><span className="status">{labels[assessment.state]}</span></div>
      <div className="grid"><div><strong>{assessment.registered}</strong><p>Docentes inscritos</p></div><div><strong>{assessment.closed}</strong><p>Fichas cerradas</p></div><div><strong>{assessment.pending}</strong><p>Fichas pendientes</p></div></div>
      <p className="muted">Diez criterios de igual peso, escala 0/1/2; puntaje sobre 100 y corte de {state.settings.rules.threshold}/100. Las fichas pendientes conservan sus respuestas sin convertirse en cero.</p>
      {assessment.reasons.length > 0 && <ul>{assessment.reasons.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {assessment.ranked.length === 0 ? <div className="notice">Todavía no hay editoriales disponibles en esta categoría.</div> : <div className="table-wrap"><table><thead><tr><th>Editorial</th><th>Inscritos</th><th>Cerradas</th><th>Pendientes</th><th>Promedio /100</th><th>I2 /2</th><th>Estado</th></tr></thead><tbody>{assessment.ranked.map(result => <tr key={result.publisherId}><td><strong>{publisherName(result.publisherId)}</strong>{state.turn.publisherId === result.publisherId && <div className="status">Turno actual</div>}{assessment.finalists.includes(result.publisherId) && <div className="status">Propuesta de terna</div>}{assessment.tied.includes(result.publisherId) && <div className="status">Empate de corte</div>}</td><td>{result.registered}</td><td>{result.closed}</td><td>{result.pending}{result.drafts > 0 && <div className="muted">{result.drafts} en borrador</div>}</td><td>{format(result.score)}{result.score !== null && result.pending > 0 && <div className="muted">Provisional</div>}</td><td>{format(result.i2)}</td><td>{labels[result.state]}</td></tr>)}</tbody></table></div>}
    </section>

    <section className="card stack"><h2>Promedios por criterio</h2><p className="muted">Escala de 0 a 2. Se promedian las fichas cerradas de esta categoría; los resultados son provisionales mientras haya fichas pendientes.</p>
      {assessment.ranked.length > 0 && <div className="table-wrap"><table><thead><tr><th>Criterio</th>{assessment.ranked.map(result => <th key={result.publisherId}>{publisherName(result.publisherId)}{result.pending > 0 && <div className="muted">Provisional</div>}</th>)}</tr></thead><tbody>{PRESENTATION_INDICATORS.map((indicator, index) => <tr key={indicator.id}><th scope="row">{indicator.id} · {indicator.label}</th>{assessment.ranked.map(result => {
        const closed = evaluations.filter(evaluation => evaluation.publisherId === result.publisherId && evaluation.status === 'closed' && presentationScore(evaluation) !== null && teachers.some(teacher => teacher.id === evaluation.teacherId));
        const values = closed.map(evaluation => evaluation.scores[index]);
        const average = values.length > 0 && values.every(value => value !== null && value !== undefined) ? (values as number[]).reduce((sum, value) => sum + value, 0) / values.length : null;
        return <td key={result.publisherId}>{format(average)}</td>;
      })}</tr>)}</tbody></table></div>}
    </section>

    <section className="card stack"><h2>Fichas individuales · acceso de coordinación</h2><p className="muted">Cada docente conserva su valoración independiente. Coordinación puede consultar las fichas y documentar una reapertura para que el docente corrija su respuesta.</p>
      {assessment.ranked.map(result => <details key={result.publisherId} className="stack"><summary><strong>{publisherName(result.publisherId)}</strong> · {result.closed} cerradas de {result.registered} fichas</summary>
        {teachers.length === 0 ? <p className="muted">No hay docentes inscritos en esta categoría.</p> : <div className="stack">{teachers.map(teacher => {
          const evaluation = evaluations.find(item => item.publisherId === result.publisherId && item.teacherId === teacher.id);
          return <article className="card stack" key={teacher.id}><div className="row"><strong>{teacher.name}</strong><span className="status">{evaluation?.status === 'closed' ? 'Cerrada' : evaluation ? 'Borrador' : 'Sin comenzar'}</span></div>{evaluation ? <>
            <p>Puntaje individual: {format(presentationScore(evaluation))} /100 · versión {evaluation.version}{evaluation.closedAt ? ` · cierre ${new Date(evaluation.closedAt).toLocaleString('es-PE')}` : ''}</p>
            <IndividualEvaluation evaluation={evaluation} />
            {evaluation.status === 'closed' && <button type="button" className="secondary" disabled={busy} onClick={() => { setReopening({ id: evaluation.id, label: `${teacher.name} · ${publisherName(result.publisherId)} · ${categoryLabel}` }); setReason(''); }}>Reabrir ficha con motivo</button>}
            {state.audit.some(item => item.referenceId === evaluation.id) && <details><summary>Historial documentado</summary><ul>{state.audit.filter(item => item.referenceId === evaluation.id).map(item => <li key={item.id}>{new Date(item.at).toLocaleString('es-PE')} · {item.actor} · {item.summary}{item.reason ? ` · Motivo: ${item.reason}` : ''}</li>)}</ul></details>}
          </> : <p className="muted">Aún no se ha guardado una ficha.</p>}</article>;
        })}</div>}
      </details>)}
    </section>

    {assessment.state !== 'published' && <section className="card stack"><h2>Validar y publicar terna de la categoría</h2><div className="notice">Retiro de editoriales: {state.settings.editorsWithdrawn ? `confirmado · ${state.settings.withdrawalReference}` : 'pendiente de registrar en Sala en vivo'}.</div><p>La propuesta corresponde a {categoryLabel}. La publicación conserva los puntajes agregados y la versión de las reglas.</p>
      {assessment.finalists.length > 0 && <ol>{assessment.finalists.map(id => <li key={id}>{publisherName(id)}</li>)}</ol>}
      {assessment.finalists.length > 0 && assessment.finalists.length < 3 && <div className="notice">Solo hay {assessment.finalists.length} editorial(es) apta(s) en esta categoría. La publicación de una terna requiere tres opciones aptas. Registre cualquier acuerdo excepcional mediante su procedimiento formal.</div>}
      <div className="field"><label htmlFor={`${fieldPrefix}-statement`}>Apreciación general del portavoz docente</label><textarea id={`${fieldPrefix}-statement`} rows={3} value={statement} onChange={event => setStatement(event.target.value)} /></div>
      <div className="field"><label htmlFor={`${fieldPrefix}-folio`}>Folio del acuerdo</label><input id={`${fieldPrefix}-folio`} value={folio} onChange={event => setFolio(event.target.value)} /></div>
      <label className="row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />Dirección validó la terna y su acuerdo.</label>
      <button type="button" disabled={busy || assessment.state !== 'ready' || assessment.pending > 0 || assessment.finalists.length !== 3 || !state.settings.editorsWithdrawn || !state.settings.withdrawalReference.trim() || !approved || !folio.trim() || !statement.trim()} onClick={() => void run('presentation_shortlist_publish', { area, block, directorApproved: approved, statement: statement.trim(), folio: folio.trim() }, 'Terna de exposición publicada con su historial.', () => { setStatement(''); setFolio(''); setApproved(false); })}>{busy ? 'Esperando confirmación…' : 'Publicar terna validada'}</button>
    </section>}

    <section className="card stack"><h2>Historial de ternas de exposición</h2><p className="muted">Estas publicaciones corresponden a editorial, área y bloque. Se conservan aparte de las ternas históricas por título y grado.</p>{shortlists.length === 0 ? <p className="muted">Todavía no hay publicaciones en esta categoría.</p> : shortlists.map(shortlist => <article key={shortlist.id} className="stack"><div className="row"><strong>Versión {shortlist.version}</strong><span className="status">{shortlist.status === 'published' ? 'Publicada' : 'Histórica'}</span></div><ol>{shortlist.publisherIds.map(id => <li key={id}>{shortlist.snapshot.publishers.find(publisher => publisher.id === id)?.name ?? publisherName(id)} · {format(shortlist.snapshot.assessment.ranked.find(result => result.publisherId === id)?.score ?? null)} /100</li>)}</ol><p>Folio: {shortlist.folio} · Reglas versión {shortlist.rulesVersion} · Corte {shortlist.snapshot.threshold}/100</p>{shortlist.statement && <p>{shortlist.statement}</p>}{shortlist.publishedAt && <p className="muted">Publicación: {new Date(shortlist.publishedAt).toLocaleString('es-PE')}</p>}</article>)}</section>

    {reopening && <section className="card stack" role="dialog" aria-labelledby="presentation-reopen-title"><h2 id="presentation-reopen-title">Reabrir ficha</h2><p>{reopening.label}</p><p>La reapertura conserva la versión anterior y deja la ficha disponible para su docente. Si hay una terna publicada en esta categoría, pasará al historial y deberá validarse y publicarse una nueva versión.</p><div className="field"><label htmlFor={`${fieldPrefix}-reopen-reason`}>Motivo obligatorio</label><textarea id={`${fieldPrefix}-reopen-reason`} rows={3} autoFocus value={reason} onChange={event => setReason(event.target.value)} /></div><div className="row"><button type="button" disabled={busy || !reason.trim()} onClick={() => void run('presentation_reopen', { evaluationId: reopening.id, reason: reason.trim() }, 'Ficha reabierta; historial conservado.', () => { setReopening(null); setReason(''); })}>Confirmar reapertura documentada</button><button type="button" className="secondary" disabled={busy} onClick={() => setReopening(null)}>Cancelar</button></div></section>}
  </div>;
}

function IndividualEvaluation({ evaluation }: { evaluation: PresentationEvaluation }) {
  return <div className="stack"><div className="table-wrap"><table><thead><tr><th>Criterio</th><th>Puntaje /2</th><th>Nota del docente</th></tr></thead><tbody>{PRESENTATION_INDICATORS.map((indicator, index) => <tr key={indicator.id}><th scope="row">{indicator.id} · {indicator.label}</th><td>{evaluation.scores[index] ?? 'Pendiente'}</td><td>{evaluation.notes[index]?.trim() || '—'}</td></tr>)}</tbody></table></div>{evaluation.generalObservation && <p><strong>Observación general:</strong> {evaluation.generalObservation}</p>}{evaluation.physicalText && <p><strong>Texto físico revisado:</strong> {evaluation.physicalText}</p>}</div>;
}
