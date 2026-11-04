import { useEffect, useState } from 'react';
import { AREAS, GRADES, sourceToTargetGrade } from '../../shared/domain';
import type { Area, AreaCount, GradeId, Round, Section, State, ViewProps } from '../../shared/types';

const gradeLabel = (id: string) => GRADES.find(g => g.id === id)?.label || id;
const areaLabel = (id: Area) => AREAS.find(a => a.id === id)?.label || id;
const roundLabel = { draft: 'Borrador', open: 'Abierta', closed: 'Cerrada', suspended: 'Suspendida: requiere conciliación', void: 'Anulada' };
const resultLabel = { winner: 'Acuerdo cerrado', tie: 'Pendiente: empate', no_valid_votes: 'Pendiente: sin votos válidos', insufficient_representation: 'Pendiente: representación insuficiente', pending: 'Pendiente' };

function offerLabel(state: State, id: string, gradeId: GradeId) {
  const offer = state.offers.find(o => o.id === id);
  const series = state.series.find(s => s.id === offer?.seriesId);
  const publisher = state.publishers.find(p => p.id === series?.publisherId);
  const book = state.books.find(b => b.offerId === id && b.gradeId === gradeId && b.active);
  return `${book?.title || series?.name || id} · ${publisher?.name || ''} · ${book?.edition || offer?.edition || ''}`;
}

const newSection = (): Section => ({ id: '', version: 0, label: '', sourceGrade: 'INI5', gradeId: 'PRI1', representative: '', replacement: false, accredited: false, accreditationEvidence: '' });

export default function Voting(props: ViewProps) {
  const { snapshot, api, refresh, notify } = props;
  const { state } = snapshot;
  const [tab, setTab] = useState<'rounds' | 'roster'>('rounds');
  const [gradeId, setGradeId] = useState<GradeId>('PRI1');
  const [mode, setMode] = useState<'paper' | 'digital'>('paper');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>(newSection);
  const [deleteId, setDeleteId] = useState('');
  const coordinator = snapshot.actor.role === 'coordinator';
  const sections = state.sections.filter(s => s.gradeId === gradeId);
  const rounds = state.rounds.filter(r => r.gradeId === gradeId).sort((a, b) => b.number - a.number);
  async function run(action: string, payload: Record<string, unknown>, message: string) {
    setBusy(true);
    try { await api.call(action, payload); await refresh(); notify(message); return true; }
    catch (e) { notify(e instanceof Error ? e.message : 'La operación no pudo confirmarse.', true); return false; }
    finally { setBusy(false); }
  }
  async function saveSection() {
    if (!section.label.trim() || !section.sourceGrade.trim()) return notify('Indique la sección y el grado de origen 2026.', true);
    if (section.accredited && (!section.representative.trim() || !section.accreditationEvidence.trim())) return notify('La acreditación requiere representante y sustento.', true);
    if (await run('section_save', { section }, 'Sección guardada.')) setSection(newSection());
  }
  async function createRound() {
    if (!reviewed) return notify('Confirme la revisión física antes de crear la ronda.', true);
    if (await run('round_create', { gradeId, mode, physicalReviewConfirmed: true }, 'Ronda creada en borrador. Revise el padrón antes de abrirla.')) setReviewed(false);
  }
  return <div className="stack">
    <div><h1>Padrón y elección familiar</h1><p className="muted">Una representación por sección, una modalidad por grado y ronda, y un acuerdo independiente por área.</p></div>
    {!coordinator && <p className="notice">Secretaría acredita representantes, registra entregas y guarda el escrutinio en papel. Coordinación crea, abre y cierra las rondas y genera las fichas digitales.</p>}
    <div className="tabs"><button aria-pressed={tab === 'rounds'} onClick={() => setTab('rounds')}>Rondas y escrutinio</button><button aria-pressed={tab === 'roster'} onClick={() => setTab('roster')}>Padrón 2026 → 2027</button></div>
    <label className="field">Grado representado 2027<select value={gradeId} onChange={e => setGradeId(e.target.value as GradeId)}>{GRADES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
    <div className="notice">{sections.filter(s => s.accredited).length} secciones acreditadas de {sections.length}. Representación mínima: {state.settings.rules.minimumRepresentation === null ? 'pendiente de fijar por Dirección' : state.settings.rules.representationMode === 'percentage' ? `${state.settings.rules.minimumRepresentation}%` : `${state.settings.rules.minimumRepresentation} cédulas`}. La regla queda fijada antes del inicio.</div>
    {tab === 'roster' ? <>
      <section className="card stack"><h2>{section.id ? 'Editar representación de sección' : 'Registrar sección'}</h2><div className="grid">
        <label className="field">Sección de origen (clave única)<input value={section.label} onChange={e => setSection({ ...section, label: e.target.value })} placeholder="Ej.: 5 años A · 2026" /></label>
        <label className="field">Nivel y grado de origen 2026<select value={section.sourceGrade} onChange={e => { const sourceGrade = e.target.value; setSection({ ...section, sourceGrade, gradeId: sourceToTargetGrade(sourceGrade) || section.gradeId }); }}><option value="INI5">Inicial de 5 años</option>{GRADES.filter(g => !['SEC3'].includes(g.id)).map(g => <option key={g.id} value={g.id}>{g.label}</option>)}{section.sourceGrade !== 'INI5' && !GRADES.some(g => g.id === section.sourceGrade) && <option value={section.sourceGrade}>{section.sourceGrade}</option>}</select></label>
        <label className="field">Grado representado 2027<select value={section.gradeId} onChange={e => setSection({ ...section, gradeId: e.target.value as GradeId })}>{GRADES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
        <label className="field">Representante acreditado<input value={section.representative} onChange={e => setSection({ ...section, representative: e.target.value })} /></label>
        <label className="field">Sustento de acreditación<input value={section.accreditationEvidence} onChange={e => setSection({ ...section, accreditationEvidence: e.target.value })} placeholder="Acta, folio o constancia" /></label>
      </div><div className="row"><label><input type="checkbox" checked={section.replacement} onChange={e => setSection({ ...section, replacement: e.target.checked })} /> Representa como suplente</label><label><input type="checkbox" checked={section.accredited} onChange={e => setSection({ ...section, accredited: e.target.checked })} /> Acreditado</label></div><p className="muted">Inicial de 5 años corresponde a 1.º de primaria; 6.º de primaria corresponde a 1.º de secundaria. Titular y suplente comparten una única representación.</p><div className="row"><button disabled={busy} onClick={() => void saveSection()}>Guardar sección</button>{section.id && <button onClick={() => setSection(newSection())}>Cancelar edición</button>}</div></section>
      <section className="card"><h2>Padrón de {gradeLabel(gradeId)}</h2><div className="table-wrap"><table><thead><tr><th>Sección</th><th>Origen 2026</th><th>Representante</th><th>Condición</th><th>Acciones</th></tr></thead><tbody>{sections.map(s => <tr key={s.id}><td>{s.label}</td><td>{gradeLabel(s.sourceGrade)}</td><td>{s.representative || 'Pendiente'}<br /><small>{s.replacement ? 'Suplente' : 'Titular'}</small></td><td>{s.accredited ? 'Acreditado' : 'Pendiente'}<br /><small>{s.accreditationEvidence}</small></td><td><div className="row"><button onClick={() => { setSection({ ...s }); setDeleteId(''); }}>Editar</button><button onClick={() => setDeleteId(s.id)}>Eliminar</button></div>{deleteId === s.id && <div className="notice"><p>Eliminar la sección {s.label}. Solo se permite si no tiene entregas ni rondas activas.</p><button disabled={busy} onClick={() => void run('section_save', { section: s, remove: true }, 'Sección eliminada.').then(ok => { if (ok) setDeleteId(''); })}>Confirmar eliminación</button><button onClick={() => setDeleteId('')}>Cancelar</button></div>}</td></tr>)}</tbody></table></div>{!sections.length && <p>No hay secciones registradas para este destino.</p>}</section>
    </> : <>
      {coordinator && <section className="card stack"><h2>Preparar nueva ronda</h2><p>Las opciones proceden de las ternas publicadas vigentes para este grado. La revisión física de los ejemplares debe concluir antes de votar.</p><label className="field">Modalidad de la ronda<select value={mode} onChange={e => setMode(e.target.value as 'paper' | 'digital')}><option value="paper">Papel · opción inicial de la jornada</option><option value="digital">Digital · ficha anónima de un solo uso</option></select></label><label className="row"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />Confirmo que las familias dispusieron de tiempo para revisar los ejemplares físicos.</label><button disabled={busy || !reviewed} onClick={() => void createRound()}>Crear ronda en borrador</button></section>}
      {!rounds.length && <div className="card"><p>No hay rondas para {gradeLabel(gradeId)}. Publique y valide sus finalistas antes de abrir la elección.</p></div>}
      {rounds.map(round => <RoundPanel key={round.id} {...props} round={round} sections={sections} />)}
    </>}
  </div>;
}

function RoundPanel({ snapshot, api, refresh, notify, round, sections }: ViewProps & { round: Round; sections: Section[] }) {
  const { state } = snapshot;
  const [busy, setBusy] = useState(false);
  const [deposited, setDeposited] = useState(String(round.deposited));
  const [counts, setCounts] = useState<Partial<Record<Area, AreaCount>>>({});
  const [reason, setReason] = useState('');
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [codeConfirmed, setCodeConfirmed] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [printTarget, setPrintTarget] = useState<'codes' | 'ballot' | null>(null);
  const [runoffMode, setRunoffMode] = useState<'paper' | 'digital'>(round.mode);
  const coordinator = snapshot.actor.role === 'coordinator';
  useEffect(() => { const clear = () => setPrintTarget(null); window.addEventListener('afterprint', clear); return () => window.removeEventListener('afterprint', clear); }, []);
  useEffect(() => {
    setDeposited(String(round.deposited)); setCloseConfirmed(false);
    const result: Partial<Record<Area, AreaCount>> = {};
    for (const area of round.areas) result[area] = { options: Object.fromEntries((round.options[area] || []).map(id => [id, round.counts[area]?.options[id] || 0])), blank: round.counts[area]?.blank || 0, invalid: round.counts[area]?.invalid || 0 };
    setCounts(result);
  }, [round.id, round.version]);
  async function run(action: string, payload: Record<string, unknown>, message: string) {
    setBusy(true);
    try { const result = await api.call(action, payload); await refresh(); notify(message); return result; }
    catch (e) { notify(e instanceof Error ? e.message : 'La operación no pudo confirmarse.', true); return null; }
    finally { setBusy(false); }
  }
  const accredited = sections.filter(s => s.accredited);
  const delivered = state.deliveries.filter(d => d.roundId === round.id && d.delivered).length;
  const depositedNumber = Number(deposited);
  const validDeposited = deposited.trim() !== '' && Number.isSafeInteger(depositedNumber) && depositedNumber >= 0 && depositedNumber <= delivered && delivered <= accredited.length;
  const sum = (area: Area) => Object.values(counts[area]?.options || {}).reduce((n, v) => n + v, 0) + (counts[area]?.blank || 0) + (counts[area]?.invalid || 0);
  const validCounts = round.areas.every(area => counts[area] && [...Object.values(counts[area]!.options), counts[area]!.blank, counts[area]!.invalid].every(n => Number.isSafeInteger(n) && n >= 0) && sum(area) === depositedNumber);
  const tallyReady = validDeposited && validCounts;
  const tallySaved = depositedNumber === round.deposited && round.areas.every(area => {
    const saved = round.counts[area];
    return !!saved && counts[area]?.blank === saved.blank && counts[area]?.invalid === saved.invalid && (round.options[area] || []).every(id => counts[area]?.options[id] === (saved.options[id] || 0));
  });
  function updateCount(area: Area, key: string, value: string) {
    const number = value === '' ? Number.NaN : Number(value);
    setCounts(old => { const next = old[area] || { options: {}, blank: 0, invalid: 0 }; return { ...old, [area]: key === 'blank' || key === 'invalid' ? { ...next, [key]: number } : { ...next, options: { ...next.options, [key]: number } } }; });
  }
  async function generateCodes() {
    const result = await run('ballots_generate', { roundId: round.id }, 'Fichas anónimas generadas. Imprima y mezcle antes de entregar.') as { codes: string[] } | null;
    if (result?.codes) { setCodes(result.codes); setCodeConfirmed(false); setHasGenerated(true); }
  }
  function print(kind: 'codes' | 'ballot') { setPrintTarget(kind); setTimeout(() => window.print(), 100); }
  return <section className="card stack">
    <div className="row"><h2>Ronda {round.number}{round.parentId ? ' · segunda vuelta' : ''}</h2><span className="status">{roundLabel[round.status]}</span><span>{round.mode === 'paper' ? 'Papel' : 'Digital'} · {round.areas.map(areaLabel).join(' / ')}</span></div>
    <p className="muted">{gradeLabel(round.gradeId)} · Revisión física {round.physicalReviewConfirmed ? 'confirmada' : 'pendiente'} · Representación mínima fijada: {round.minimumRequired} cédulas</p>
    <div className="grid">{round.areas.map(area => <div key={area}><strong>{areaLabel(area)}</strong><ul>{(round.options[area] || []).map(id => <li key={id}>{offerLabel(state, id, round.gradeId)}</li>)}</ul></div>)}</div>
    {round.status === 'draft' && <div className="notice"><p>La modalidad se fija para esta ronda. El padrón de entrega comienza vacío, también en segunda vuelta.</p>{coordinator && <button disabled={busy} onClick={() => void run('round_open', { roundId: round.id }, 'Ronda abierta.')}>Abrir ronda {round.number}</button>}</div>}
    {(round.status === 'draft' || round.status === 'open') && <>
      <div className="row"><span>Acreditadas: <strong>{accredited.length}</strong></span><span>Entregadas: <strong>{delivered}</strong></span>{round.mode === 'paper' && <button onClick={() => print('ballot')}>Imprimir cédula anónima</button>}</div>
      <details open={round.status === 'open'}><summary>Padrón de entrega de esta ronda</summary><p className="muted">Registre solo la entrega de la cédula o ficha. Las opciones marcadas y los códigos se conservan separados del padrón.</p><div className="table-wrap"><table><thead><tr><th>Sección</th><th>Representación</th><th>Entrega</th></tr></thead><tbody>{accredited.map(section => { const checked = state.deliveries.some(d => d.roundId === round.id && d.sectionId === section.id && d.delivered); return <tr key={section.id}><td>{section.label}</td><td>{section.representative} · {section.replacement ? 'suplente' : 'titular'}</td><td><label><input type="checkbox" checked={checked} disabled={busy || round.status !== 'open'} onChange={e => void run('delivery_mark', { roundId: round.id, sectionId: section.id, delivered: e.target.checked }, 'Entrega actualizada.')} /> {checked ? 'Entregada' : 'Sin entregar'}</label></td></tr>; })}</tbody></table></div></details>
      {round.status === 'open' && round.mode === 'digital' && <div className="notice stack"><p>Genere las fichas una sola vez, imprímalas, mézclelas y entregue una por sección acreditada. Los códigos se muestran una única vez y no se vinculan al padrón.</p>{coordinator ? <><label className="row"><input type="checkbox" checked={codeConfirmed} onChange={e => setCodeConfirmed(e.target.checked)} />Confirmo impresión y entrega sin registrar correspondencia entre sección y código.</label><button disabled={busy || !codeConfirmed || hasGenerated} onClick={() => void generateCodes()}>Generar fichas anónimas</button></> : <p>Coordinación genera las fichas anónimas. Secretaría registra únicamente su entrega.</p>}<p className="muted">Los conteos digitales permanecen reservados hasta el cierre.</p></div>}
      {codes.length > 0 && <div className="notice"><strong>{codes.length} fichas listas para imprimir</strong><p>Esta hoja contiene códigos de acceso. Resguárdela y evite copias.</p><div className="row"><button onClick={() => print('codes')}>Imprimir hoja de fichas</button><button onClick={() => { setCodes([]); setPrintTarget(null); }}>Ocultar y descartar de esta pantalla</button></div></div>}
      {round.status === 'open' && round.mode === 'paper' && <section className="stack"><h3>Escrutinio en papel</h3><label className="field">Cédulas depositadas<input type="number" min="0" max={delivered} step="1" value={deposited} onChange={e => setDeposited(e.target.value)} /></label><p className="muted">Por cada área: opciones + blancos + nulos = depositadas ≤ entregadas ≤ acreditadas. Un nulo de un área conserva el voto de la otra.</p><div className="grid">{round.areas.map(area => <fieldset className="stack" key={area}><legend>{areaLabel(area)}</legend>{(round.options[area] || []).map(id => <label className="field" key={id}>{offerLabel(state, id, round.gradeId)}<input type="number" min="0" step="1" value={Number.isNaN(counts[area]?.options[id]) ? '' : counts[area]?.options[id] ?? 0} onChange={e => updateCount(area, id, e.target.value)} /></label>)}{(['blank', 'invalid'] as const).map(key => <label className="field" key={key}>{key === 'blank' ? 'En blanco' : 'Nulos'}<input type="number" min="0" step="1" value={Number.isNaN(counts[area]?.[key]) ? '' : counts[area]?.[key] ?? 0} onChange={e => updateCount(area, key, e.target.value)} /></label>)}<p className={sum(area) === depositedNumber ? 'status' : 'notice'}>Suma del área: {Number.isFinite(sum(area)) ? sum(area) : 'pendiente'} / {deposited || 'pendiente'} depositadas</p></fieldset>)}</div>{!validDeposited && <p className="notice">Revise depositadas, entregadas y acreditadas: los conteos deben ser enteros y conciliar.</p>}<button disabled={busy || !tallyReady} onClick={() => void run('paper_tally_save', { roundId: round.id, deposited: depositedNumber, counts, expectedVersion: round.version }, 'Escrutinio guardado en el servidor.')}>Guardar escrutinio conciliado</button></section>}
      {round.status === 'open' && coordinator && <div className="stack"><label className="row"><input type="checkbox" checked={closeConfirmed} onChange={e => setCloseConfirmed(e.target.checked)} />Confirmo el cierre de recepción y la revisión de incidencias de esta ronda.</label><button disabled={busy || !closeConfirmed || (round.mode === 'paper' && (!tallyReady || !tallySaved))} onClick={() => void run('round_close', { roundId: round.id }, 'Ronda cerrada. Consulte los acuerdos por área.')}>Cerrar ronda y calcular acuerdos</button>{round.mode === 'paper' && !tallySaved && <p className="notice">Guarde el escrutinio conciliado antes de cerrar la ronda.</p>}</div>}
    </>}
    {round.status === 'closed' && <div className="grid">{round.areas.map(area => { const result = round.results[area]; const tally = round.counts[area]; return <section key={area} className="stack"><h3>{areaLabel(area)} · {result ? resultLabel[result.state] : 'Pendiente'}</h3>{result?.winnerId && <p><strong>{offerLabel(state, result.winnerId, round.gradeId)}</strong></p>}<div className="table-wrap"><table><thead><tr><th>Opción</th><th>Votos</th></tr></thead><tbody>{(round.options[area] || []).map(id => <tr key={id}><td>{offerLabel(state, id, round.gradeId)}</td><td>{tally?.options[id] ?? '—'}</td></tr>)}<tr><td>Blancos</td><td>{tally?.blank ?? '—'}</td></tr><tr><td>Nulos</td><td>{tally?.invalid ?? '—'}</td></tr></tbody></table></div>{result?.state === 'tie' && <><p>Segunda vuelta limitada a {areaLabel(area)} de {gradeLabel(round.gradeId)}: {result.tiedIds.map(id => offerLabel(state, id, round.gradeId)).join('; ')}.</p>{coordinator && <><label className="field">Modalidad de la segunda vuelta<select value={runoffMode} onChange={e => setRunoffMode(e.target.value as 'paper' | 'digital')}><option value="paper">Papel</option><option value="digital">Digital anónima</option></select></label><button disabled={busy || state.rounds.some(r => r.parentId === round.id && r.areas.includes(area) && r.status !== 'void')} onClick={() => void run('runoff_open', { roundId: round.id, area, mode: runoffMode }, 'Segunda vuelta creada con padrón de entrega nuevo.')}>Crear segunda vuelta solo de {areaLabel(area)}</button></>}</>}{result && ['tie', 'no_valid_votes', 'insufficient_representation', 'pending'].includes(result.state) && <p className="notice">El acuerdo permanece pendiente. La nota técnica no sustituye la elección familiar.</p>}<p className="muted">Depositadas: {round.deposited} · Entregadas: {round.delivered}</p></section>; })}</div>}
    {round.status === 'suspended' && <div className="notice stack"><h3>Ronda suspendida tras restauración</h3><p>Los códigos consumidos conservan su estado. Registre una conciliación documentada; esta acción anula la ronda suspendida y exige iniciar una ronda nueva.</p>{coordinator && <label className="field">Motivo, revisión de respaldo y folio<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>}{coordinator && <button disabled={busy || !reason.trim()} onClick={() => void run('round_reconcile', { roundId: round.id, reason: reason.trim(), action: 'void-and-restart' }, 'Ronda anulada con conciliación. Prepare una ronda nueva.')}>Registrar conciliación y anular para reiniciar</button>}</div>}
    {round.status === 'void' && <p className="notice">Ronda anulada. {round.reconciliationReason}</p>}
    {printTarget && <div className="voting-print-sheet" id={`print-${round.id}`}>
      <style>{`@media screen{.voting-print-sheet{display:none}}@media print{body *{visibility:hidden!important}.voting-print-sheet,.voting-print-sheet *{visibility:visible!important}.voting-print-sheet{display:block!important;position:absolute;inset:0;background:white;color:black;padding:12mm}.code-grid{display:grid;grid-template-columns:1fr 1fr;gap:8mm}.code-slip{border:1px dashed #555;padding:6mm;break-inside:avoid}.code-slip code{font-size:17pt}.voting-print-sheet table{width:100%;border-collapse:collapse}.voting-print-sheet td,.voting-print-sheet th{padding:5mm;border:1px solid #777}.voting-print-sheet h1{font-size:18pt}@page{size:A4;margin:12mm}}`}</style>
      <h1>{state.settings.title}</h1><h2>{gradeLabel(round.gradeId)} · Ronda {round.number}</h2>
      {printTarget === 'codes' ? <><p>Fichas anónimas: recortar, mezclar y entregar sin registrar correspondencia.</p><div className="code-grid">{codes.map(code => <div className="code-slip" key={code}><strong>{gradeLabel(round.gradeId)} · ronda {round.number}</strong><p>Voto digital anónimo de un solo uso</p><code>{code}</code><p>Acceso: {window.location.origin}</p></div>)}</div></> : <><p>Cédula anónima · Marque una sola opción por área. Puede dejar un área en blanco.</p><div className="grid">{round.areas.map(area => <div key={area}><h3>{areaLabel(area)}</h3><table><tbody>{(round.options[area] || []).map(id => <tr key={id}><td>□</td><td>{offerLabel(state, id, round.gradeId)}</td></tr>)}</tbody></table></div>)}</div><p>La cédula no lleva nombre, sección ni firma individual.</p></>}
    </div>}
  </section>;
}
