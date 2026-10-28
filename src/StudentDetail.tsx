import { documentUrl } from './runtime';
import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, Clock3, FileText, History, Info, LoaderCircle, Plus, Save, ShieldCheck, Trash2, Users } from 'lucide-react';
import type { AcademicArea, Commitment, Dataset, Grade, PdfRecord, Settings, Student } from '../shared/types';
import { calculateStudent, fmt } from '../shared/calculations';
import { ACTIVE_BIMESTERS, ALLOWED_COHORTS, isReportApproved, normalizeCohort } from '../shared/policy';

interface Props {
  student: Student;
  settings: Settings;
  pdfs: PdfRecord[];
  onSave: (student: Student) => Promise<Student>;
  onBack: () => void;
  onReview?: () => void;
  readOnly: boolean;
  onNext: () => void;
  dataset?: Dataset;
}

const labels = { academic: 'Académico', performance: 'Desempeño', commitment: 'Compromiso', documents: 'Documentos e historial' };
type Tab = keyof typeof labels;
type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';
const uid = () => crypto.randomUUID();
const percent = (n: number) => `${Math.round(n)} %`;
const numberOrNull = (s: string) => s === '' ? null : Number(s);
const emptyRecord = (): Commitment => ({ id: uid(), name: '', date: '', required: false, status: 'pending', justification: '', evidence: '', validated: false });

function MiniProgress({ label, value, className = '' }: { label: string; value: number; className?: string }) {
  return <div className={`detail-progress ${className}`}><div className="detail-progress-label"><span>{label}</span><strong>{percent(value)}</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${value}%` }} /></div></div>;
}

function Metric({ label, value, hint, na }: { label: string; value: number | null; hint?: string; na?: boolean }) {
  return <div className="detail-metric"><span>{label}</span><strong>{na ? 'No aplica' : value === null ? 'Pendiente' : fmt(value)}</strong>{hint && <small>{hint}</small>}</div>;
}

export default function StudentDetail({ student, settings, pdfs, onSave, onBack, onReview, readOnly, onNext, dataset = 'real' }: Props) {
  const [draft, setDraft] = useState<Student>(() => structuredClone(student));
  const [tab, setTab] = useState<Tab>('academic');
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState('');
  const [pasteNotice, setPasteNotice] = useState('');
  const [showProfile, setShowProfile] = useState(false);
  const draftRef = useRef(draft);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const saveFn = useRef(onSave);
  const saveContext = useRef({ studentId: student.id, dataset });
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const mounted = useRef(true);
  // The parent clears the previous dataset in an effect. During that intermediate
  // render, keep its save callback so an unmount cannot write demo data to real.
  if (saveContext.current.studentId === student.id && saveContext.current.dataset === dataset) saveFn.current = onSave;

  const flush = async (): Promise<boolean> => {
    if (timeout.current) clearTimeout(timeout.current);
    if (inFlight.current) return inFlight.current;
    if (version.current === savedVersion.current) return true;
    const operation = (async () => {
      try {
        while (version.current !== savedVersion.current) {
          const savingVersion = version.current;
          const snapshot = structuredClone(draftRef.current);
          if (mounted.current) { setStatus('saving'); setSaveError(''); }
          const saved = await saveFn.current(snapshot);
          if (saved.id === draftRef.current.id) {
            const current = draftRef.current;
            const next = structuredClone(current);
            // Incorporate the revision immediately; the next queued save must use it.
            // A field edited during the request keeps the operator's newer value.
            for (const field of ['code', 'name', 'grade', 'section', 'academic', 'attendance', 'discipline', 'institutional', 'family', 'validated', 'reportApproval'] as const) {
              if (JSON.stringify(current[field]) === JSON.stringify(snapshot[field])) {
                Object.assign(next, { [field]: structuredClone(saved[field]) });
              }
            }
            next.updatedAt = saved.updatedAt;
            next.createdAt = saved.createdAt;
            next.history = saved.history;
            next.pdfIds = saved.pdfIds;
            draftRef.current = next;
            if (mounted.current) setDraft(next);
          }
          savedVersion.current = savingVersion;
        }
        if (mounted.current) setStatus('saved');
        return true;
      } catch (error) {
        if (mounted.current) {
          setStatus('error');
          setSaveError(error instanceof Error ? error.message : 'No se pudo guardar la ficha. Tus cambios siguen en pantalla.');
        }
        return false;
      }
    })();
    inFlight.current = operation;
    const ok = await operation;
    inFlight.current = null;
    return ok;
  };
  flushRef.current = flush;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timeout.current) clearTimeout(timeout.current); void flushRef.current(); };
  }, []);

  useEffect(() => {
    if (student.id === draftRef.current.id) return;
    if (timeout.current) clearTimeout(timeout.current);
    const next = structuredClone(student);
    saveContext.current = { studentId: student.id, dataset };
    saveFn.current = onSave;
    draftRef.current = next;
    version.current = 0;
    savedVersion.current = 0;
    setDraft(next);
    setStatus('saved');
    setSaveError('');
    setTab('academic');
  }, [student.id]);

  useEffect(() => {
    if (student.id !== draftRef.current.id) return;
    setDraft(current => {
      if (student.updatedAt < current.updatedAt) return current;
      const next = { ...current, history: student.history, updatedAt: student.updatedAt };
      draftRef.current = next;
      return next;
    });
  }, [student.history, student.updatedAt]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (version.current === savedVersion.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  const change = (mutate: (next: Student) => void) => {
    if (readOnly) return;
    const next = structuredClone(draftRef.current);
    mutate(next);
    draftRef.current = next;
    version.current += 1;
    setDraft(next);
    setStatus('pending');
    setSaveError('');
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => void flushRef.current(), 700);
  };

  const navigate = async (callback: () => void) => { if (await flushRef.current() && mounted.current) callback(); };
  const confirmChange = async (mutate: (next: Student) => void) => {
    const confirmingVersion = version.current;
    const confirmingStudent = draftRef.current.id;
    if (await flushRef.current() && mounted.current && version.current === confirmingVersion && draftRef.current.id === confirmingStudent) change(mutate);
  };
  const associatedPdfs = pdfs.filter(pdf => pdf.studentId === draft.id || draft.pdfIds.includes(pdf.id));
  const reportApproved = isReportApproved(draft) && associatedPdfs.some(pdf => pdf.id === draft.reportApproval?.pdfId && pdf.studentId === draft.id && pdf.status === 'validated');
  const computed = calculateStudent(draft, settings);
  const result = reportApproved ? computed : {
    ...computed, a: null, b: null, c: null, total: null, pa: 0, pb: 0, pc: 0, progress: 0,
    eligible: false, status: 'PENDIENTE DE CONFIRMACIÓN',
    pending: [
      'Académico: pendiente de confirmar la libreta PDF.',
      'Desempeño: pendiente de confirmar la libreta PDF antes del registro manual.',
      'Compromiso: pendiente de confirmar la libreta PDF antes del registro manual.',
    ],
  };
  const attendance = draft.attendance;
  const required = attendance.required !== null && attendance.exempted !== null ? attendance.required - attendance.exempted : null;
  const academicAreas = settings.areas.filter(area => area.eligible);
  const bimestres = ACTIVE_BIMESTERS;
  const cohort = normalizeCohort(draft.grade, draft.section);
  const reviewReport = () => void navigate(onReview ?? onBack);

  const academicArea = (next: Student, areaId: string): AcademicArea => {
    let found = next.academic.find(area => area.areaId === areaId);
    if (!found) {
      const definition = settings.areas.find(area => area.id === areaId)!;
      found = { areaId, grades: definition.competencies.map(() => ['', '', '']), validated: false };
      next.academic.push(found);
    }
    return found;
  };

  const gradeChange = (areaId: string, competency: number, bimestre: number, value: Grade) => {
    if (!reportApproved) return;
    change(next => {
      const area = academicArea(next, areaId);
      if (!area.grades[competency]) area.grades[competency] = ['', '', ''];
      area.grades[competency][bimestre] = value;
      area.validated = false;
      next.validated.academic = false;
    });
  };

  const pasteGrades = (event: ClipboardEvent, areaId: string, startRow: number, startCol: number) => {
    if (readOnly || !reportApproved) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text)) return;
    event.preventDefault();
    const rows = text.trim().split(/\r?\n/).map(line => line.split('\t').map(value => value.trim().toUpperCase()));
    const definition = settings.areas.find(area => area.id === areaId)!;
    let applied = 0;
    let ignored = 0;
    change(next => {
      const area = academicArea(next, areaId);
      rows.forEach((row, rowOffset) => row.forEach((value, colOffset) => {
        const rowIndex = startRow + rowOffset;
        const colIndex = startCol + colOffset;
        if (rowIndex >= definition.competencies.length || colIndex >= ACTIVE_BIMESTERS.length) { ignored += 1; return; }
        if (!['', 'AD', 'A', 'B', 'C'].includes(value)) { ignored += 1; return; }
        if (!area.grades[rowIndex]) area.grades[rowIndex] = ['', '', ''];
        area.grades[rowIndex][colIndex] = value as Grade;
        applied += 1;
      }));
      area.validated = false;
      next.validated.academic = false;
    });
    setPasteNotice(`${applied} casillas pegadas.${ignored ? ` Se omitieron ${ignored} valores fuera de la tabla o no reconocidos.` : ''} Revisa y confirma el área.`);
  };

  const commitmentChange = (kind: 'institutional' | 'family', id: string, patch: Partial<Commitment>, invalidate = true) => change(next => {
    const record = next[kind].find(item => item.id === id)!;
    Object.assign(record, patch);
    if (invalidate) record.validated = false;
    next.validated.commitment = false;
  });

  const renderRecords = (kind: 'institutional' | 'family') => {
    const family = kind === 'family';
    const records = draft[kind];
    const types = family ? settings.familyTypes : settings.activityTypes;
    const addRecord = (missed = false) => change(next => {
      next[kind].push({ ...emptyRecord(), status: missed ? 'missed' : 'pending' });
      next.validated.commitment = false;
    });
    return <section className="card detail-records">
      <div className="section-heading">
        <div><span className="eyebrow">{family ? 'CF · FAMILIA' : 'PI · ESTUDIANTE'}</span><h3>{family ? 'Compromiso familiar' : 'Participación institucional'}</h3><p className="muted">{family ? 'Registra manualmente reuniones, citaciones y acuerdos formalizados.' : 'Registra manualmente actividades, competencias y compromisos aplicables al estudiante.'}</p></div>
        <div className="button-row"><button type="button" className="button secondary" disabled={readOnly} onClick={() => addRecord()}><Plus size={16} /> Agregar</button><button type="button" className="button secondary" disabled={readOnly} onClick={() => addRecord(true)}>Registrar incumplimiento</button></div>
      </div>
      {records.length === 0 && <div className="empty-state detail-empty"><Users size={24} /><p>No hay {family ? 'compromisos familiares' : 'participaciones institucionales'} registrados.</p><small>Completa cada registro manualmente. Si no corresponde, registra y justifica “No aplica”.</small><button className="button ghost" disabled={readOnly} onClick={() => change(next => { next[kind].push({ ...emptyRecord(), status: 'na' }); next.validated.commitment = false; })}>Registrar “No aplica”</button></div>}
      {records.map((record, index) => {
        const observationRequired = record.status === 'missed' || record.status === 'justified' || record.status === 'na' || !record.required;
        return <div className="commitment-card" key={record.id}>
          <div className="detail-record-header"><strong>{String(index + 1).padStart(2, '0')} · {record.name || 'Nuevo registro'}</strong><span className={`badge ${record.validated ? 'success' : 'warning'}`}>{record.validated ? 'Validado' : 'Por revisar'}</span><button className="icon-button danger" aria-label={`Eliminar ${record.name || 'registro'}`} disabled={readOnly || Boolean(record.catalogId)} onClick={() => { if (window.confirm(`¿Eliminar el registro “${record.name || 'sin nombre'}”? Se conservará el cambio en el historial.`)) change(next => { next[kind] = next[kind].filter(item => item.id !== record.id); next.validated.commitment = false; }); }}><Trash2 size={15} /></button></div>
          <div className="form-grid"><label className="field"><span>{family ? 'Actividad o compromiso' : 'Actividad, competencia o compromiso'}</span><input list={`${kind}-types`} value={record.name} disabled={readOnly || Boolean(record.catalogId)} onChange={e => commitmentChange(kind, record.id, { name: e.target.value })} /></label><label className="field"><span>Fecha</span><input type="date" value={record.date} disabled={readOnly || Boolean(record.catalogId)} onChange={e => commitmentChange(kind, record.id, { date: e.target.value })} /></label></div>
          {!family && <><label className="field"><span>Ubicación / puesto del estudiante</span><input value={record.placement ?? ''} disabled={readOnly} onChange={e => commitmentChange(kind, record.id, { placement: e.target.value })} /></label><label className="checkbox-label"><input type="checkbox" checked={record.representingSchool ?? false} disabled={readOnly} onChange={e => commitmentChange(kind, record.id, { representingSchool: e.target.checked })} /> Participó representando al colegio</label></>}
          <label className="checkbox-label"><input type="checkbox" checked={record.required} disabled={readOnly || Boolean(record.catalogId)} onChange={e => commitmentChange(kind, record.id, { required: e.target.checked })} /> Exigible para este estudiante</label>
          {record.catalogId && <p className="muted"><Info size={14} /> Registro conservado de una convocatoria anterior.</p>}
          <div className="detail-status-options" role="group" aria-label={`Estado de ${record.name || 'nuevo registro'}`}>{([['fulfilled', 'Cumplió'], ['missed', 'No cumplió'], ['justified', 'Justificada'], ['na', 'No aplica']] as const).map(([value, label]) => <button key={value} type="button" className={`button ${record.status === value ? 'primary' : 'secondary'} ${value}`} aria-pressed={record.status === value} disabled={readOnly} onClick={() => commitmentChange(kind, record.id, { status: value })}>{record.status === value && <Check size={14} />}{label}</button>)}</div>
          {record.status === 'missed' && <p className="muted">Incumplimiento registrado. Completa la observación y la evidencia antes de validarlo.</p>}
          <div className="form-grid"><label className="field"><span>{observationRequired ? 'Justificación / observación · requerida para validar' : 'Justificación / observación'}</span><textarea rows={2} value={record.justification} disabled={readOnly} onChange={e => commitmentChange(kind, record.id, { justification: e.target.value })} /></label><label className="field"><span>Evidencia documental · requerida para validar</span><textarea rows={2} value={record.evidence} disabled={readOnly} onChange={e => commitmentChange(kind, record.id, { evidence: e.target.value })} /></label></div>
          <label className="checkbox-label"><input type="checkbox" checked={record.validated} disabled={readOnly || !record.name.trim() || !record.date || !record.evidence.trim() || record.status === 'pending' || (observationRequired && !record.justification.trim())} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next[kind].find(item => item.id === record.id)!.validated = checked; next.validated.commitment = false; }); }} /><ShieldCheck size={16} /> He revisado y confirmo este registro</label>
        </div>;
      })}
      <datalist id={`${kind}-types`}>{types.map(type => <option key={type} value={type} />)}</datalist>
    </section>;
  };

  return <div className="student-detail">
    <div className="detail-topline"><button className="button ghost" onClick={() => void navigate(onBack)}><ArrowLeft size={17} /> Estudiantes</button><div className={`detail-save-state ${status}`} role="status">{status === 'saving' ? <LoaderCircle size={15} className="spin" /> : status === 'saved' ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}{status === 'saved' ? 'Todos los cambios guardados' : status === 'saving' ? 'Guardando cambios…' : status === 'pending' ? 'Cambios por guardar…' : 'Error al guardar'}{status === 'error' && <button className="button ghost" onClick={() => void flush()}>Reintentar</button>}</div></div>
    <div className="detail-heading"><div className="detail-student-avatar">{draft.name.split(' ').filter(Boolean).slice(0, 2).map(n => n[0]).join('') || 'AE'}</div><div><div className="eyebrow">FICHA DE EVALUACIÓN · {settings.year}</div><h1>{draft.name || 'Nuevo estudiante'}</h1><div className="detail-student-meta"><span>{draft.code || 'Sin código'}</span><span>{draft.grade || 'Sin grado'} · Sección {draft.section || '—'}</span><span className={`badge ${result.eligible ? 'success' : 'warning'}`}>{result.status}</span></div></div><button className="button secondary detail-next" onClick={() => void navigate(onNext)}>Siguiente estudiante <ArrowRight size={16} /></button></div>
    {readOnly && <div className="alert"><ShieldCheck size={18} /><span>La evaluación está cerrada. Puedes consultar los datos y los documentos; para corregirlos, reabre la evaluación desde Parámetros.</span></div>}
    {saveError && <div className="alert error" role="alert"><Info size={18} /><span>{saveError}</span></div>}
    <button className="button ghost detail-profile-toggle" onClick={() => setShowProfile(value => !value)}>Datos del estudiante <ChevronDown size={16} /></button>
    {showProfile && <section className="card"><div className="form-grid"><label className="field"><span>Código de estudiante</span><input value={draft.code} readOnly /></label><label className="field"><span>Nombres y apellidos</span><input value={draft.name} readOnly /></label><label className="field"><span>Aula</span><select value={cohort?.label ?? ''} disabled><option value="">Pendiente de confirmar</option>{ALLOWED_COHORTS.map(item => <option key={item.label} value={item.label}>{item.label}</option>)}</select></label></div><p className="muted">Los datos del estudiante provienen de la libreta PDF confirmada.</p><button className="button ghost" onClick={reviewReport}>Revisar libreta original <ArrowRight size={16} /></button></section>}
    <div className="detail-layout">
      <main className="detail-main">
        {!reportApproved && <section className="card detail-intro" role="status"><span className="eyebrow">CONFIRMACIÓN DE LA LIBRETA</span><h2>Libreta pendiente de confirmación</h2><p className="muted">Revisa y confirma la libreta PDF y los datos del estudiante en Importar libretas para habilitar Académico, Desempeño y Compromiso. Los tres ámbitos permanecen pendientes hasta completar este paso.</p><button type="button" className="button primary" onClick={reviewReport}><FileText size={17} /> Revisar y confirmar libreta <ArrowRight size={16} /></button></section>}
        <nav className="tab-list" aria-label="Secciones de la ficha">{(Object.keys(labels) as Tab[]).map(key => <button key={key} type="button" className={`tab ${tab === key ? 'active' : ''}`} disabled={!reportApproved && key !== 'documents'} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>{key === 'academic' ? <BookOpen size={16} /> : key === 'performance' ? <ShieldCheck size={16} /> : key === 'commitment' ? <Users size={16} /> : <FileText size={16} />}{labels[key]}</button>)}</nav>
        {reportApproved && tab === 'academic' && <div className="detail-tab-content">
          <section className="card detail-intro"><span className="eyebrow">A · RENDIMIENTO ACADÉMICO</span><h2>La trayectoria detrás del puntaje</h2><p className="muted">Libreta escolar {settings.year - 1}. Los puntajes se calculan automáticamente con las notas de los bimestres I, II y III de la libreta confirmada. Corrige o completa las casillas faltantes y contrasta cada área con el documento original.</p><div className="detail-grade-legend"><span>AD <b>4</b></span><span>A <b>3</b></span><span>B <b>2</b></span><span>C <b>1</b></span><small>Una casilla vacía sigue pendiente.</small></div></section>
          {associatedPdfs.length > 0 && <details className="card detail-original-preview"><summary><FileText size={17} /> Contrastar con la libreta original</summary><p className="muted">Mantén abierto el documento mientras revisas y corriges las tablas. Las notas extraídas originalmente permanecen en Documentos e historial.</p>{associatedPdfs.filter(pdf => pdf.status !== 'replaced').map(pdf => <div key={pdf.id}><a className="button ghost" href={documentUrl(pdf.id, dataset)} target="_blank" rel="noreferrer">{pdf.name} · Abrir en otra ventana</a><iframe title={`Libreta original: ${pdf.name}`} src={documentUrl(pdf.id, dataset)} style={{ width: '100%', height: 460, border: '1px solid #e9e2dc', borderRadius: 8 }} /></div>)}</details>}
          {pasteNotice && <div className="alert" role="status"><Info size={17} />{pasteNotice}</div>}
          <p className="muted detail-paste-tip">Puedes copiar filas de tres notas de Excel (I, II y III) y pegarlas sobre la primera casilla de la tabla.</p>
          {academicAreas.map(definition => {
            const area = draft.academic.find(item => item.areaId === definition.id);
            const complete = definition.competencies.length > 0 && definition.competencies.every((_, i) => bimestres.every((_, j) => Boolean(area?.grades[i]?.[j])));
            return <section className="card detail-area" key={definition.id}>
              <div className="section-heading"><div><h3>{definition.name}</h3><span className="muted">{definition.competencies.length} competencias · Promedio I–III: <strong>{fmt(result.areaAverages[definition.id] ?? null)}</strong> / 4</span></div><span className={`badge ${area?.validated ? 'success' : 'warning'}`}>{area?.validated ? 'Área validada' : 'Provisional'}</span></div>
              <div className="table-wrap"><table className="academic-table"><thead><tr><th>Competencia</th>{bimestres.map(b => <th key={b}>{b} bim.</th>)}</tr></thead><tbody>{definition.competencies.map((competency, row) => <tr key={row}><td>{competency}</td>{bimestres.map((b, col) => <td key={b}><select className={`grade-select grade-${area?.grades[row]?.[col] || 'empty'}`} aria-label={`${definition.name}, ${competency}, bimestre ${b}`} disabled={readOnly} value={area?.grades[row]?.[col] || ''} onChange={e => gradeChange(definition.id, row, col, e.target.value as Grade)} onPaste={e => pasteGrades(e, definition.id, row, col)}><option value="">—</option>{(['AD', 'A', 'B', 'C'] as Grade[]).map(grade => <option key={grade} value={grade}>{grade}</option>)}</select></td>)}</tr>)}</tbody></table></div>
              <label className="checkbox-label detail-area-confirm"><input type="checkbox" checked={area?.validated ?? false} disabled={readOnly || !complete} onChange={e => { const checked = e.target.checked; void confirmChange(next => { academicArea(next, definition.id).validated = checked; next.validated.academic = false; }); }} /><CheckCircle2 size={16} /> Confirmo que todas las calificaciones de esta área coinciden con la libreta</label>
            </section>;
          })}
          <section className="card detail-formula"><h3>Fórmula y componentes</h3><div className="detail-metric-grid"><Metric label="General · G" value={result.g} hint={`Peso: ${settings.academicWeights.general * 100} %`} /><Metric label="Ciencias y Letras · R" value={result.r} hint={`Peso: ${settings.academicWeights.specialized * 100} %`} /><Metric label="Progresión · P" value={result.p} hint={`Peso: ${settings.academicWeights.progress * 100} %`} /><Metric label="Ciencias" value={result.science} hint="Índice 1–4 · Matemática + CyT" /><Metric label="Letras" value={result.letters} hint="Índice 1–4 · Comunicación + CCSS + DPCC" /><Metric label="Promedio I–II · S1" value={result.s1} hint={`III · S2: ${fmt(result.s2)} · Índices 1–4`} /></div><p className="formula">G = 25 × promedio de áreas · R = 25 × [{settings.scienceWeight.toFixed(2)} × Ciencias + {(1 - settings.scienceWeight).toFixed(2)} × Letras]</p><p className="formula">P = 25 × mín(4; máx(1; S2 + 0,50 × (S2 − S1))) · S1 = promedio de I y II · S2 = III</p></section>
          <section className="card detail-final-validation"><ShieldCheck size={22} /><div><h3>Validación final académica</h3><p className="muted">El puntaje es definitivo después de confirmar las áreas y esta revisión.</p></div><label className="checkbox-label"><input type="checkbox" checked={draft.validated.academic} disabled={readOnly || !result.academicComplete || !academicAreas.every(def => draft.academic.find(a => a.areaId === def.id)?.validated)} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.validated.academic = checked; }); }} /> Revisado y validado</label></section>
        </div>}
        {reportApproved && tab === 'performance' && <div className="detail-tab-content">
          <section className="card"><div className="section-heading"><div><span className="eyebrow">B · DESEMPEÑO ESTUDIANTIL</span><h2>Asistencia y puntualidad</h2><p className="muted">Los días eximidos se restan de los días lectivos. La puntualidad se calcula sobre los días asistidos.</p></div></div><div className="form-grid detail-attendance-grid">{([['required', 'Días lectivos del periodo'], ['exempted', 'Días formalmente eximidos'], ['attended', 'Días asistidos'], ['punctual', 'Ingresos puntuales']] as const).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="number" inputMode="numeric" min="0" step="1" value={attendance[key] ?? ''} disabled={readOnly} placeholder="Sin datos" onChange={e => change(next => { next.attendance[key] = numberOrNull(e.target.value); next.attendance.validated = false; next.validated.performance = false; })} /></label>)}</div><div className="detail-derived"><span>Días exigibles <strong>{required ?? 'Pendiente'}</strong></span><span>Tardanzas <strong>{attendance.attended !== null && attendance.punctual !== null ? attendance.attended - attendance.punctual : 'Pendiente'}</strong></span></div><div className="detail-metric-grid"><Metric label="Asistencia" value={result.attendance} hint="100 × asistidos / exigibles" /><Metric label="Puntualidad" value={result.punctuality} hint="100 × puntuales / asistidos" /><Metric label="AP" value={result.ap} hint="(Asistencia + Puntualidad) / 2" /></div><label className="checkbox-label"><input type="checkbox" checked={attendance.validated} disabled={readOnly || result.ap === null} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.attendance.validated = checked; next.validated.performance = false; }); }} /><ShieldCheck size={16} /> He contrastado y validado la asistencia</label></section>
          <section className="card"><div className="section-heading"><div><h3>Disciplina</h3><p className="muted">Registra solo incidencias verificadas. Una tardanza no genera un segundo descuento disciplinario.</p></div><button className="button secondary" disabled={readOnly || settings.disciplineTypes.filter(t => !t.punctuality).length === 0} onClick={() => change(next => { next.discipline.incidents.push({ id: uid(), typeId: '', date: '', description: '', measure: '', evidence: '', verified: false }); next.discipline.confirmed = false; next.validated.performance = false; })}><Plus size={16} /> Agregar incidencia</button></div>
            {draft.discipline.incidents.length === 0 ? <div className="detail-no-incidents"><CheckCircle2 size={25} /><div><strong>Sin incidencias registradas</strong><p className="muted">Esto cuenta como “sin datos” hasta confirmar la revisión.</p></div><label className="checkbox-label"><input type="checkbox" checked={draft.discipline.confirmed} disabled={readOnly} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.discipline.confirmed = checked; next.validated.performance = false; }); }} /> Confirmar “Sin incidencias”</label></div> : draft.discipline.incidents.map((incident, index) => {
              const type = settings.disciplineTypes.find(t => t.id === incident.typeId);
              const patch = (values: Partial<typeof incident>) => change(next => { Object.assign(next.discipline.incidents.find(i => i.id === incident.id)!, values); next.discipline.confirmed = false; next.validated.performance = false; });
              return <div className="commitment-card" key={incident.id}><div className="detail-record-header"><strong>Incidencia {index + 1}</strong><span className="badge">{type?.punctuality ? 'Sin descuento duplicado' : type?.discount == null ? 'Descuento sin aprobar' : `Descuento: ${type.discount} puntos`}</span><button className="icon-button danger" disabled={readOnly} aria-label={`Eliminar incidencia ${index + 1}`} onClick={() => { if (window.confirm('¿Eliminar esta incidencia? El cambio se conservará en el historial.')) change(next => { next.discipline.incidents = next.discipline.incidents.filter(i => i.id !== incident.id); next.discipline.confirmed = false; next.validated.performance = false; }); }}><Trash2 size={15} /></button></div><div className="form-grid"><label className="field"><span>Categoría</span><select value={incident.typeId} disabled={readOnly} onChange={e => patch({ typeId: e.target.value, verified: false })}><option value="">Seleccionar categoría</option>{settings.disciplineTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="field"><span>Fecha</span><input type="date" value={incident.date} disabled={readOnly} onChange={e => patch({ date: e.target.value, verified: false })} /></label><label className="field"><span>Descripción de la incidencia</span><textarea value={incident.description} rows={2} disabled={readOnly} onChange={e => patch({ description: e.target.value, verified: false })} /></label><label className="field"><span>Medida aplicada</span><textarea value={incident.measure} rows={2} disabled={readOnly} placeholder="Medida según el Reglamento Interno" onChange={e => patch({ measure: e.target.value, verified: false })} /></label><label className="field"><span>Evidencia o referencia documental</span><textarea value={incident.evidence} rows={2} disabled={readOnly} onChange={e => patch({ evidence: e.target.value, verified: false })} /></label></div><label className="checkbox-label"><input type="checkbox" checked={incident.verified} disabled={readOnly || !incident.typeId || !incident.date || !incident.description.trim() || !incident.measure.trim() || !incident.evidence.trim()} onChange={e => patch({ verified: e.target.checked })} /> Incidencia y evidencia verificadas</label></div>;
            })}
            {draft.discipline.incidents.length > 0 && <label className="checkbox-label"><input type="checkbox" checked={draft.discipline.confirmed} disabled={readOnly || draft.discipline.incidents.some(i => !i.verified)} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.discipline.confirmed = checked; next.validated.performance = false; }); }} /> Confirmo que el registro disciplinario está completo</label>}
          </section>
          <section className="card detail-formula"><h3>Resultado de desempeño</h3><div className="detail-metric-grid"><Metric label="Asistencia y puntualidad · AP" value={result.ap} hint={`Peso: ${settings.performanceWeights.attendance * 100} %`} /><Metric label="Disciplina · D" value={result.discipline} hint={`Peso: ${settings.performanceWeights.discipline * 100} %`} /><Metric label="Desempeño · B" value={result.b} hint="Puntaje sobre 100" /></div><p className="formula">B = {settings.performanceWeights.attendance.toFixed(2)} × AP + {settings.performanceWeights.discipline.toFixed(2)} × D · D = máx(0; 100 − descuentos verificados)</p></section>
          <section className="card detail-final-validation"><ShieldCheck size={22} /><div><h3>Validación final de desempeño</h3><p className="muted">Requiere asistencia revisada y disciplina confirmada.</p></div><label className="checkbox-label"><input type="checkbox" checked={draft.validated.performance} disabled={readOnly || !result.performanceComplete || !draft.attendance.validated || !draft.discipline.confirmed} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.validated.performance = checked; }); }} /> Revisado y validado</label></section>
        </div>}
        {reportApproved && tab === 'commitment' && <div className="detail-tab-content"><section className="card detail-intro"><span className="eyebrow">C · COMPROMISO INSTITUCIONAL Y FAMILIAR</span><h2>La participación también cuenta</h2><p className="muted">Completa manualmente las participaciones y los compromisos. Para registrar un incumplimiento, añade su observación y evidencia. Los registros justificados y no exigibles no se consideran incumplimientos.</p><div className="detail-metric-grid"><Metric label="Participación institucional · PI" value={result.participation} na={result.participationNA} hint={`Peso: ${settings.commitmentWeights.participation * 100} %`} /><Metric label="Compromiso familiar · CF" value={result.family} na={result.familyNA} hint={`Peso: ${settings.commitmentWeights.family * 100} %`} /><Metric label="Compromiso · C" value={result.c} hint="Puntaje sobre 100" /></div></section>{renderRecords('institutional')}{renderRecords('family')}<section className="card detail-formula"><h3>Regla de cálculo</h3><p className="formula">C = {settings.commitmentWeights.participation.toFixed(2)} × PI + {settings.commitmentWeights.family.toFixed(2)} × CF</p><p className="muted">PI / CF = 100 × obligaciones cumplidas / obligaciones exigibles. Sin obligaciones exigibles: “No aplica”, sujeto a la regla común aprobada para la cohorte.</p><p className="muted">Regla actual de “No aplica”: <strong>{settings.naPolicy === 'other_component' ? 'Usar el otro subcomponente cuando solo uno no aplica' : 'Mantener resultado pendiente'}</strong>{settings.naPolicyApproved ? ' · Confirmada institucionalmente' : ' · Pendiente de confirmación institucional'}.</p></section><section className="card detail-final-validation"><ShieldCheck size={22} /><div><h3>Validación final de compromiso</h3><p className="muted">Confirma ambos registros y las justificaciones aplicables.</p></div><label className="checkbox-label"><input type="checkbox" checked={draft.validated.commitment} disabled={readOnly || !result.commitmentComplete || [...draft.institutional, ...draft.family].some(record => !record.validated)} onChange={e => { const checked = e.target.checked; void confirmChange(next => { next.validated.commitment = checked; }); }} /> Revisado y validado</label></section></div>}
        {tab === 'documents' && <div className="detail-tab-content"><section className="card"><div className="section-heading"><div><span className="eyebrow">DOCUMENTOS ORIGINALES</span><h2>Libretas y trazabilidad</h2><p className="muted">La lectura original se conserva aunque corrijas las notas de la ficha.</p></div></div>{associatedPdfs.length === 0 ? <div className="empty-state"><FileText size={28} /><p>Aún no hay PDF vinculados a este estudiante.</p><small>Vincula una libreta desde Importación masiva.</small></div> : associatedPdfs.map(pdf => <div className="detail-pdf" key={pdf.id}><FileText size={22} /><div><strong>{pdf.name}</strong><small>{new Date(pdf.uploadedAt).toLocaleString('es-PE')} · {pdf.ocr ? 'Lectura OCR' : 'Lectura de texto'} · {pdf.period || 'Periodo por revisar'}</small><span className={`badge ${pdf.status === 'validated' ? 'success' : 'warning'}`}>{pdf.status === 'validated' ? 'Lectura confirmada' : pdf.status === 'replaced' ? 'Versión reemplazada' : 'Pendiente de revisión'}</span></div><a className="button secondary" href={documentUrl(pdf.id, dataset)} target="_blank" rel="noreferrer">Ver original <ArrowRight size={15} /></a><details><summary>Ver extracción original y observaciones</summary>{pdf.warnings.length > 0 && <ul>{pdf.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}<pre className="detail-extracted-text">{pdf.text || 'No se reconoció texto en este documento.'}</pre></details></div>)}</section><section className="card"><div className="section-heading"><div><span className="eyebrow">AUDITORÍA</span><h3>Historial de ajustes</h3><p className="muted">Cada cambio queda registrado con su valor anterior y posterior.</p></div><History size={22} /></div>{draft.history.length === 0 ? <p className="muted">Todavía no hay modificaciones registradas.</p> : <div className="history-list">{[...draft.history].reverse().map(entry => <details className="detail-history-item" key={entry.id}><summary><strong>{entry.field}</strong><time>{new Date(entry.date).toLocaleString('es-PE')}</time></summary><div className="form-grid"><div><span className="eyebrow">ANTES</span><pre>{entry.before || 'Sin valor'}</pre></div><div><span className="eyebrow">DESPUÉS</span><pre>{entry.after || 'Sin valor'}</pre></div></div></details>)}</div>}</section></div>}
      </main>
      <aside className="detail-sidebar"><section className="card detail-results"><div className="eyebrow">RESULTADOS EN VIVO</div><h3>Una mirada integral</h3><div className="detail-score-row"><span><b className="dimension-letter a">A</b> Académico</span><strong>{fmt(result.a)}</strong></div><div className="detail-score-row"><span><b className="dimension-letter b">B</b> Desempeño</span><strong>{fmt(result.b)}</strong></div><div className="detail-score-row"><span><b className="dimension-letter c">C</b> Compromiso</span><strong>{fmt(result.c)}</strong></div><div className="detail-total"><span>Promedio general</span><strong>{fmt(result.total)}</strong><small>(A + B + C) ÷ 3</small><span className={`badge ${result.eligible ? 'success' : 'warning'}`}>{!reportApproved ? 'Pendiente de confirmación' : result.eligible ? 'Validado para ranking' : 'Resultado provisional'}</span></div><p className="muted detail-score-note">Cada ámbito tiene el mismo peso: ⅓. Ningún dato faltante se reemplaza por cero.</p></section><section className="card"><span className="eyebrow">AVANCE DEL EXPEDIENTE</span><MiniProgress label="Académico · PA" value={result.pa} className="academic" /><MiniProgress label="Desempeño · PB" value={result.pb} className="performance" /><MiniProgress label="Compromiso · PC" value={result.pc} className="commitment" /><MiniProgress label="Avance total" value={result.progress} className="total" /><p className="muted detail-score-note">Mide completitud del expediente, no rendimiento.</p></section><section className="card detail-pending"><h3>{result.pending.length ? 'Por completar' : 'Revisión completada'}</h3>{result.pending.length ? <ul>{result.pending.map((pending, i) => <li key={i}><Clock3 size={14} /><span>{pending}</span></li>)}</ul> : <p className="muted"><CheckCircle2 size={16} /> Los registros están completos y revisados.</p>}</section><button className="button primary detail-save-button" disabled={readOnly || !reportApproved || status === 'saving' || status === 'saved'} onClick={() => void flush()}><Save size={17} />{status === 'saving' ? 'Guardando…' : 'Guardar ahora'}</button></aside>
    </div>
  </div>;
}
