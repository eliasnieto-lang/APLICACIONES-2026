import { useEffect, useId, useRef, useState } from 'react';
import type { Assignment, Book, Evaluation, Score, Snapshot, ViewProps } from '../../shared/types';
import { AREAS, GRADES, INDICATORS, practiceSummary, scoreEvaluation, supportScoreConstraints } from '../../shared/domain';
import { loadDraft, removeDraft, saveDraft } from '../drafts';
import Dossier from './Dossier';

interface Fields { scores: Score[]; evidence: string[]; notes: string[]; objection: boolean; objectionDetail: string }
interface LocalDraft extends Fields { baseVersion: number; savedAt: string; closePending?: boolean }
const memoryDrafts = new Map<string, { owner: symbol; value: LocalDraft }>();
const blankFields = (): Fields => ({ scores: Array<Score>(10).fill(null), evidence: Array<string>(10).fill(''), notes: Array<string>(10).fill(''), objection: false, objectionDetail: '' });
const fieldsOf = (evaluation?: Evaluation): Fields => evaluation ? { scores: [...evaluation.scores], evidence: [...evaluation.evidence], notes: [...evaluation.notes], objection: evaluation.objection, objectionDetail: evaluation.objectionDetail } : blankFields();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
function isConflict(error: unknown) {
  const candidate = error as { code?: string; status?: number };
  return candidate?.code === 'PT409' || candidate?.status === 409 || /409|conflicto|otra pestaña|versión.*cambi|version.*conflict/i.test(messageOf(error));
}

export default function Evaluations(props: ViewProps) {
  const { snapshot } = props;
  const own = snapshot.state.assignments.filter(assignment => assignment.teacherId === snapshot.actor.id);
  const [selected, setSelected] = useState(own[0]?.id ?? '');
  const assignment = own.find(item => item.id === selected) ?? own[0];
  const book = snapshot.state.books.find(item => item.id === assignment?.bookId);
  if (snapshot.actor.role !== 'teacher') return <div className="notice">Esta ficha requiere el acceso individual del docente evaluador.</div>;
  const closed = own.filter(item => snapshot.state.evaluations.some(evaluation => evaluation.assignmentId === item.id && evaluation.teacherId === snapshot.actor.id && evaluation.status === 'closed')).length;
  return <div className="stack">
    <div><h1>Mis evaluaciones</h1><p className="muted">{snapshot.actor.name} · {closed} cerradas de {own.length} asignadas. Cada ficha requiere un cierre explícito confirmado por el servidor.</p></div>
    {own.length === 0 ? <div className="notice">Aún no tiene textos asignados. Coordinación debe registrar sus asignaciones.</div> : <>
      <label className="field">Texto que va a evaluar<select value={assignment?.id ?? ''} onChange={event => setSelected(event.target.value)}>{own.map(item => {
        const title = snapshot.state.books.find(entry => entry.id === item.bookId);
        const offer = snapshot.state.offers.find(entry => entry.id === title?.offerId);
        const series = snapshot.state.series.find(entry => entry.id === offer?.seriesId);
        const publisher = snapshot.state.publishers.find(entry => entry.id === series?.publisherId);
        const done = snapshot.state.evaluations.some(entry => entry.assignmentId === item.id && entry.status === 'closed');
        return <option key={item.id} value={item.id}>{done ? '✓ ' : ''}{title?.title ?? 'Texto pendiente'} · {GRADES.find(grade => grade.id === title?.gradeId)?.label} · {offer?.area === 'MAT' ? 'Matemática' : 'Comunicación'} · {publisher?.name} · {series?.name}{item.kind === 'additional' ? ' · Revisión adicional' : ''}</option>;
      })}</select></label>
      {assignment && book && <EvaluationEditor key={assignment.id} {...props} assignment={assignment} book={book} onNext={() => {
        const index = own.findIndex(item => item.id === assignment.id);
        const next = [...own.slice(index + 1), ...own.slice(0, index)].find(item => !snapshot.state.evaluations.some(entry => entry.assignmentId === item.id && entry.status === 'closed'));
        if (next) setSelected(next.id);
      }} />}
    </>}
  </div>;
}

function EvaluationEditor({ snapshot, api, refresh, notify, assignment, book, onNext }: ViewProps & { assignment: Assignment; book: Book; onNext(): void }) {
  const fieldPrefix = useId();
  const initial = snapshot.state.evaluations.find(item => item.assignmentId === assignment.id && item.teacherId === snapshot.actor.id);
  const [fields, setFields] = useState<Fields>(() => fieldsOf(initial));
  const fieldsRef = useRef(fields);
  const versionRef = useRef(initial?.version ?? 0);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const owner = useRef(Symbol('evaluation-editor'));
  const memoryKey = `${api.draftSecret()}/${api.dataset}/${assignment.id}`;
  const blockedLocal = useRef(false);
  const closedRef = useRef(initial?.status === 'closed');
  const [closed, setClosed] = useState(closedRef.current);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(initial ? 'Guardado en servidor' : 'Sin respuestas; aún no guardado');
  const [localError, setLocalError] = useState('');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<LocalDraft | null>(null);
  const [recoveryInMemory, setRecoveryInMemory] = useState(false);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [serverConflict, setServerConflict] = useState<Evaluation | null>(null);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closePending, setClosePending] = useState(false);
  const closePendingRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [dossierOpen, setDossierOpen] = useState(false);
  const offer = snapshot.state.offers.find(item => item.id === book.offerId);
  const series = snapshot.state.series.find(item => item.id === offer?.seriesId);
  const publisher = snapshot.state.publishers.find(item => item.id === series?.publisherId);
  const practice = practiceSummary(book);
  const support = supportScoreConstraints(book);
  const review = snapshot.state.reviews.find(item => item.id === assignment.reviewId);
  const completed = fields.scores.filter(value => value !== null).length;
  const score = scoreEvaluation(fields.scores);
  const missingEvidence = fields.evidence.some(reference => !reference.trim());
  const valid = completed === 10 && !missingEvidence && (!fields.objection || fields.objectionDetail.trim().length > 0) && !support.pending;

  function localValue(): LocalDraft { return { ...fieldsRef.current, baseVersion: versionRef.current, savedAt: new Date().toISOString(), closePending: closePendingRef.current }; }
  async function persistLocal() {
    if (closedRef.current) return;
    const existing = memoryDrafts.get(memoryKey);
    if (!alive.current && existing && existing.owner !== owner.current) return;
    const value = localValue();
    memoryDrafts.set(memoryKey, { owner: owner.current, value });
    if (blockedLocal.current) return;
    try { await saveDraft(api.draftSecret(), api.dataset, assignment.id, value); if (alive.current) setLocalError(''); }
    catch (problem) { if (alive.current) setLocalError(messageOf(problem)); }
  }
  async function clearLocal(force = false) {
    const existing = memoryDrafts.get(memoryKey);
    if (!force && existing && existing.owner !== owner.current) return;
    memoryDrafts.delete(memoryKey);
    try { await removeDraft(api.draftSecret(), api.dataset, assignment.id); }
    catch (problem) { if (alive.current) setLocalError(messageOf(problem)); }
  }
  function edit(next: Fields) {
    fieldsRef.current = next;
    dirtyRef.current = true;
    revision.current += 1;
    setFields(next);
    setStatus('Sin sincronizar');
    setError('');
    void persistLocal();
  }
  function editArray(key: 'scores' | 'evidence' | 'notes', index: number, value: Score | string) {
    const next = { ...fieldsRef.current, [key]: fieldsRef.current[key].map((item, position) => position === index ? value : item) } as Fields;
    edit(next);
  }

  async function saveCurrent(): Promise<Evaluation | null> {
    if (busy.current || closedRef.current || conflictRef.current || !dirtyRef.current) return null;
    busy.current = true;
    if (alive.current) { setSaving(true); setStatus('Guardando en servidor…'); setError(''); }
    const sentRevision = revision.current;
    try {
      const saved = await api.call<Evaluation>('evaluation_save', { assignmentId: assignment.id, ...fieldsRef.current, expectedVersion: versionRef.current });
      versionRef.current = saved.version;
      if (sentRevision === revision.current) {
        dirtyRef.current = false;
        if (!blockedLocal.current && !closePendingRef.current) await clearLocal();
        else if (closePendingRef.current) await persistLocal();
        if (alive.current) setStatus('Guardado en servidor');
      } else {
        await persistLocal();
        if (alive.current) { setStatus('Sin sincronizar: hay cambios posteriores'); setTick(value => value + 1); }
      }
      void refresh().catch(() => undefined);
      return saved;
    } catch (problem) {
      if (isConflict(problem)) { conflictRef.current = true; if (alive.current) setConflict(true); }
      await persistLocal();
      if (alive.current) { setStatus(isConflict(problem) ? 'Conflicto de versión: no se reemplazaron datos' : 'Sin sincronizar'); setError(messageOf(problem)); }
      return null;
    } finally { busy.current = false; if (alive.current) setSaving(false); }
  }

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    if (closedRef.current) { setReady(true); return () => { alive.current = false; }; }
    const memory = memoryDrafts.get(memoryKey);
    if (memory) {
      blockedLocal.current = true; setRecovery(memory.value); setRecoveryInMemory(true); setReady(true);
      return () => { alive.current = false; };
    }
    void loadDraft<LocalDraft>(api.draftSecret(), api.dataset, assignment.id).then(value => {
      if (cancelled) return;
      if (value && Array.isArray(value.scores) && value.scores.length === 10 && value.scores.every(score => score === null || score === 0 || score === 1 || score === 2) && Array.isArray(value.evidence) && value.evidence.length === 10 && value.evidence.every(item => typeof item === 'string') && Array.isArray(value.notes) && value.notes.length === 10 && value.notes.every(item => typeof item === 'string') && typeof value.objection === 'boolean' && typeof value.objectionDetail === 'string') {
        blockedLocal.current = true;
        setRecovery(value);
      } else if (value) { blockedLocal.current = true; setLocalError('El respaldo tiene un formato incompatible. Se conserva sin reemplazarlo.'); }
    }).catch(problem => { if (!cancelled) { blockedLocal.current = true; setLocalError(messageOf(problem)); } }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; alive.current = false; };
  // Each assignment owns an independent editor and encrypted draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id]);

  useEffect(() => {
    if (!ready || recovery || conflict || closed || !dirtyRef.current) return;
    const timer = window.setTimeout(() => { void saveCurrent(); }, 800);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, ready, recovery, conflict, closed, tick]);

  useEffect(() => {
    if (!initial || initial.version <= versionRef.current || dirtyRef.current || busy.current || !ready || recovery || conflictRef.current) return;
    const next = fieldsOf(initial);
    versionRef.current = initial.version; fieldsRef.current = next; setFields(next);
    closedRef.current = initial.status === 'closed'; setClosed(closedRef.current);
    setStatus(closedRef.current ? 'Cerrada y confirmada por el servidor' : 'Ficha actualizada desde el servidor; puede continuar');
    if (closedRef.current) { closePendingRef.current = false; setClosePending(false); void clearLocal(); }
  // A clean editor can receive a documented reopening; dirty edits retain their CAS base.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.version, ready, recovery]);

  useEffect(() => {
    const online = () => { if (dirtyRef.current && !conflictRef.current) setTick(value => value + 1); };
    const leave = (event: BeforeUnloadEvent) => { if (dirtyRef.current || closePendingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('online', online); window.removeEventListener('beforeunload', leave); };
  }, []);

  async function closeEvaluation() {
    if (!valid || conflictRef.current || busy.current || closedRef.current) return;
    setClosing(true);
    closePendingRef.current = true;
    setClosePending(true);
    await persistLocal();
    const saved = dirtyRef.current ? await saveCurrent() : initial;
    if (dirtyRef.current || conflictRef.current || (!saved && versionRef.current === 0)) { setClosing(false); return; }
    try {
      const result = await api.call<Evaluation>('evaluation_close', { assignmentId: assignment.id, expectedVersion: versionRef.current });
      if (result.status !== 'closed') throw new Error('El servidor aún no ha confirmado el cierre.');
      versionRef.current = result.version;
      closedRef.current = true;
      closePendingRef.current = false;
      dirtyRef.current = false;
      await clearLocal();
      if (alive.current) { setClosed(true); setClosePending(false); setStatus('Cerrada y confirmada por el servidor'); setError(''); }
      notify('Ficha cerrada. La firma formal se recoge en el documento impreso.');
      await refresh();
    } catch (problem) {
      if (isConflict(problem)) { conflictRef.current = true; if (alive.current) setConflict(true); }
      await persistLocal();
      if (alive.current) { setStatus('Cierre pendiente de confirmación'); setError(messageOf(problem)); }
    } finally { if (alive.current) setClosing(false); }
  }

  async function retrieveConflict(discard: boolean) {
    setError('');
    try {
      const latest = await api.call<Snapshot>('snapshot');
      const remote = latest.state.evaluations.find(item => item.assignmentId === assignment.id && item.teacherId === snapshot.actor.id) ?? null;
      setServerConflict(remote);
      if (discard) {
        const next = fieldsOf(remote ?? undefined);
        fieldsRef.current = next; setFields(next);
        versionRef.current = remote?.version ?? 0;
        dirtyRef.current = false; conflictRef.current = false;
        closedRef.current = remote?.status === 'closed'; setClosed(closedRef.current);
        closePendingRef.current = false; setClosePending(false);
        setConflict(false); setServerConflict(null); setStatus('Ficha recargada desde el servidor');
        blockedLocal.current = false; await clearLocal(); await refresh();
      } else { await persistLocal(); setStatus('Borrador local conservado; revise la versión del servidor antes de confirmar'); }
    } catch (problem) { setError(messageOf(problem)); }
  }

  return <div className="stack">
    <section className="card stack">
      <div className="row"><div><h2>{book.title}</h2><p>{publisher?.name} · {series?.name} · {book.edition} · {GRADES.find(grade => grade.id === book.gradeId)?.label} · {AREAS.find(area => area.id === offer?.area)?.label}</p></div><span className="status">{closed ? 'Cerrada' : `${completed}/10 completados`}</span></div>
      {snapshot.state.turn.publisherId === publisher?.id && <div className="notice">Esta editorial está en el turno de exposición.</div>}
      {review && <div className="notice"><strong>Revisión adicional para desempate.</strong> Unidad: {review.unitReference}. Motivo: {review.reason}. Se conserva la revisión inicial.</div>}
      {initial?.legacyIndicatorCount === 8 && <div className="notice">Ficha antigua de ocho indicadores. Se conservan sus respuestas; I9 e I10 requieren valoración y evidencia explícitas. La ficha permanece pendiente hasta completar y cerrar los diez indicadores.</div>}
      <div className="row"><strong role="status" aria-live="polite">{status}</strong><span>Nota individual: {score === null ? 'pendiente' : `${score.toFixed(2)} / 100`}</span></div>
      <p className="muted">Reglas {initial?.rulesVersion ?? snapshot.state.settings.rules.version} · Texto versión {initial?.bookVersion ?? book.version}. La nota de otro docente no está disponible en esta pantalla.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {localError && <div className="notice stack" role="alert">{localError}{/No se pudo recuperar el borrador|formato incompatible/.test(localError) && <button type="button" className="secondary" onClick={async () => {
        await clearLocal(true); blockedLocal.current = false; setLocalError('');
        if (dirtyRef.current) await persistLocal();
      }}>Descartar este respaldo conservado y continuar con la ficha visible</button>}</div>}
      {recovery && <div className="notice stack"><strong>Hay un borrador sin sincronizar {recoveryInMemory ? 'en la memoria de esta pestaña' : 'en el respaldo local cifrado'}.</strong><span>Conservado: {new Date(recovery.savedAt).toLocaleString('es-PE')}. Base: versión {recovery.baseVersion}; servidor: {versionRef.current}.</span><div className="row"><button type="button" onClick={() => {
        const restored = recovery; setRecovery(null); blockedLocal.current = false;
        const next: Fields = { scores: restored.scores, evidence: restored.evidence, notes: restored.notes, objection: restored.objection, objectionDetail: restored.objectionDetail };
        closePendingRef.current = !!restored.closePending; setClosePending(!!restored.closePending);
        if (restored.baseVersion !== versionRef.current) { conflictRef.current = true; setConflict(true); }
        edit(next);
      }}>Recuperar borrador</button><button type="button" className="secondary" onClick={() => { setRecovery(null); blockedLocal.current = false; void clearLocal(true); }}>Descartar borrador y usar servidor</button></div></div>}
      {conflict && <div className="notice stack" role="alert"><strong>Otra pestaña cambió esta ficha. Sus cambios locales se conservan.</strong><div className="row"><button type="button" className="secondary" onClick={() => void retrieveConflict(true)}>Recargar ficha del servidor</button><button type="button" onClick={() => void retrieveConflict(false)}>Conservar local y revisar conflicto</button></div>{serverConflict && <><p>Servidor: versión {serverConflict.version}, {serverConflict.status === 'closed' ? 'cerrada' : 'borrador'}. Sus puntajes del servidor: {serverConflict.scores.map(value => value ?? '—').join(' · ')}.</p>{serverConflict.status === 'draft' && <button type="button" onClick={() => {
        versionRef.current = serverConflict.version; conflictRef.current = false; setConflict(false); setServerConflict(null); dirtyRef.current = true;
        void saveCurrent();
      }}>Confirmar estos valores locales sobre la versión {serverConflict.version}</button>}</>}</div>}
      <button type="button" className="secondary" aria-expanded={dossierOpen} onClick={() => setDossierOpen(value => !value)}>{dossierOpen ? 'Ocultar expediente común' : 'Consultar expediente común, carga, muestra y apoyos'}</button>
      {dossierOpen && <Dossier book={book} state={snapshot.state} readOnly />}
      {snapshot.state.settings.rules.practiceGuidelines[`${offer?.area}-${book.gradeId}`] && <div className="notice">Pauta institucional de práctica: {snapshot.state.settings.rules.practiceGuidelines[`${offer?.area}-${book.gradeId}`]}</div>}
    </section>

    <div className="notice">0: no acredita ninguna señal · 1: acredita una o cumplimiento parcial · 2: acredita ambas · Sin respuesta: pendiente de comprobar. Use una referencia de evidencia en cada indicador.</div>
    <fieldset className="stack" disabled={!ready || !!recovery || closed || closing} style={{ border: 0, padding: 0, margin: 0 }}>
      {INDICATORS.map((indicator, index) => {
        const signals = indicator.variants && offer ? indicator.variants[offer.area] : indicator;
        return <section className="card stack" key={indicator.id}>
          <h3 id={`${fieldPrefix}-indicator-${index}`}>{indicator.id}. {indicator.label}</h3><p><strong>A.</strong> {signals.a}</p><p><strong>B.</strong> {signals.b}</p>
          {index === 8 && <div className="notice">Material base, muestra: {practice.complete ? `n=${practice.size}; promedio ${practice.mean?.toFixed(2)}; rango ${practice.min}–${practice.max}` : `pendiente. ${practice.reasons.join(' ')}`}<br /><button type="button" className="secondary" onClick={() => { setDossierOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Ver datos y evidencias de práctica</button></div>}
          {index === 9 && <div className="notice">{support.reasons.join(' ')} {support.pending ? 'No se puede cerrar mientras esta verificación esté pendiente.' : support.required !== null ? `Ausencia comprobada: corresponde registrar ${support.required}.` : `Máximo acreditable con los apoyos verificados: ${support.maximum ?? 'pendiente'}. Elija su valoración.`}</div>}
          <div className="row score-buttons" role="radiogroup" aria-label={`${indicator.id}: puntaje`}>
            {([0, 1, 2] as const).map(value => <button type="button" role="radio" aria-checked={fields.scores[index] === value} key={value} className={fields.scores[index] === value ? 'selected' : 'secondary'} style={{ minWidth: 72, minHeight: 52, fontSize: '1.35rem' }} disabled={index === 9 && (support.pending || (support.required !== null ? value !== support.required : support.maximum !== null && value > support.maximum))} onClick={() => editArray('scores', index, value)}>{value}</button>)}
            <button type="button" role="radio" aria-checked={fields.scores[index] === null} className="secondary" onClick={() => editArray('scores', index, null)}>Sin comprobar</button>
          </div>
          <div className="field"><label htmlFor={`${fieldPrefix}-evidence-${index}`}>Referencia de evidencia / página</label><input id={`${fieldPrefix}-evidence-${index}`} aria-describedby={`${fieldPrefix}-indicator-${index}`} value={fields.evidence[index]} onChange={event => editArray('evidence', index, event.target.value)} placeholder="Ej.: unidad 2, página 28; demostración del expediente" /></div>
          <div className="field"><label htmlFor={`${fieldPrefix}-notes-${index}`}>Observación individual</label><textarea id={`${fieldPrefix}-notes-${index}`} aria-describedby={`${fieldPrefix}-indicator-${index}`} value={fields.notes[index]} rows={2} onChange={event => editArray('notes', index, event.target.value)} placeholder="Sustento y observaciones del indicador" /></div>
        </section>;
      })}
      <section className="card stack"><label className="row"><input type="checkbox" checked={fields.objection} onChange={event => edit({ ...fieldsRef.current, objection: event.target.checked })} />Existe una objeción o incidencia</label>{fields.objection && <label className="field">Detalle obligatorio de la objeción<textarea value={fields.objectionDetail} onChange={event => edit({ ...fieldsRef.current, objectionDetail: event.target.value })} rows={3} /></label>}</section>
    </fieldset>
    <section className="card stack">
      {!closed && <><p>{completed}/10 respuestas · {fields.evidence.filter(reference => reference.trim()).length}/10 referencias. {fields.objection && !fields.objectionDetail.trim() ? 'Falta detallar la objeción.' : ''}</p>{closePending && <div className="notice" role="status">Cierre pendiente. La ficha seguirá abierta hasta recibir confirmación del servidor.</div>}<div className="row"><button type="button" className="secondary" disabled={!ready || saving || closing || conflict || !!recovery} onClick={() => void saveCurrent()}>{saving ? 'Guardando…' : 'Guardar ahora'}</button><button type="button" disabled={!ready || !valid || saving || closing || conflict || !!recovery} onClick={() => void closeEvaluation()}>{closing ? 'Esperando confirmación de cierre…' : closePending ? 'Reintentar cierre' : 'Cerrar ficha explícitamente'}</button></div><p className="muted">El cierre no equivale a una firma. Si necesita corregir una ficha cerrada, coordinación debe reabrirla con motivo y una nueva versión.</p></>}
      {closed && <><div className="notice">Ficha cerrada por el servidor. Sus puntajes originales se conservan.</div><button type="button" onClick={onNext}>Continuar con el siguiente texto pendiente</button></>}
    </section>
  </div>;
}
