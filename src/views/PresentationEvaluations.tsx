import { useEffect, useId, useRef, useState } from 'react';
import type { Area, Block, PresentationEvaluation, Publisher, Score, Snapshot, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { PRESENTATION_INDICATORS, presentationPublisherAvailable, presentationScore, presentationTeacherInScope } from '../../shared/presentation';
import { loadDraft, removeDraft, saveDraft } from '../drafts';

interface Fields { scores: Score[]; notes: string[]; generalObservation: string; physicalText: string }
interface LocalDraft extends Fields { baseVersion: number; savedAt: string; closePending?: boolean }
const memoryDrafts = new Map<string, { owner: symbol; value: LocalDraft }>();
const emptyFields = (): Fields => ({ scores: Array<Score>(10).fill(null), notes: Array<string>(10).fill(''), generalObservation: '', physicalText: '' });
const fieldsOf = (value?: PresentationEvaluation): Fields => value ? { scores: [...value.scores], notes: [...value.notes], generalObservation: value.generalObservation, physicalText: value.physicalText } : emptyFields();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
function isConflict(error: unknown) {
  const candidate = error as { code?: string; status?: number };
  return candidate?.code === 'PT409' || candidate?.status === 409 || /409|conflicto|otra pestaña|versión.*cambi|version.*conflict/i.test(messageOf(error));
}
function validDraft(value: LocalDraft): boolean {
  return Array.isArray(value.scores) && value.scores.length === 10 && value.scores.every(score => score === null || score === 0 || score === 1 || score === 2)
    && Array.isArray(value.notes) && value.notes.length === 10 && value.notes.every(note => typeof note === 'string')
    && typeof value.generalObservation === 'string' && typeof value.physicalText === 'string'
    && Number.isInteger(value.baseVersion) && value.baseVersion >= 0 && typeof value.savedAt === 'string';
}

export default function PresentationEvaluations(props: ViewProps) {
  const { snapshot } = props;
  const teacher = snapshot.state.teachers.find(item => item.id === snapshot.actor.id);
  const scopes = AREAS.flatMap(area => BLOCKS.filter(block => teacher && presentationTeacherInScope(teacher, area.id, block.id)).map(block => ({ area: area.id, block: block.id, label: `${area.label} · ${block.label}` })));
  const [selectedScope, setSelectedScope] = useState('');
  const scope = scopes.find(item => `${item.area}-${item.block}` === selectedScope) ?? scopes[0];
  const publishers = scope ? snapshot.state.publishers.filter(item => presentationPublisherAvailable(snapshot.state, item.id, scope.area, scope.block)) : [];
  const [selectedPublisher, setSelectedPublisher] = useState(() => publishers.find(item => item.id === snapshot.state.turn.publisherId)?.id ?? publishers[0]?.id ?? '');
  const publisher = publishers.find(item => item.id === selectedPublisher) ?? publishers.find(item => item.id === snapshot.state.turn.publisherId) ?? publishers[0];
  const own = (snapshot.state.presentationEvaluations ?? []).filter(item => item.teacherId === snapshot.actor.id);
  if (snapshot.actor.role !== 'teacher') return <div className="notice">La ficha de exposición requiere su acceso individual de docente.</div>;
  if (!scope) return <div className="notice">Complete su registro al ingresar con sus nombres, apellidos, área y uno o más bloques para evaluar las exposiciones. Las fichas históricas por texto conservan sus respuestas.</div>;
  const closed = own.filter(item => item.area === scope.area && item.block === scope.block && item.status === 'closed' && publishers.some(publisher => publisher.id === item.publisherId)).length;
  return <div className="stack">
    <div><h1>Evaluar exposición</h1><p className="muted">{snapshot.actor.name} · Escuche la presentación de la editorial y revise el ejemplar físico. Complete una ficha por editorial, área y bloque.</p></div>
    <div className="tabs" aria-label="Área y bloque de evaluación">{scopes.map(item => {
      const id = `${item.area}-${item.block}`;
      return <button type="button" key={id} className={scope === item ? 'active' : ''} aria-pressed={scope === item} onClick={() => { setSelectedScope(id); setSelectedPublisher(snapshot.state.turn.publisherId ?? ''); }}>{item.label}</button>;
    })}</div>
    <p className="muted">{closed} de {publishers.length} fichas cerradas en este bloque. Sus valoraciones son individuales y privadas.</p>
    {publishers.length === 0 ? <div className="notice">Aún no hay editoriales disponibles para esta área y bloque.</div> : <>
      <div className="grid" aria-label="Editoriales">{publishers.map(item => {
        const evaluation = own.find(value => value.publisherId === item.id && value.area === scope.area && value.block === scope.block);
        const current = snapshot.state.turn.publisherId === item.id;
        return <button type="button" key={item.id} className={`card stack ${publisher?.id === item.id ? 'selected' : 'secondary'}`} aria-pressed={publisher?.id === item.id} onClick={() => setSelectedPublisher(item.id)} style={{ alignItems: 'flex-start', textAlign: 'left', gap: 8 }}>
          <strong>{item.name}</strong><span className={`status ${evaluation?.status === 'closed' ? 'closed' : 'pending'}`}>{evaluation?.status === 'closed' ? 'Ficha cerrada' : evaluation ? 'Borrador' : 'Sin iniciar'}</span>{current && <span className="status">Turno actual de exposición</span>}
        </button>;
      })}</div>
      {publisher && <PresentationEditor key={`${snapshot.actor.id}/${publisher.id}/${scope.area}/${scope.block}`} {...props} publisher={publisher} area={scope.area} block={scope.block} onNext={() => {
        const index = publishers.findIndex(item => item.id === publisher.id);
        const next = [...publishers.slice(index + 1), ...publishers.slice(0, index)].find(item => !own.some(value => value.publisherId === item.id && value.area === scope.area && value.block === scope.block && value.status === 'closed'));
        if (next) setSelectedPublisher(next.id);
      }} />}
    </>}
  </div>;
}

function PresentationEditor({ snapshot, api, refresh, notify, publisher, area, block, onNext }: ViewProps & { publisher: Publisher; area: Area; block: Block; onNext(): void }) {
  const fieldPrefix = useId();
  const initial = (snapshot.state.presentationEvaluations ?? []).find(item => item.publisherId === publisher.id && item.teacherId === snapshot.actor.id && item.area === area && item.block === block);
  const draftId = JSON.stringify(['presentation', snapshot.actor.id, publisher.id, area, block]);
  const memoryKey = JSON.stringify([api.draftSecret(), api.dataset, draftId]);
  const [fields, setFields] = useState<Fields>(() => fieldsOf(initial));
  const fieldsRef = useRef(fields);
  const evaluationId = useRef(initial?.id ?? '');
  const versionRef = useRef(initial?.version ?? 0);
  const dirty = useRef(false);
  const revision = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const owner = useRef(Symbol('presentation-editor'));
  const blockedLocal = useRef(false);
  const closedRef = useRef(initial?.status === 'closed');
  const [closed, setClosed] = useState(closedRef.current);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(initial ? 'Guardado en servidor' : 'Sin respuestas');
  const [localError, setLocalError] = useState('');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<LocalDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [serverConflict, setServerConflict] = useState<PresentationEvaluation | null>(null);
  const [conflictChecked, setConflictChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const closePendingRef = useRef(false);
  const [closePending, setClosePending] = useState(false);
  const [tick, setTick] = useState(0);
  const completed = fields.scores.filter(value => value !== null).length;
  const score = presentationScore(fields.scores);

  function localValue(): LocalDraft { return { ...fieldsRef.current, baseVersion: versionRef.current, savedAt: new Date().toISOString(), closePending: closePendingRef.current }; }
  async function persistLocal() {
    if (closedRef.current) return;
    const previous = memoryDrafts.get(memoryKey);
    if (!alive.current && previous && previous.owner !== owner.current) return;
    const value = localValue();
    memoryDrafts.set(memoryKey, { owner: owner.current, value });
    if (blockedLocal.current) return;
    try { await saveDraft(api.draftSecret(), api.dataset, draftId, value); if (alive.current) setLocalError(''); }
    catch (problem) { if (alive.current) setLocalError(messageOf(problem)); }
  }
  async function clearLocal(force = false) {
    const previous = memoryDrafts.get(memoryKey);
    if (!force && previous && previous.owner !== owner.current) return;
    memoryDrafts.delete(memoryKey);
    try { await removeDraft(api.draftSecret(), api.dataset, draftId); }
    catch (problem) { if (alive.current) setLocalError(messageOf(problem)); }
  }
  function edit(next: Fields) {
    fieldsRef.current = next; dirty.current = true; revision.current += 1;
    setFields(next); setStatus('Cambios pendientes de sincronizar'); setError('');
    void persistLocal();
  }
  function editArray(key: 'scores' | 'notes', index: number, value: Score | string) {
    edit({ ...fieldsRef.current, [key]: fieldsRef.current[key].map((item, position) => position === index ? value : item) } as Fields);
  }
  async function saveCurrent(): Promise<PresentationEvaluation | null> {
    if (busy.current || closedRef.current || conflictRef.current || !dirty.current) return null;
    busy.current = true;
    if (alive.current) { setSaving(true); setStatus('Guardando…'); setError(''); }
    const sentRevision = revision.current;
    try {
      const saved = await api.call<PresentationEvaluation>('presentation_save', { publisherId: publisher.id, area, block, ...fieldsRef.current, expectedVersion: versionRef.current });
      versionRef.current = saved.version; evaluationId.current = saved.id;
      if (sentRevision === revision.current) {
        dirty.current = false;
        if (!blockedLocal.current && !closePendingRef.current) await clearLocal();
        else if (closePendingRef.current) await persistLocal();
        if (alive.current) {
          setStatus(sentRevision === revision.current ? 'Guardado en servidor' : 'Hay cambios posteriores por sincronizar');
          if (sentRevision !== revision.current) setTick(value => value + 1);
        }
      } else {
        await persistLocal();
        if (alive.current) { setStatus('Hay cambios posteriores por sincronizar'); setTick(value => value + 1); }
      }
      void refresh().catch(() => undefined);
      return saved;
    } catch (problem) {
      if (isConflict(problem)) { conflictRef.current = true; if (alive.current) { setConflict(true); setConflictChecked(false); } }
      await persistLocal();
      if (alive.current) { setStatus(isConflict(problem) ? 'Conflicto de versión; borrador conservado' : 'Sin sincronizar; se reintentará al volver la conexión'); setError(messageOf(problem)); }
      return null;
    } finally { busy.current = false; if (alive.current) setSaving(false); }
  }

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    if (closedRef.current) { setReady(true); return () => { alive.current = false; }; }
    const memory = memoryDrafts.get(memoryKey);
    if (memory) {
      memoryDrafts.set(memoryKey, { owner: owner.current, value: memory.value });
      blockedLocal.current = true; setRecovery(memory.value); setReady(true);
      return () => { alive.current = false; };
    }
    void loadDraft<LocalDraft>(api.draftSecret(), api.dataset, draftId).then(value => {
      if (cancelled) return;
      if (value && validDraft(value)) { blockedLocal.current = true; setRecovery(value); }
      else if (value) { blockedLocal.current = true; setLocalError('El respaldo tiene un formato incompatible. Se conserva sin reemplazarlo.'); }
    }).catch(problem => { if (!cancelled) { blockedLocal.current = true; setLocalError(messageOf(problem)); } }).finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; alive.current = false; };
  // Each teacher, publisher, area and block has an independent encrypted draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  useEffect(() => {
    if (!ready || recovery || conflict || closed || !dirty.current) return;
    const timer = window.setTimeout(() => { void saveCurrent(); }, 800);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, ready, recovery, conflict, closed, tick]);

  useEffect(() => {
    if (!initial || initial.version <= versionRef.current || dirty.current || busy.current || !ready || recovery || conflictRef.current) return;
    const next = fieldsOf(initial);
    versionRef.current = initial.version; evaluationId.current = initial.id; fieldsRef.current = next; setFields(next);
    closedRef.current = initial.status === 'closed'; setClosed(closedRef.current);
    setStatus(closedRef.current ? 'Cerrada y confirmada por el servidor' : 'Ficha reabierta; puede corregir su valoración');
    if (closedRef.current) { closePendingRef.current = false; setClosePending(false); void clearLocal(); }
  // Clean editors follow documented reopenings; unsaved edits retain their CAS version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.version, ready, recovery]);

  useEffect(() => {
    const online = () => { if (dirty.current && !conflictRef.current) setTick(value => value + 1); };
    const leave = (event: BeforeUnloadEvent) => { if (dirty.current || closePendingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('online', online); window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('online', online); window.removeEventListener('beforeunload', leave); };
  }, []);

  async function closeEvaluation() {
    if (completed !== 10 || conflictRef.current || busy.current || closedRef.current) return;
    setClosing(true); closePendingRef.current = true; setClosePending(true);
    await persistLocal();
    if (dirty.current) await saveCurrent();
    if (dirty.current || conflictRef.current || !evaluationId.current) { if (alive.current) setClosing(false); return; }
    busy.current = true;
    try {
      const result = await api.call<PresentationEvaluation>('presentation_close', { evaluationId: evaluationId.current, expectedVersion: versionRef.current });
      if (result.status !== 'closed') throw new Error('El servidor aún no ha confirmado el cierre.');
      versionRef.current = result.version; closedRef.current = true; closePendingRef.current = false; dirty.current = false;
      await clearLocal();
      if (alive.current) { setClosed(true); setClosePending(false); setStatus('Cerrada y confirmada por el servidor'); setError(''); }
      notify('Ficha de exposición cerrada y confirmada.');
      await refresh().catch(problem => { if (alive.current) setError(`El cierre fue confirmado. No se pudo actualizar la pantalla: ${messageOf(problem)}`); });
    } catch (problem) {
      if (isConflict(problem)) { conflictRef.current = true; if (alive.current) { setConflict(true); setConflictChecked(false); } }
      await persistLocal();
      if (alive.current) { setStatus('Cierre pendiente de confirmación'); setError(messageOf(problem)); }
    } finally { busy.current = false; if (alive.current) setClosing(false); }
  }

  async function retrieveConflict(discard: boolean) {
    setError('');
    try {
      const latest = await api.call<Snapshot>('snapshot');
      const remote = (latest.state.presentationEvaluations ?? []).find(item => item.publisherId === publisher.id && item.teacherId === snapshot.actor.id && item.area === area && item.block === block) ?? null;
      setServerConflict(remote); setConflictChecked(true);
      if (discard) {
        const next = fieldsOf(remote ?? undefined);
        fieldsRef.current = next; setFields(next); versionRef.current = remote?.version ?? 0; evaluationId.current = remote?.id ?? '';
        dirty.current = false; conflictRef.current = false; closedRef.current = remote?.status === 'closed'; setClosed(closedRef.current);
        closePendingRef.current = false; setClosePending(false); setConflict(false); setServerConflict(null); setConflictChecked(false);
        setStatus(remote?.status === 'closed' ? 'Cerrada y confirmada por el servidor' : 'Ficha recargada desde el servidor');
        blockedLocal.current = false; await clearLocal(); await refresh();
      } else { await persistLocal(); setStatus('Borrador local conservado; revise la versión del servidor'); }
    } catch (problem) { setError(messageOf(problem)); }
  }

  return <div className="stack">
    <section className="card stack">
      <div className="row between"><div><h2>{publisher.name}</h2><p>{AREAS.find(item => item.id === area)?.label} · {BLOCKS.find(item => item.id === block)?.label}</p></div><span className={`status ${closed ? 'closed' : 'pending'}`}>{closed ? 'Ficha cerrada' : `${completed}/10 valoraciones`}</span></div>
      {snapshot.state.turn.publisherId === publisher.id && <div className="notice">Esta editorial está en el turno actual de exposición.</div>}
      <div className="row between"><strong role="status" aria-live="polite">{status}</strong><span>Mi nota: {score === null ? 'pendiente' : `${score.toFixed(2)} / 100`}</span></div>
      <p className="muted">Valore lo presentado y el ejemplar físico disponible. Las observaciones y referencias son opcionales. Los puntajes de otros docentes permanecen privados.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {localError && <div className="notice warning stack" role="alert"><span>{localError}</span>{blockedLocal.current && <button type="button" className="secondary" onClick={async () => {
        await clearLocal(true); blockedLocal.current = false; setLocalError(''); if (dirty.current) await persistLocal();
      }}>Descartar respaldo conservado y continuar con la ficha visible</button>}</div>}
      {recovery && <div className="notice stack"><strong>Hay un borrador local cifrado pendiente de sincronizar.</strong><span>Conservado: {new Date(recovery.savedAt).toLocaleString('es-PE')}. Versión base: {recovery.baseVersion}; servidor: {versionRef.current}.</span><div className="row"><button type="button" onClick={() => {
        const value = recovery; setRecovery(null); blockedLocal.current = false;
        closePendingRef.current = !!value.closePending; setClosePending(!!value.closePending);
        if (value.baseVersion !== versionRef.current) { conflictRef.current = true; setConflict(true); setConflictChecked(false); }
        edit({ scores: value.scores, notes: value.notes, generalObservation: value.generalObservation, physicalText: value.physicalText });
      }}>Recuperar borrador</button><button type="button" className="secondary" onClick={() => { setRecovery(null); blockedLocal.current = false; void clearLocal(true); }}>Descartar borrador y usar servidor</button></div></div>}
      {conflict && <div className="notice warning stack" role="alert"><strong>La ficha cambió en el servidor. Sus valores locales se conservan.</strong><div className="row"><button type="button" className="secondary" onClick={() => void retrieveConflict(true)}>Recargar ficha del servidor</button><button type="button" onClick={() => void retrieveConflict(false)}>Consultar versión del servidor</button></div>{conflictChecked && <><p>{serverConflict ? `Servidor: versión ${serverConflict.version}, ${serverConflict.status === 'closed' ? 'cerrada' : 'borrador'}. Puntajes: ${serverConflict.scores.map(value => value ?? '—').join(' · ')}.` : 'No hay una ficha guardada en el servidor.'}</p>{serverConflict?.status !== 'closed' && <button type="button" onClick={() => {
        versionRef.current = serverConflict?.version ?? 0; evaluationId.current = serverConflict?.id ?? ''; conflictRef.current = false; setConflict(false); setServerConflict(null); setConflictChecked(false); dirty.current = true;
        void saveCurrent();
      }}>Guardar mis valores sobre esta versión revisada</button>}</>}</div>}
    </section>

    <div className="notice">0: no se aprecia el criterio · 1: se aprecia parcialmente · 2: se aprecia de forma suficiente. Deje «Sin valorar» mientras esté pendiente. Complete los diez criterios para cerrar.</div>
    <fieldset className="stack" disabled={!ready || !!recovery || closed || closing} style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="visually-hidden">Valoración de la exposición de {publisher.name}</legend>
      {PRESENTATION_INDICATORS.map((indicator, index) => {
        const signals = indicator.variants ? indicator.variants[area] : indicator;
        return <section className="card stack" key={indicator.id}>
          <h3 id={`${fieldPrefix}-criterion-${index}`}>{indicator.id}. {indicator.label}</h3>
          <p><strong>A.</strong> {signals.a}<br /><strong>B.</strong> {signals.b}</p>
          <div className="row score-buttons" role="group" aria-labelledby={`${fieldPrefix}-criterion-${index}`}>
            {([0, 1, 2] as const).map(value => <button type="button" key={value} aria-pressed={fields.scores[index] === value} className={fields.scores[index] === value ? 'selected' : 'secondary'} onClick={() => editArray('scores', index, value)} style={{ minWidth: 64, minHeight: 52 }} aria-label={`${indicator.id}: ${value} puntos`}>{value}</button>)}
            <button type="button" aria-pressed={fields.scores[index] === null} className="secondary" onClick={() => editArray('scores', index, null)} style={{ fontSize: 13 }}>Sin valorar</button>
          </div>
          <div className="field"><label htmlFor={`${fieldPrefix}-notes-${index}`}>Observación del criterio (opcional)</label><textarea id={`${fieldPrefix}-notes-${index}`} aria-describedby={`${fieldPrefix}-criterion-${index}`} value={fields.notes[index]} rows={2} onChange={event => editArray('notes', index, event.target.value)} placeholder="Puede anotar lo observado durante la presentación o en el ejemplar" /></div>
        </section>;
      })}
      <section className="card stack">
        <div className="field"><label htmlFor={`${fieldPrefix}-physical`}>Referencia del ejemplar físico (opcional)</label><input id={`${fieldPrefix}-physical`} value={fields.physicalText} onChange={event => edit({ ...fieldsRef.current, physicalText: event.target.value })} placeholder="Ej.: serie, edición, ejemplar o páginas revisadas" /></div>
        <div className="field"><label htmlFor={`${fieldPrefix}-observation`}>Observación general (opcional)</label><textarea id={`${fieldPrefix}-observation`} value={fields.generalObservation} rows={3} onChange={event => edit({ ...fieldsRef.current, generalObservation: event.target.value })} /></div>
      </section>
    </fieldset>
    <section className="card stack sticky-actions">
      {closed ? <><div className="notice success">El servidor confirmó el cierre de esta ficha. Para corregirla, solicite a coordinación una reapertura con motivo.</div><button type="button" onClick={onNext}>Continuar con otra editorial pendiente</button></> : <>
        <p>{completed}/10 criterios valorados · Las observaciones son opcionales.</p>
        {closePending && <div className="notice warning" role="status">Cierre pendiente. La ficha seguirá abierta hasta recibir la confirmación del servidor. Reintente el cierre cuando recupere la conexión.</div>}
        <div className="row"><button type="button" className="secondary" disabled={!ready || saving || closing || conflict || !!recovery} onClick={() => void saveCurrent()}>{saving ? 'Guardando…' : 'Guardar ahora'}</button><button type="button" disabled={!ready || completed !== 10 || saving || closing || conflict || !!recovery} onClick={() => void closeEvaluation()}>{closing ? 'Esperando confirmación…' : closePending ? 'Reintentar cierre' : 'Cerrar mi ficha'}</button></div>
        <p className="muted">Los cambios se guardan automáticamente. El borrador local se cifra para su acceso individual; el cierre requiere confirmación del servidor.</p>
      </>}
    </section>
  </div>;
}
