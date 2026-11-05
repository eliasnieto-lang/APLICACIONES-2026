import { useState } from 'react';
import type { Area } from '../../shared/types';
import type { PaperPoll } from '../../shared/paper-vote';
import { BLOCKS, GRADES } from '../../shared/domain';

function voteLabel(poll: PaperPoll, classroom: NonNullable<PaperPoll['classrooms']>[number], area: Area) {
  if (classroom.attendance === 'absent') return '—';
  if (!classroom.received) return 'Pendiente de transcribir';
  const choice = classroom.choices?.[area];
  if (choice === null) return 'Voto en blanco';
  if (choice === '__invalid__') return 'Voto nulo';
  return poll.options[area]?.find(option => option.id === choice)?.name ?? 'Pendiente de revisar';
}

export default function PublicPaperLedger({ polls }: { polls: PaperPoll[] }) {
  const available = polls.filter(poll => poll.rosterVersion === 1 && poll.classrooms);
  const [selectedId, setSelectedId] = useState('');
  const [grade, setGrade] = useState('all');
  const [status, setStatus] = useState('all');
  const poll = available.find(item => item.id === selectedId) ?? available.find(item => item.status === 'open') ?? available.at(-1);
  if (!poll) return null;
  const classrooms = poll.classrooms ?? [];
  const grades = GRADES.filter(item => classrooms.some(classroom => classroom.gradeId === item.id));
  const rows = classrooms.filter(classroom => (grade === 'all' || classroom.gradeId === grade)
    && (status === 'all' || status === 'received' && classroom.received || status === 'absent' && classroom.attendance === 'absent'
      || status === 'pending' && !classroom.received && classroom.attendance !== 'absent'));
  const absent = classrooms.filter(classroom => classroom.attendance === 'absent').length;
  return <section className="card stack public-paper-ledger" id="votacion-padres">
    <style>{styles}</style>
    <header><span className="eyebrow">CONSULTA PARA LAS FAMILIAS</span><h2>Votación por aula</h2>
      <p>Compare las opciones registradas con la ficha impresa del aula. Si encuentra una diferencia, solicite a Subdirección revisar el papel antes de cerrar la votación.</p>
    </header>
    <div className="grid ledger-filters">
      <label className="field">Votación de familias<select aria-label="Votación de familias" value={poll.id} onChange={event => { setSelectedId(event.target.value); setGrade('all'); setStatus('all'); }}>
        {available.map(item => <option key={item.id} value={item.id}>{BLOCKS.find(block => block.id === item.block)?.label ?? item.block} · {item.status === 'open' ? 'Abierta' : 'Cerrada'}{item.createdAt ? ` · ${new Date(item.createdAt).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}` : ''}</option>)}
      </select></label>
      <label className="field">Grado del aula<select aria-label="Grado del aula" value={grade} onChange={event => setGrade(event.target.value)}><option value="all">Todos los grados</option>{grades.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="field">Mostrar aulas<select aria-label="Mostrar aulas" value={status} onChange={event => setStatus(event.target.value)}><option value="all">Todas las aulas</option><option value="received">Votos registrados</option><option value="pending">Pendientes de transcribir</option><option value="absent">Sin asistencia</option></select></label>
    </div>
    <p className="notice" role="status"><strong>{poll.status === 'open' ? 'Registro en curso' : 'Votación cerrada'}</strong> · {poll.received} de {classrooms.length} aulas con voto registrado · {absent} sin asistencia. Las aulas pendientes no cuentan como voto en blanco.</p>
    <div className="table-wrap"><table aria-label="Votos registrados por aula"><thead><tr><th>Folio</th><th>Aula</th><th>Asistencia</th><th>Matemática</th><th>Comunicación</th><th>Registro</th></tr></thead><tbody>
      {rows.map(classroom => <tr key={classroom.id}><td data-label="Folio"><strong>{classroom.folio}</strong></td><th scope="row" data-label="Aula">{classroom.label}</th>
        <td data-label="Asistencia">{classroom.attendance === 'absent' ? 'Sin asistencia' : classroom.attendance === 'present' ? 'Con asistencia' : 'Pendiente de confirmar'}</td>
        <td data-label="Matemática">{voteLabel(poll, classroom, 'MAT')}</td><td data-label="Comunicación">{voteLabel(poll, classroom, 'COM')}</td>
        <td data-label="Registro">{classroom.received ? (classroom.voteVersion ?? 1) > 1 ? `Revisado · versión ${classroom.voteVersion}` : 'Registrado' : classroom.attendance === 'absent' ? 'Sin representante' : 'Pendiente'}</td></tr>)}
    </tbody></table></div>
    {!rows.length && <p>No hay aulas con estos filtros.</p>}
    <p className="muted">La ficha impresa permite cotejar el registro. Las correcciones se realizan antes del cierre y conservan su historial. Use «Actualizar» para consultar cambios recientes.</p>
  </section>;
}

const styles = `.public-paper-ledger{scroll-margin-top:20px;min-width:0}.public-paper-ledger table{min-width:0;width:100%}.public-paper-ledger h2{margin:4px 0 12px}.public-paper-ledger th,.public-paper-ledger td{vertical-align:top}.public-paper-ledger .ledger-filters{grid-template-columns:2fr 1fr 1fr}@media(max-width:700px){.public-paper-ledger .ledger-filters{grid-template-columns:1fr}.public-paper-ledger .table-wrap{overflow:visible}.public-paper-ledger table,.public-paper-ledger tbody,.public-paper-ledger tr,.public-paper-ledger td,.public-paper-ledger th[scope=row]{display:block;width:100%}.public-paper-ledger thead{display:none}.public-paper-ledger tr{padding:12px 0;border-bottom:1px solid var(--line)}.public-paper-ledger td,.public-paper-ledger th[scope=row]{border:0;padding:5px 0}.public-paper-ledger td:before,.public-paper-ledger th[scope=row]:before{content:attr(data-label);display:block;font-size:11px;color:var(--muted);font-weight:400}}`;
