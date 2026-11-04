import { useState } from 'react';
import { AREAS, GRADES, basePrice, practiceSummary, workloadSummary } from '../../shared/domain';
import type { Area, Book, GradeId, Shortlist, Snapshot, State, SupportProfile, Verification } from '../../shared/types';
import { ROOM_SCRIPT, clockText, turnTiming, useServerClock } from './LiveRoom';

const statuses: Record<Verification, string> = { declared: 'Declarado', verified: 'Verificado', pending: 'Pendiente de verificar', not_offered: 'No ofrecido' };
const money = (value: number | null) => value === null ? 'Precio pendiente / sin desglose' : `S/ ${value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (value: number | null) => value === null ? 'Pendiente' : value.toLocaleString('es-PE', { maximumFractionDigits: 2 });
const gradeLabel = (id: GradeId) => GRADES.find(g => g.id === id)?.label || id;

function publicOfferName(state: State, offerId: string, gradeId: GradeId) {
  const offer = state.offers.find(o => o.id === offerId);
  const series = state.series.find(s => s.id === offer?.seriesId);
  const publisher = state.publishers.find(p => p.id === series?.publisherId);
  const book = state.books.find(b => b.offerId === offerId && b.gradeId === gradeId && b.active);
  return `${book?.title || series?.name || 'Título publicado'} · ${publisher?.name || ''} · ${book?.edition || offer?.edition || ''}`;
}

function publishedShortlist(state: State, gradeId: GradeId, area: Area) {
  return state.shortlists.filter(s => s.status === 'published' && s.gradeIds.includes(gradeId) && (s.categoryId.startsWith(area + '-') || s.offerIds.some(id => state.offers.some(o => o.id === id && o.area === area)))).sort((a, b) => Number(b.scope === 'grade') - Number(a.scope === 'grade') || b.version - a.version)[0];
}

function Profile({ profile, label }: { profile: SupportProfile; label: string }) {
  return <details><summary>{label}: {statuses[profile.status]}</summary><dl className="public-details">
    <dt>Modo de acceso</dt><dd>{profile.access || 'Pendiente'}</dd><dt>Dispositivos</dt><dd>{profile.devices || 'Pendiente'}</dd><dt>Conexión / celular / sin conexión</dt><dd>{profile.connection || 'Pendiente'} / {profile.mobile || 'Pendiente'} / {profile.offline || 'Pendiente'}</dd><dt>Vigencia</dt><dd>{profile.validity || 'Pendiente'}</dd><dt>Inclusión y renovación</dt><dd>{profile.included ? 'Incluido en la propuesta base' : 'No incluido en la propuesta base'} · {profile.extraCost === null ? 'Costo sin confirmar' : money(profile.extraCost)} · {profile.renewal || 'Renovación pendiente de confirmar'}</dd><dt>Soporte</dt><dd>{profile.support || 'Pendiente'}</dd><dt>Acción comprobada</dt><dd>{profile.status === 'verified' ? profile.action || 'Sin detalle publicado' : 'Aún no acreditada como verificada'}</dd><dt>Fecha de prueba</dt><dd>{profile.testedAt ? new Date(profile.testedAt).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : 'Pendiente'}</dd>
  </dl></details>;
}

function technicalScore(shortlist: Shortlist, book: Book): number | null {
  // La nota pública siempre proviene de la instantánea publicada, nunca de fichas privadas.
  const snapshot = shortlist.snapshot as { assessment?: { ranked?: { offerId: string; score?: number | null; grades?: { bookId: string; score?: number | null }[] }[] }; ranked?: { offerId: string; score?: number | null; grades?: { bookId: string; score?: number | null }[] }[] } | null;
  const offer = (snapshot?.assessment?.ranked || snapshot?.ranked)?.find(o => o.offerId === book.offerId);
  return offer?.grades?.find(g => g.bookId === book.id)?.score ?? null;
}

function PublicBook({ state, book, shortlist }: { state: State; book: Book; shortlist: Shortlist }) {
  const offer = state.offers.find(o => o.id === book.offerId);
  const series = state.series.find(s => s.id === offer?.seriesId);
  const publisher = state.publishers.find(p => p.id === series?.publisherId);
  const workload = workloadSummary(book);
  const practice = practiceSummary(book);
  const score = technicalScore(shortlist, book);
  return <article className="card stack public-book" style={{ minWidth: 0 }}>
    <div><span className="status">Finalista publicado</span><h2>{book.title}</h2><p>{publisher?.name} · {series?.name}<br /><strong>Edición {book.edition}</strong> · {gradeLabel(book.gradeId)}</p></div>
    {score !== null && <p>Nota técnica del grado: <strong>{number(score)} / 100</strong></p>}
    <div><h3>Paquete y precios</h3><p style={{ fontSize: '1.5rem', fontWeight: 750 }}>{money(basePrice(book))}</p><p>{statuses[book.priceStatus]} · Vigencia: {book.priceValidity || 'Pendiente'}</p><ul>{book.components.map(component => <li key={component.id}>{component.quantity} × {component.name}{component.optional ? ' · extra opcional' : ' · incluido'}: {component.unitPrice === null ? 'sin desglose individual' : `${money(component.unitPrice)} por unidad`}</li>)}</ul><p className="muted">El precio conjunto puede estar declarado sin desglose. Los importes desconocidos conservan su condición pendiente.</p></div>
    <div><h3>Carga anual</h3><p>{statuses[book.workloadStatus]}{book.mappingOrigin === 'school' ? ' · Distribución propuesta por el colegio' : ''}</p><div className="row">{workload.bimesters.map((value, i) => <span key={i}><strong>B{i + 1}</strong>: {number(value)}</span>)}</div><p>Total anual de temas únicos: <strong>{number(workload.total)}</strong> · Capítulos / unidades: {workload.chapters.length}</p>{book.availableWeeks !== null && <p>Semanas disponibles: {book.availableWeeks}</p>}{book.workloadNote && <p>Viabilidad: {book.workloadNote}</p>}<details><summary>Ver capítulos y fuente</summary><ul>{workload.chapters.map((chapter, index) => <li key={index}>{chapter.name}: {number(chapter.count)} temas</li>)}</ul><p>Fuente: {book.workloadSource || 'Pendiente'}</p></details></div>
    <div><h3>Práctica impresa: muestra</h3><p>{statuses[book.practiceStatus]}</p>{practice.complete ? <p>Promedio de la muestra: <strong>{number(practice.mean)}</strong> · Rango: {number(practice.min)}–{number(practice.max)} · n={practice.size}</p> : <p>La muestra está pendiente de completar; aún no hay promedio comprobado.</p>}<p className="muted">La muestra corresponde al material base y no se extrapola al libro completo. Los apoyos opcionales se muestran por separado.</p><details><summary>Temas y consignas de la muestra</summary><ul>{practice.samples.map((sample, i) => <li key={sample.topicId || i}>{sample.position}. {sample.topicName} · {sample.pages || 'página pendiente'}: base {number(sample.baseCount)}, cuaderno {number(sample.workbookCount)}, opcional {number(sample.optionalCount)} · {sample.verified ? 'Verificado' : 'Pendiente'}{sample.workType ? ` · ${sample.workType}` : ''}</li>)}</ul></details>{practice.allTopicsMean !== null && <p>Promedio de todos los temas ({practice.allTopicsKind === 'verified' ? 'verificado' : 'declarado'}): {number(practice.allTopicsMean)}</p>}</div>
    <div className="stack"><h3>Apoyo y condiciones de uso</h3><p><strong>{book.supportKind === 'platform' ? 'Plataforma' : book.supportKind === 'equivalent' ? 'Apoyo equivalente sin plataforma' : 'Sin apoyo complementario'}</strong> · {statuses[book.supportStatus]}</p>{book.supportKind === 'equivalent' && <p>{book.equivalentAuthorized ? 'Equivalente autorizado por el colegio.' : 'Autorización del equivalente pendiente.'}</p>}{book.supportKind !== 'none' && <><Profile profile={book.teacherSupport} label="Docente" /><Profile profile={book.studentSupport} label="Estudiante" /></>}<p>Limitación práctica: {book.supportKind === 'none' ? 'La propuesta no incluye apoyo complementario.' : book.supportStatus !== 'verified' ? 'Las prestaciones pendientes aún no están acreditadas.' : !book.studentSupport.included || !book.teacherSupport.included ? 'Revise los servicios que requieren un pago opcional.' : book.supportNote || 'Revise dispositivos, conexión y vigencia antes de elegir.'}</p></div>
    <div><h3>Revisión del ejemplar</h3><p>Mesa: {book.sampleTable || 'Consultar a Secretaría'} · Muestras: {book.sampleQuantity}</p><p>{book.familyAvailability || 'Consultar disponibilidad para revisión física.'}</p></div>
  </article>;
}

export default function PublicView({ data, refresh }: { data: Snapshot; refresh(): Promise<void> }) {
  const { state } = data;
  const now = useServerClock(data.serverNow);
  const [gradeId, setGradeId] = useState<GradeId>('PRI1');
  const [area, setArea] = useState<Area>('MAT');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const timing = turnTiming(state.turn, now, state.settings.rules.presentationSeconds, state.settings.rules.transitionSeconds);
  const publisher = state.publishers.find(p => p.id === state.turn.publisherId);
  const onStage = state.turn.status === 'running' || state.turn.status === 'paused';
  const shortlist = publishedShortlist(state, gradeId, area);
  const books = shortlist ? shortlist.offerIds.map(id => state.books.find(b => b.offerId === id && b.gradeId === gradeId && b.active)).filter((book): book is Book => Boolean(book)) : [];
  const latestResult = state.rounds.filter(r => r.gradeId === gradeId && r.status === 'closed' && r.areas.includes(area)).sort((a, b) => b.number - a.number)[0];
  async function sync() { setRefreshing(true); setError(''); try { await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo sincronizar.'); } finally { setRefreshing(false); } }
  return <main className="stack public-view" style={{ maxWidth: 1600, margin: '0 auto', padding: 'clamp(16px, 3vw, 36px)' }}>
    <header className="row"><div><p className="muted">{state.settings.school} · {data.dataset === 'demo' ? 'DEMOSTRACIÓN CON DATOS FICTICIOS' : 'Consulta pública'}</p><h1>{state.settings.title}</h1></div><button disabled={refreshing} onClick={() => void sync()}>{refreshing ? 'Sincronizando…' : 'Actualizar'}</button></header>
    {error && <p className="notice error" role="alert">{error}</p>}
    {(onStage || !state.shortlists.some(s => s.status === 'published')) && <>
      <section className={`card ${timing.warning ? 'clock-warning' : ''}`} style={{ textAlign: 'center' }}><span className="status">{state.turn.status === 'paused' ? 'Turno pausado' : state.turn.status === 'ready' ? 'Jornada preparada' : timing.transition ? 'Registro y cambio' : 'Exposición editorial'}</span><h2>{publisher?.name || 'Próximamente iniciaremos las exposiciones'}</h2><div style={{ fontSize: 'clamp(5rem, 14vw, 10rem)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', fontWeight: 750 }}>{clockText(timing.remaining)}</div>{timing.warning && <p className="notice">Último minuto: precios y cierre de exposición.</p>}{timing.transition && <p>Registro y cambio de editorial. Conserve sus fichas en elaboración.</p>}</section>
      <section className="card"><h2>Guion de presentación</h2>{ROOM_SCRIPT.map(([time, instruction]) => <p key={time}><strong>{time} min</strong> · {instruction}</p>)}<p>Las familias podrán consultar los finalistas después de su publicación autorizada.</p></section>
    </>}
    {!onStage && state.shortlists.some(s => s.status === 'published') && <>
      <section className="card stack"><h2>Compare los finalistas de su grado</h2><p>Revise los ejemplares físicos, las condiciones verificadas y el precio de la propuesta base antes de votar. Los acuerdos familiares son independientes por grado y área.</p><div className="row"><label className="field">Grado 2027<select value={gradeId} onChange={e => setGradeId(e.target.value as GradeId)}>{GRADES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label><label className="field">Área<select value={area} onChange={e => setArea(e.target.value as Area)}>{AREAS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label><button onClick={() => window.print()} disabled={!books.length}>Imprimir tarjetas de mesa</button></div></section>
      {!shortlist ? <div className="card"><p>Esta terna todavía no tiene una publicación autorizada.</p></div> : <><section className="notice"><p><strong>Apreciación pedagógica del portavoz:</strong> {shortlist.statement || 'Consulte la apreciación en la mesa de revisión.'}</p><p className="muted">Versión publicada {shortlist.version} · {shortlist.publishedAt ? new Date(shortlist.publishedAt).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : ''}</p></section><div className="grid public-comparison" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', alignItems: 'start' }}>{books.map(book => <PublicBook key={book.id} state={state} book={book} shortlist={shortlist} />)}</div></>}
      {latestResult && <section className="card stack"><h2>Resultado familiar cerrado · {AREAS.find(a => a.id === area)?.label}</h2><p>{gradeLabel(gradeId)} · Ronda {latestResult.number}</p>{latestResult.results[area]?.state === 'winner' && latestResult.results[area]?.winnerId ? <p><strong>Texto elegido: {publicOfferName(state, latestResult.results[area]!.winnerId!, gradeId)}</strong></p> : <p className="notice">Acuerdo pendiente: {latestResult.results[area]?.state === 'tie' ? 'empate; requiere segunda vuelta del área afectada' : latestResult.results[area]?.state === 'no_valid_votes' ? 'sin votos válidos' : latestResult.results[area]?.state === 'insufficient_representation' ? 'representación insuficiente' : 'requiere resolución documentada'}.</p>}<div className="table-wrap"><table><thead><tr><th>Alternativa</th><th>Votos</th></tr></thead><tbody>{(latestResult.options[area] || []).map(id => <tr key={id}><td>{publicOfferName(state, id, gradeId)}</td><td>{latestResult.counts[area]?.options[id] ?? '—'}</td></tr>)}<tr><td>En blanco</td><td>{latestResult.counts[area]?.blank ?? '—'}</td></tr><tr><td>Nulos</td><td>{latestResult.counts[area]?.invalid ?? '—'}</td></tr></tbody></table></div></section>}
    </>}
  </main>;
}
