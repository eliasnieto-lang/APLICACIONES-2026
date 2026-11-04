import { useId, useState } from 'react';
import { RefreshCw, Users } from 'lucide-react';
import type { Area, Block, ViewProps } from '../../shared/types';
import { AREAS, BLOCKS } from '../../shared/domain';
import { teacherProgress, type TeacherProgressStatus } from '../../shared/jornada';

const statusLabels: Record<TeacherProgressStatus, string> = {
  waiting: 'Sin fichas disponibles', not_started: 'Sin iniciar', in_progress: 'En proceso', complete: 'Finalizado',
};
const percent = (value: number) => value.toLocaleString('es-PE', { maximumFractionDigits: 1 });

export default function TeacherProgress({ snapshot, refresh, notify }: ViewProps) {
  const prefix = useId();
  const [area, setArea] = useState<Area | 'all'>('all');
  const [block, setBlock] = useState<Block | 'all'>('all');
  const [status, setStatus] = useState<TeacherProgressStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  if (snapshot.actor.role !== 'coordinator') return <div className="notice">El seguimiento de todos los docentes corresponde a Subdirección.</div>;
  const scoped = teacherProgress(snapshot.state, { area: area === 'all' ? undefined : area, block: block === 'all' ? undefined : block });
  const rows = scoped.filter(row => (status === 'all' || row.status === status)
    && row.teacher.name.toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es')))
    .sort((left, right) => left.teacher.name.localeCompare(right.teacher.name, 'es'));
  const marked = scoped.reduce((sum, row) => sum + row.markedCriteria, 0);
  const expected = scoped.reduce((sum, row) => sum + row.expectedCriteria, 0);
  async function sync() {
    setBusy(true);
    try { await refresh(); notify('Avance actualizado desde el servidor.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'No se pudo actualizar el avance.', true); }
    finally { setBusy(false); }
  }
  return <div className="stack teacher-progress"><style>{styles}</style>
    <header className="row between"><div><span className="eyebrow">SEGUIMIENTO DE LA JORNADA</span><h1>Docentes y avance</h1><p className="muted">Consulte quién está evaluando y qué fichas faltan por cerrar.</p></div><button type="button" className="secondary" disabled={busy} onClick={() => void sync()}><RefreshCw size={17} />{busy ? 'Actualizando…' : 'Actualizar avance'}</button></header>
    <section className="card progress-filters" aria-label="Filtros de seguimiento">
      <label className="field" htmlFor={`${prefix}-area`}>Área<select aria-label="Área" id={`${prefix}-area`} value={area} onChange={event => setArea(event.target.value as Area | 'all')}><option value="all">Todas las áreas</option>{AREAS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="field" htmlFor={`${prefix}-block`}>Categoría<select aria-label="Categoría" id={`${prefix}-block`} value={block} onChange={event => setBlock(event.target.value as Block | 'all')}><option value="all">Todas las categorías</option>{BLOCKS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="field" htmlFor={`${prefix}-status`}>Estado<select aria-label="Estado" id={`${prefix}-status`} value={status} onChange={event => setStatus(event.target.value as TeacherProgressStatus | 'all')}><option value="all">Todos los estados</option>{Object.entries(statusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="field" htmlFor={`${prefix}-search`}>Buscar docente<input aria-label="Buscar docente" id={`${prefix}-search`} type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Apellidos o nombres" /></label>
      <button type="button" className="secondary" onClick={() => { setArea('all'); setBlock('all'); setStatus('all'); setSearch(''); }}>Limpiar filtros</button>
    </section>
    <section className="grid" aria-label="Resumen del avance"><div className="card"><span className="muted">Docentes del área y categoría</span><h2><Users size={21} /> {scoped.length}</h2></div><div className="card"><span className="muted">Terminaron y cerraron sus fichas</span><h2>{scoped.filter(row => row.status === 'complete').length}</h2></div><div className="card"><span className="muted">Criterios registrados</span><h2>{expected ? percent(marked / expected * 100) : '0'} %</h2><small>{marked} de {expected} respuestas esperadas</small></div></section>
    <section className="card stack"><div><h2>Listado de docentes registrados</h2><p className="muted">El avance cuenta las respuestas guardadas de 0 a 4; elegir cero también cuenta como respuesta. Para finalizar, deben cerrarse todas las fichas. Los cambios sin sincronizar aún no aparecen.</p></div>
      <p className="muted">{rows.length} de {scoped.length} docentes según los filtros.</p>
      {rows.length === 0 ? <div className="empty-state">{snapshot.state.teachers.length ? 'No hay docentes con estos filtros.' : 'Los docentes aparecerán aquí al registrarse en la jornada.'}</div> : <div className="table-wrap"><table className="progress-table"><thead><tr><th>Docente</th><th>Área y categorías</th><th>Avance de respuestas</th><th>Fichas cerradas</th><th>Estado</th></tr></thead><tbody>{rows.map(row => <tr key={row.teacher.id}>
        <th scope="row" data-label="Docente">{row.teacher.name}</th>
        <td data-label="Área y categorías">{AREAS.find(item => item.id === row.teacher.area)?.label ?? 'Área sin registrar'}<small>{row.categories.length ? row.categories.join(' · ') : 'Sin categorías registradas'}</small></td>
        <td data-label="Avance"><strong>{percent(row.percentage)} %</strong><progress max={100} value={row.percentage} aria-label={`Avance de ${row.teacher.name}`} /><small>{row.markedCriteria}/{row.expectedCriteria} criterios</small></td>
        <td data-label="Fichas cerradas"><strong>{row.closedSheets} / {row.expectedSheets}</strong><small>{row.pendingSheets} pendientes de cierre</small>{row.historicalSheets > 0 && <small>{row.historicalSheets} con escala anterior</small>}{row.conflictingSheets > 0 && <small className="progress-alert">{row.conflictingSheets} requieren revisión por conflicto</small>}</td>
        <td data-label="Estado"><span className={`status ${row.status === 'complete' ? 'closed' : 'pending'}`}>{statusLabels[row.status]}</span>{row.percentage === 100 && row.pendingSheets > 0 && <small>Falta confirmar el cierre.</small>}</td>
      </tr>)}</tbody></table></div>}
    </section>
  </div>;
}
const styles = `.teacher-progress{min-width:0}.teacher-progress h1{margin-bottom:8px}.teacher-progress header p{margin-bottom:0}.teacher-progress .progress-filters{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr)) minmax(170px,1.3fr) auto;gap:14px;align-items:end}.teacher-progress .progress-filters .field{min-width:0}.teacher-progress .progress-filters button{min-height:43px}.teacher-progress .grid h2{display:flex;align-items:center;gap:7px;margin:10px 0}.teacher-progress small{display:block;color:var(--muted);margin-top:5px}.teacher-progress progress{display:block;width:100%;min-width:120px;height:12px;margin:7px 0 3px;accent-color:var(--navy)}.teacher-progress .progress-alert{color:#b4233c}.teacher-progress .progress-table th[scope=row]{font-weight:700;min-width:160px}.teacher-progress .progress-table td{vertical-align:top}.teacher-progress .progress-table{width:100%}@media(max-width:1100px){.teacher-progress .progress-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.teacher-progress .progress-filters button{justify-self:start}}@media(max-width:620px){.teacher-progress .progress-filters{grid-template-columns:1fr}.teacher-progress .progress-table thead{display:none}.teacher-progress .progress-table,.teacher-progress .progress-table tbody,.teacher-progress .progress-table tr,.teacher-progress .progress-table th,.teacher-progress .progress-table td{display:block;min-width:0;width:100%}.teacher-progress .progress-table tr{padding:14px 0;border-bottom:1px solid var(--line)}.teacher-progress .progress-table td,.teacher-progress .progress-table th[scope=row]{border:0;padding:7px 0}.teacher-progress .progress-table td:before{content:attr(data-label);display:block;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:4px}.teacher-progress .progress-table th[scope=row]{font-size:16px}.teacher-progress .progress-table progress{max-width:280px}.teacher-progress .table-wrap{overflow:visible}}`;
