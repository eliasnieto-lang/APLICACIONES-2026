import { useEffect, useRef, useState } from 'react';
import type { AppState, Dataset, Settings, Student } from '../shared/types';
import { calculateStudent, fmt, rankStudents, getDimensionWeights } from '../shared/calculations';
import { normalizeCohort } from '../shared/policy';
import StudentDetail from './StudentDetail';
import schoolLogo from './assets/colegio-albert-einstein.png?inline';
import { isBrowserEdition } from './runtime';
import ImportPage from './ImportPage';
import SettingsPage from './SettingsPage';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, ClipboardCheck, CloudUpload, DatabaseBackup, FileCheck2, FileText, GraduationCap, LayoutDashboard, ListFilter, Loader2, Menu, MoreHorizontal, Plus, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Trophy, Trash2, Users, X, AlertCircle } from 'lucide-react';

const classroomDescription = '1.º a 5.º de secundaria, en sus distintas secciones';
const circleLabel = (student: Student) => student.circleStatus === 'remains' ? 'Permanece' : student.circleStatus === 'does_not_remain' ? 'No permanece' : 'Pendiente';

type Page = 'dashboard' | 'students' | 'import' | 'ranking' | 'settings';
type DeleteConfirmation =
  | { kind: 'student'; dataset: Dataset; student: Student }
  | { kind: 'evaluation'; dataset: Dataset; students: number; pdfs: number };
const datasetLabel = (dataset: Dataset) => dataset === 'real' ? 'Datos reales' : 'Demostración · datos ficticios';
const navigation = [
  { id: 'dashboard', label: 'Panel principal', icon: LayoutDashboard },
  { id: 'import', label: 'Importar libretas', icon: CloudUpload },
  { id: 'students', label: 'Estudiantes', icon: Users },
  { id: 'ranking', label: 'Ranking y resultados', icon: Trophy },
  { id: 'settings', label: 'Parámetros', icon: Settings2 },
] as const;
const score = (v: number | null) => v === null ? '—' : fmt(v);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => n[0]).join('').toUpperCase();

function Progress({ value, tone = '' }: { value: number; tone?: string }) {
  return <div className={`progress-track ${tone}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${Math.min(100, value)}%` }} /></div>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [dataset, setDataset] = useState<Dataset>('real');
  const activeDataset = useRef(dataset);
  activeDataset.current = dataset;
  const [page, setPage] = useState<Page>('dashboard');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [grade, setGrade] = useState('');
  const [section, setSection] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [preparingCleanup, setPreparingCleanup] = useState(false);
  const deletionInFlight = useRef(false);
  // Ignore responses that began before a deletion or a change of workspace.
  const stateGeneration = useRef(0);
  const deletePreparation = useRef(0);
  const pendingStudentSaves = useRef(new Map<Dataset, Set<Promise<boolean>>>());
  const finishStudentConfirmation = useRef<(() => void) | null>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const [restore, setRestore] = useState<File | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const notify = (message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 5000); };
  const url = (path: string, requestDataset = dataset) => `/api${path}${path.includes('?') ? '&' : '?'}dataset=${requestDataset}`;
  async function request<T>(path: string, options?: RequestInit, requestDataset = dataset): Promise<T> {
    const r = await fetch(url(path, requestDataset), options);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `No se pudo completar la operación (${r.status})`); }
    return r.json();
  }
  async function refresh() { const generation = stateGeneration.current; const s = await request<AppState>('/state'); if (activeDataset.current === dataset && stateGeneration.current === generation) { setState(s); setError(''); } }
  useEffect(() => { let active = true; const generation = stateGeneration.current; setState(null); setSelected(null); setQuery(''); setGrade(''); setSection(''); setStatusFilter(''); fetch(`/api/state?dataset=${dataset}`).then(async r => { if (!r.ok) throw new Error('No se pudo conectar con el servidor.'); return r.json(); }).then(s => { if (active && generation === stateGeneration.current) { setState(s); setError(''); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [dataset]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (!deleteConfirmation) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    deleteDialog.current?.querySelector<HTMLButtonElement>('[data-delete-cancel]')?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [deleteConfirmation]);
  function navigate(next: Page) { deletePreparation.current += 1; setPreparingCleanup(false); setPage(next); setSelected(null); setSidebar(false); setQuery(''); }
  function openStudent(id: string) { deletePreparation.current += 1; setPreparingCleanup(false); setSelected(id); setPage('students'); }
  async function saveStudent(student: Student) { const generation = stateGeneration.current; const saved = await request<Student>(`/students/${student.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(student) }); if (activeDataset.current === dataset && stateGeneration.current === generation) setState(s => activeDataset.current === dataset && stateGeneration.current === generation && s ? { ...s, students: s.students.map(x => x.id === saved.id ? saved : x) } : s); return saved; }
  function trackStudentSave(operation: Promise<boolean>) {
    const pending = pendingStudentSaves.current.get(dataset) ?? new Set<Promise<boolean>>();
    pendingStudentSaves.current.set(dataset, pending); pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  }
  function closeDeleteConfirmation() {
    if (deletionInFlight.current) return;
    setDeleteConfirmation(null); setDeleteText(''); setDeleteError('');
    finishStudentConfirmation.current?.(); finishStudentConfirmation.current = null;
  }
  function switchDataset(next: Dataset) {
    if (deletionInFlight.current) return;
    closeDeleteConfirmation(); deletePreparation.current += 1; setPreparingCleanup(false); stateGeneration.current += 1; activeDataset.current = next;
    setState(null); setSelected(null); setError(''); setDataset(next); setPage('dashboard');
  }
  async function requestStudentDelete(student: Student) {
    if (busy || deletionInFlight.current || activeDataset.current !== dataset) return;
    deletePreparation.current += 1; setPreparingCleanup(false);
    setDeleteText(''); setDeleteError(''); setDeleteConfirmation({ kind: 'student', dataset, student });
    await new Promise<void>(resolve => { finishStudentConfirmation.current = resolve; });
  }
  async function requestEvaluationDelete() {
    if (busy || deletionInFlight.current || preparingCleanup || deleteConfirmation) return;
    const generation = stateGeneration.current;
    const preparation = ++deletePreparation.current;
    setPreparingCleanup(true);
    try {
      const pending = pendingStudentSaves.current.get(dataset);
      while (pending?.size) {
        const results = await Promise.all([...pending]);
        if (results.some(saved => !saved)) throw new Error('No se pudieron guardar los cambios pendientes. Vuelve a la ficha y reintenta antes de limpiar la evaluación.');
      }
      if (deletePreparation.current !== preparation || activeDataset.current !== dataset || stateGeneration.current !== generation) return;
      const current = await request<AppState>('/state');
      if (deletePreparation.current !== preparation || activeDataset.current !== dataset || stateGeneration.current !== generation) return;
      setState(current); setDeleteText(''); setDeleteError('');
      setDeleteConfirmation({ kind: 'evaluation', dataset, students: current.students.length, pdfs: current.pdfs.length });
    } catch (e) { if (deletePreparation.current === preparation && activeDataset.current === dataset && stateGeneration.current === generation) notify((e as Error).message); }
    finally { if (deletePreparation.current === preparation) setPreparingCleanup(false); }
  }
  async function confirmDeletion() {
    const confirmation = deleteConfirmation;
    if (!confirmation || busy || deletionInFlight.current || activeDataset.current !== confirmation.dataset || (confirmation.kind === 'evaluation' && deleteText !== 'ELIMINAR TODO')) return;
    deletionInFlight.current = true; setDeleting(true); setDeleteError('');
    const generation = ++stateGeneration.current;
    try {
      const path = confirmation.kind === 'student' ? `/students/${encodeURIComponent(confirmation.student.id)}` : '/evaluation';
      const body = confirmation.kind === 'student'
        ? { confirmation: confirmation.student.name, allowClosed: true, expectedUpdatedAt: confirmation.student.updatedAt }
        : { confirmation: 'ELIMINAR TODO', allowClosed: true, expectedCounts: { students: confirmation.students, pdfs: confirmation.pdfs } };
      const result = await request<{ deletedPdfIds?: string[] }>(path, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, confirmation.dataset);
      if (activeDataset.current === confirmation.dataset && stateGeneration.current === generation) {
        setSelected(null); setPage('dashboard'); setQuery(''); setGrade(''); setSection(''); setStatusFilter('');
        setState(current => !current ? current : confirmation.kind === 'evaluation'
          ? { ...current, students: [], pdfs: [], settings: { ...current.settings, closed: false } }
          : { ...current, students: current.students.filter(student => student.id !== confirmation.student.id), pdfs: current.pdfs.filter(pdf => !result.deletedPdfIds?.includes(pdf.id) && pdf.studentId !== confirmation.student.id) });
        try {
          const current = await request<AppState>('/state', undefined, confirmation.dataset);
          if (activeDataset.current === confirmation.dataset && stateGeneration.current === generation) { setState(current); setError(''); }
        } catch (e) { setError((e as Error).message); }
        notify(confirmation.kind === 'student' ? 'Estudiante, evaluaciones y libretas eliminados.' : 'Datos de evaluación eliminados. El espacio está listo para un nuevo proceso.');
      }
      setDeleteConfirmation(null); setDeleteText('');
      finishStudentConfirmation.current?.(); finishStudentConfirmation.current = null;
    } catch (e) { setDeleteError((e as Error).message); }
    finally { deletionInFlight.current = false; setDeleting(false); }
  }
  async function rescanStudentReport(student: Student) {
    const generation = stateGeneration.current;
    const operation = (async () => {
      const reports = state?.pdfs.filter(pdf => pdf.studentId === student.id && !['duplicate', 'replaced', 'failed'].includes(pdf.status)) || [];
      const source = reports.find(pdf => pdf.id === student.reportApproval?.pdfId) || reports.at(-1);
      if (!source) throw new Error('No está disponible la libreta original para escanear las notas.');
      await request(`/pdfs/${source.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rescan-grades' }) });
      if (activeDataset.current !== dataset || stateGeneration.current !== generation) return;
      await refresh();
      if (activeDataset.current === dataset && stateGeneration.current === generation) notify('Escaneo terminado. Las notas reconocidas se actualizaron automáticamente.');
    })();
    trackStudentSave(operation.then(() => true, () => false));
    await operation;
  }
  async function saveSettings(settings: Settings, confirmReopen = false) { await request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, confirmReopen }) }); await refresh(); notify('Parámetros guardados.'); }
  async function download(path: string, fallback: string, requestDataset = dataset) { if (busy || deletionInFlight.current) return; setBusy(true); try { const r = await fetch(url(path, requestDataset)); if (!r.ok) { const e = await r.json(); throw new Error(e.error); } const blob = await r.blob(); const href = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = href; a.download = r.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1] || fallback; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1500); notify('Archivo generado y descargado.'); } catch (e) { notify((e as Error).message); } finally { setBusy(false); } }
  const exportRanking = () => download(`/export?grade=${encodeURIComponent(grade)}&section=${encodeURIComponent(section)}`, `Ranking_Circulos_2027_${dataset}.xlsx`);
  const enabledStudents = state?.students.filter(student => normalizeCohort(student.grade, student.section)) || [];
  const overallWeights = getDimensionWeights(state?.settings);
  const overallFormula = `${fmt(overallWeights.academic * 100)} % A + ${fmt(overallWeights.performance * 100)} % B + ${fmt(overallWeights.commitment * 100)} % C`;
  const classrooms = [...new Map(enabledStudents.map(student => { const cohort = normalizeCohort(student.grade, student.section)!; return [cohort.label, cohort] as const; })).values()].sort((a, b) => a.label.localeCompare(b.label, 'es', { numeric: true }));
  const evaluated = enabledStudents.map(student => ({ student, result: calculateStudent(student, state!.settings) }));
  const filtered = evaluated.filter(({ student, result }) => student.name.toLowerCase().includes(query.toLowerCase()) && (!grade || student.grade === grade) && (!section || student.section === section) && (!statusFilter || (statusFilter === 'valid' ? result.eligible : !result.eligible)));
  const validated = evaluated.filter(x => x.result.eligible).length;
  const avg = (key: 'a' | 'b' | 'c' | 'total') => { const values = evaluated.map(x => x.result[key]).filter((v): v is number => v !== null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
  const avgProgress = evaluated.length ? evaluated.reduce((a, x) => a + x.result.progress, 0) / evaluated.length : 0;
  const currentStudent = enabledStudents.find(s => s.id === selected);
  const ranking = state ? rankStudents(enabledStudents.filter(s => (!grade || s.grade === grade) && (!section || s.section === section)), state.settings) : [];
  const title = navigation.find(n => n.id === page)?.label;

  function Filters() { return <div className="filters"><div className="search-input"><Search size={17} /><input aria-label="Buscar estudiante" placeholder="Buscar por apellidos y nombres..." value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Filtrar por aula" value={grade && section ? normalizeCohort(grade, section)?.label ?? '' : ''} onChange={e => { const cohort = classrooms.find(item => item.label === e.target.value); setGrade(cohort?.grade ?? ''); setSection(cohort?.section ?? ''); }}><option value="">Todas las aulas</option>{classrooms.map(cohort => <option key={cohort.label} value={cohort.label}>{cohort.label}</option>)}</select>{page === 'students' && <select aria-label="Filtrar por estado" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">Todos los estados</option><option value="valid">Validados</option><option value="pending">Pendientes</option></select>}</div>; }

  function StudentsTable({ compact = false }: { compact?: boolean }) { const rows = compact ? filtered.slice(0, 5) : filtered; return <div className="table-wrap"><table className="student-table"><thead><tr><th>ESTUDIANTE</th><th>GRADO</th><th><span className="dimension-dot academic" /> ACADÉMICO</th><th><span className="dimension-dot performance" /> DESEMPEÑO</th><th><span className="dimension-dot commitment" /> COMPROMISO</th><th>PROMEDIO</th><th>AVANCE</th><th>ESTADO</th><th>PERMANENCIA</th><th /></tr></thead><tbody>{rows.map(({ student, result: r }, i) => <tr key={student.id} onClick={() => openStudent(student.id)}><td><button className="student-name-button" onClick={e => { e.stopPropagation(); openStudent(student.id); }}><span className={`avatar avatar-${i % 4}`}>{initials(student.name)}</span><span><strong>{student.name}</strong></span></button></td><td>{student.grade}<small className="muted block">Sección {student.section}</small></td><td className="score-number">{score(r.a)}</td><td className="score-number">{score(r.b)}</td><td className="score-number">{r.commitmentExcluded ? <span className="badge neutral">No incluido</span> : score(r.c)}</td><td><span className={`total-score ${r.total === null ? 'pending' : ''}`}>{r.total === null ? 'Pendiente' : fmt(r.total)}</span><small className="muted block">{r.commitmentExcluded ? 'Académico + Desempeño' : 'A + B + C ponderados'}</small></td><td><div className="table-progress"><span>{Math.round(r.progress)} %</span><Progress value={r.progress} tone={r.eligible ? 'green' : ''} />{!compact && <div className="mini-dimensions" title={`PA: ${Math.round(r.pa)}% · PB: ${Math.round(r.pb)}% · PC: ${Math.round(r.pc)}%`}>A {Math.round(r.pa)} · B {Math.round(r.pb)}{!r.commitmentExcluded && <> · C {Math.round(r.pc)}</>}</div>}</div></td><td><span className={`badge ${r.eligible ? 'success' : r.progress === 0 ? 'neutral' : 'warning'}`}><span className="status-dot" />{r.eligible ? 'Validado' : r.status}</span></td><td><span className="badge neutral">{circleLabel(student)}</span></td><td><ChevronRight size={16} className="muted" /></td></tr>)}</tbody></table>{!rows.length && <div className="empty-state"><GraduationCap size={36} /><h3>{evaluated.length ? 'No encontramos coincidencias' : 'Un nuevo ciclo empieza aquí'}</h3><p>{evaluated.length ? 'Prueba con otro nombre o filtro.' : `Importa las libretas PDF de ${classroomDescription}. Los apellidos y nombres del archivo formarán la lista automáticamente.`}</p>{!evaluated.length && <div className="button-row"><button className="button primary" onClick={() => navigate('import')}><CloudUpload size={17} /> Importar libretas</button></div>}</div>}</div>; }

  return <div className="app-shell">
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('dashboard'); }}><img src={schoolLogo} alt="Colegio Albert Einstein, Huaraz" /></a>
      <div className="workspace-label">GESTIÓN ACADÉMICA <span>2027</span></div>
      <nav aria-label="Navegación principal">{navigation.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'import' && state?.pdfs.some(p => p.status === 'review') && <span className="nav-count">{state.pdfs.filter(p => p.status === 'review').length}</span>}</button>)}</nav>
      <div className="sidebar-note"><div className="note-icon"><ShieldCheck size={22} /></div><strong>Una evaluación integral</strong><p>Tres dimensiones. Una mirada completa de cada estudiante.</p><button onClick={() => navigate('settings')}>Ver criterios de evaluación <ArrowUpRight size={14} /></button></div>
      <div className="sidebar-footer"><span className="school-mark">AE</span><div><strong>Colegio Albert Einstein</strong><small>Huaraz · Círculos de Estudios</small></div></div>
    </aside>
    {sidebar && <div className="sidebar-scrim" onClick={() => setSidebar(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Abrir menú" onClick={() => setSidebar(true)}><Menu size={22} /></button><span>Círculos de Estudios</span><ChevronRight size={13} /><strong>{currentStudent ? 'Ficha del estudiante' : title}</strong></div><div className="topbar-actions"><span className="cycle-tag"><span className="status-dot" /> Proceso {state?.settings.year || 2027}</span><button className={`dataset-button ${dataset === 'demo' ? 'is-demo' : ''}`} disabled={deleting} onClick={() => switchDataset(dataset === 'real' ? 'demo' : 'real')}><Sparkles size={15} />{dataset === 'demo' ? 'Demo · datos ficticios' : 'Explorar demostración'}<ChevronDown size={13} /></button><div className="topbar-divider" /><button className="icon-button" title="Descargar copia de seguridad" aria-label="Descargar copia de seguridad" onClick={() => download('/backup', `Respaldo_Circulos_${dataset}.json`)} disabled={!state || busy || deleting}><DatabaseBackup size={20} /></button><button className="icon-button" title="Restaurar copia de seguridad" aria-label="Restaurar copia de seguridad" onClick={() => restoreInput.current?.click()} disabled={!state || busy || deleting}><RotateCcw size={19} /></button><input type="file" hidden accept=".json,application/json" ref={restoreInput} onChange={e => { setRestore(e.target.files?.[0] || null); e.target.value = ''; }} /><span className="operator-avatar">AE</span></div></header>
      <main className="main-content">
        {isBrowserEdition() && <div className="notice"><DatabaseBackup size={18} /><span><strong>Versión web · datos guardados en este navegador.</strong> Conserva copias de seguridad para trasladar o recuperar tus registros. No se envían los PDF ni los datos a un servidor.</span></div>}
        {dataset === 'demo' && <div className="demo-banner"><Sparkles size={16} /><span><strong>Espacio de demostración.</strong> Estos datos son ficticios y están separados de tus registros reales.</span><button disabled={deleting} onClick={() => switchDataset('real')}>Ir a datos reales <ArrowRight size={14} /></button></div>}
        {state?.settings.closed && <div className="notice warning"><ShieldCheck size={18} />Evaluación cerrada. Los registros están protegidos. Puedes reabrirla desde Parámetros.</div>}
        {error && <div className="notice danger"><AlertCircle size={18} />{error}<button className="button secondary" onClick={() => refresh().catch(e => setError(e.message))}>Reintentar</button></div>}
        {!state && !error && <div className="loading-screen"><Loader2 className="spin" size={28} /><p>Preparando tu espacio de evaluación…</p></div>}
        {state && currentStudent ? <StudentDetail key={`${dataset}:${currentStudent.id}`} student={currentStudent} settings={state.settings} pdfs={state.pdfs.filter(p => p.studentId === currentStudent.id)} onSave={saveStudent} onSaving={trackStudentSave} onRequestDelete={requestStudentDelete} deleteDisabled={busy || deleting} onBack={() => setSelected(null)} onReview={() => navigate('import')} onRescan={() => rescanStudentReport(currentStudent)} readOnly={state.settings.closed} onNext={() => { const index = enabledStudents.findIndex(s => s.id === selected); setSelected(enabledStudents[(index + 1) % enabledStudents.length]?.id || null); }} dataset={dataset} /> : state && <>
          {page === 'dashboard' && <>
            <div className="page-heading"><div><div className="eyebrow">PERMANENCIA · CÍRCULOS DE ESTUDIOS</div><h1>Una mirada integral al talento<span className="red-period">.</span></h1><p>Todo lo que necesitas para acompañar y evaluar a tus estudiantes.</p></div><button className="button secondary" onClick={() => navigate('import')} disabled={state.settings.closed}><CloudUpload size={17} /> Importar libretas</button></div>
            <section className="hero-banner"><div className="hero-copy"><span className="hero-kicker"><span /> EVALUACIÓN {state.settings.year}</span><h2>Cada trayectoria cuenta.</h2><p>Académico con mayor peso.<br />Desempeño y compromiso según cada estudiante.</p><button className="button hero-button" onClick={() => navigate('import')}><CloudUpload size={17} /> Importar libretas PDF <ArrowRight size={16} /></button></div><div className="hero-art" aria-hidden="true"><div className="hero-orbit orbit-1" /><div className="hero-orbit orbit-2" /><div className="hero-orbit orbit-3" /><div className="orbit-node node-1"><BookOpen size={22} /></div><div className="orbit-node node-2"><ClipboardCheck size={22} /></div><div className="orbit-node node-3"><Users size={22} /></div><div className="hero-core"><GraduationCap size={49} strokeWidth={1.25} /><span>CÍRCULOS</span><strong>2027</strong></div><div className="floating-label label-one"><Check size={13} /> Una sola evaluación</div><div className="floating-label label-two">A <span>con mayor peso</span></div></div></section>
            <div className="stats-grid">{[{ label: 'Estudiantes registrados', value: enabledStudents.length, desc: 'Una base, tres dimensiones', icon: Users, color: 'red' }, { label: 'Libretas importadas', value: state.pdfs.filter(p => p.status !== 'duplicate').length, desc: `${state.pdfs.filter(p => p.status === 'review').length} por revisar`, icon: FileText, color: 'blue' }, { label: 'Expedientes validados', value: validated, desc: 'Listos para el ranking', icon: FileCheck2, color: 'green' }, { label: 'Evaluaciones pendientes', value: enabledStudents.length - validated, desc: 'Requieren completar o revisar', icon: ClipboardCheck, color: 'gold' }].map(m => <article className="stat-card" key={m.label}><div className="stat-heading"><span>{m.label}</span><div className={`stat-icon ${m.color}`}><m.icon size={20} /></div></div><strong className="stat-value">{m.value.toString().padStart(2, '0')}</strong><p>{m.desc}</p></article>)}</div>
            <div className="dashboard-grid"><section className="card dimension-card"><div className="card-header"><div><h2>Tres dimensiones, una evaluación</h2><p>Promedios de puntajes disponibles · escala de 0 a 100</p></div><span className="badge neutral">MAYOR PESO ACADÉMICO</span></div><div className="dimension-cards">{[{ key: 'a' as const, letter: 'A', title: 'Rendimiento académico', desc: 'Aprendizajes y progresión', color: 'academic', icon: BookOpen }, { key: 'b' as const, letter: 'B', title: 'Desempeño estudiantil', desc: 'Asistencia y disciplina', color: 'performance', icon: ClipboardCheck }, { key: 'c' as const, letter: 'C', title: 'Compromiso integral', desc: 'Participación y familia', color: 'commitment', icon: Users }].map(d => <div className={`dimension-summary ${d.color}`} key={d.key}><div className="dimension-top"><span className="dimension-letter">{d.letter}</span><d.icon size={21} /></div><strong>{score(avg(d.key))}<small>/ 100</small></strong><h3>{d.title}</h3><p>{d.desc}</p><div className="dimension-meter"><span style={{ width: `${avg(d.key) || 0}%` }} /></div><span className="weight-label">{fmt(overallWeights[d.key === 'a' ? 'academic' : d.key === 'b' ? 'performance' : 'commitment'] * 100)} % del promedio general</span></div>)}</div><div className="arithmetic-note"><span><span className="formula-icon">ƒ</span> Promedio ponderado = {overallFormula}</span><strong>{score(avg('total'))}<small> / 100</small></strong></div></section><section className="card completion-card"><div className="card-header"><div><h2>Avance de evaluación</h2><p>Completitud de expedientes</p></div><CircleHelp size={17} className="muted" /></div><div className="donut"><svg viewBox="0 0 140 140"><circle cx="70" cy="70" r="57" fill="none" stroke="#f0edeb" strokeWidth="10" /><circle cx="70" cy="70" r="57" fill="none" stroke="#ac253b" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${avgProgress * 3.5814} 358.14`} transform="rotate(-90 70 70)" /></svg><div><strong>{Math.round(avgProgress)}<small>%</small></strong><span>avance promedio</span></div></div><div className="completion-legend"><span><i className="legend-dot green" /> Validados <strong>{validated}</strong></span><span><i className="legend-dot gold" /> Pendientes <strong>{enabledStudents.length - validated}</strong></span></div><p className="completion-footnote">El avance mide registros completados, no el rendimiento del estudiante.</p></section></div>
            <section className="card"><div className="card-header"><div><h2>Estudiantes y progreso <span className="count-tag">{enabledStudents.length}</span></h2><p>Revisa los puntajes y completa cada expediente.</p></div><button className="text-button" onClick={() => navigate('students')}>Ver todos <ArrowRight size={15} /></button></div><StudentsTable compact /></section>
            <section className="ranking-callout"><span className="ranking-callout-icon"><Trophy size={25} /></span><div><h3>Resultados claros. Decisiones informadas.</h3><p>Descarga el ranking, el detalle de cálculo y los pendientes en un solo Excel.</p></div><button className="button primary" disabled={busy} onClick={exportRanking}><ArrowDownToLine size={17} />Generar ranking consolidado</button></section>
            <section className="card cleanup-card"><div><span className="eyebrow">CIERRE Y NUEVO PROCESO</span><h2>Limpiar evaluación</h2><p>Elimina los registros de prueba o los datos al terminar el proceso. Se conservan el año, los criterios y los parámetros para empezar otra evaluación.</p><div className="cleanup-summary"><span className="delete-space">{datasetLabel(dataset)}</span><span>{state.students.length} estudiantes · {state.pdfs.length} PDF en total</span></div><p className="muted">Incluye todas las aulas, versiones anteriores, duplicados y PDF sin vincular de este espacio.</p></div><button type="button" className="button danger" disabled={busy || deleting || preparingCleanup || (!state.students.length && !state.pdfs.length && !state.settings.closed)} onClick={() => void requestEvaluationDelete()}>{preparingCleanup ? <Loader2 size={17} className="spin" /> : <Trash2 size={17} />}{preparingCleanup ? 'Preparando limpieza…' : 'Eliminar todos los datos de evaluación'}</button></section>
          </>}
          {page === 'students' && <><div className="page-heading"><div><div className="eyebrow">EXPEDIENTES DE EVALUACIÓN</div><h1>Cada estudiante, una trayectoria.</h1><p>Lista generada desde las libretas de {classroomDescription}. Confirma cada libreta para abrir sus tres dimensiones.</p></div><button className="button primary" onClick={() => navigate('import')} disabled={state.settings.closed}><CloudUpload size={17} /> Importar libretas</button></div><section className="card"><div className="card-header"><h2>Estudiantes <span className="count-tag">{filtered.length}</span></h2><button className="text-button" onClick={() => navigate('import')}><CloudUpload size={16} /> Importar registros</button></div>{Filters()}<StudentsTable /></section><p className="page-footnote"><ShieldCheck size={15} /> Los cambios se guardan automáticamente. Un expediente al 100 % aún requiere la validación final de cada dimensión incluida.</p></>}
          {page === 'import' && <ImportPage key={dataset} pdfs={state.pdfs} students={enabledStudents} settings={state.settings} dataset={dataset} onRefresh={refresh} onOpenStudent={openStudent} notify={notify} />}
          {page === 'ranking' && <><div className="page-heading"><div><div className="eyebrow">RESULTADOS PARA REVISIÓN INSTITUCIONAL</div><h1>El resultado de una mirada completa.</h1><p>Solo se clasifican expedientes completos, revisados y válidos.</p></div><button className="button primary" disabled={busy} onClick={exportRanking}><ArrowDownToLine size={17} /> Generar ranking consolidado</button></div>{!state.settings.criteriaApproved && <div className="notice warning"><AlertCircle size={19} /><div><strong>Los criterios institucionales están pendientes de aprobación.</strong><p>Confirma los parámetros antes de emitir resultados definitivos. El Excel incluirá los expedientes en PENDIENTES.</p></div><button className="button secondary" onClick={() => navigate('settings')}>Revisar parámetros</button></div>}<div className="ranking-summary"><div><span className="stat-icon gold"><Trophy size={21} /></span><span><strong>{ranking.length}</strong> estudiantes en ranking</span></div><div><span className="stat-icon green"><CheckCheck size={21} /></span><span>Dimensiones aplicables validadas</span></div><div><span className="formula-icon">ƒ</span><span>Promedio ponderado · prioridad académica</span></div></div><section className="card"><div className="card-header"><div><h2>Ranking consolidado</h2><p>Listados y posiciones por aula · los empates comparten posición. La columna Dimensiones identifica si se incluye Compromiso.</p></div><span className="badge neutral">{state.settings.year}</span></div>{Filters()}<div className="table-wrap"><table><thead><tr><th>PUESTO</th><th>ESTUDIANTE</th><th>COHORTE</th><th>ACADÉMICO A</th><th>DESEMPEÑO B</th><th>COMPROMISO C</th><th>PROMEDIO</th><th>DIMENSIONES</th><th>PERMANENCIA</th><th>ESTADO</th></tr></thead><tbody>{ranking.filter(x => x.student.name.toLowerCase().includes(query.toLowerCase())).map(({ student, result, position }) => <tr key={student.id} onClick={() => openStudent(student.id)}><td><span className={`rank-position rank-${position}`}>{position < 4 ? <Trophy size={15} /> : null}{position.toString().padStart(2, '0')}</span></td><td><button className="student-name-button" onClick={() => openStudent(student.id)}><span><strong>{student.name}</strong></span></button></td><td>{student.grade} · {student.section}</td><td>{score(result.a)}</td><td>{score(result.b)}</td><td>{result.commitmentExcluded ? 'No incluido' : score(result.c)}</td><td><span className="total-score">{score(result.total)}</span></td><td>{result.commitmentExcluded ? 'A + B' : 'A + B + C'}</td><td>{circleLabel(student)}</td><td><span className="badge success"><Check size={12} /> Validado</span></td></tr>)}</tbody></table>{!ranking.length && <div className="empty-state"><Trophy size={38} /><h3>Los resultados están en camino</h3><p>Completa y valida las dimensiones incluidas para cada estudiante y confirma los criterios institucionales para generar el ranking.</p><button className="button secondary" onClick={() => navigate('students')}>Revisar expedientes <ArrowRight size={15} /></button></div>}</div></section><div className="export-description"><FileText size={20} /><div><strong>Un Excel. Toda la información.</strong><p>RANKING · DETALLE · PENDIENTES · CONFIGURACIÓN</p></div></div><section className="card"><div className="card-header"><div><h2>Expedientes pendientes</h2><p>Se exportan en una hoja separada y no participan en la clasificación.</p></div><span className="count-tag">{filtered.filter(x => !x.result.eligible).length}</span></div><div className="pending-list">{filtered.filter(x => !x.result.eligible).map(({ student, result }) => <button key={student.id} onClick={() => openStudent(student.id)}><span className="avatar">{initials(student.name)}</span><div><strong>{student.name}</strong><p>{result.pending.slice(0, 3).join(' · ') || 'Confirmación final pendiente'}</p></div><span>{Math.round(result.progress)} %</span><ChevronRight size={16} /></button>)}{!filtered.some(x => !x.result.eligible) && <p className="muted padded">No hay expedientes pendientes en esta selección.</p>}</div></section></>}
          {page === 'settings' && <SettingsPage settings={state.settings} studentCount={enabledStudents.length} onSave={saveSettings} notify={notify} />}
        </>}
        <footer className="main-footer"><span>Colegio Albert Einstein <span>·</span> Círculos de Estudios {state?.settings.year || 2027}</span><span>Evaluar para acompañar.</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><Check size={18} /><span>{toast}</span><button onClick={() => setToast('')} aria-label="Cerrar notificación"><X size={16} /></button></div>}
    {deleteConfirmation && <div className="modal-backdrop"><div className="modal modal-danger" ref={deleteDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" onKeyDown={e => {
      if (e.key === 'Escape' && !busy && !deleting) closeDeleteConfirmation();
      if (e.key !== 'Tab') return;
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href]')];
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { e.preventDefault(); e.currentTarget.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }}><button type="button" className="modal-close icon-button" onClick={closeDeleteConfirmation} disabled={busy || deleting} aria-label="Cerrar confirmación"><X size={20} /></button><span className="modal-illustration"><Trash2 size={28} /></span><h2 id="delete-title">{deleteConfirmation.kind === 'student' ? 'Eliminar estudiante' : 'Eliminar todos los datos de evaluación'}</h2><div className="delete-space">{datasetLabel(deleteConfirmation.dataset)}</div>{deleteConfirmation.kind === 'student' ? <><div className="delete-summary"><strong>{deleteConfirmation.student.name}</strong><span>{deleteConfirmation.student.grade} · Sección {deleteConfirmation.student.section}</span></div><p id="delete-description">Se eliminarán de forma permanente su ficha, las evaluaciones de las tres dimensiones, el historial y todas sus libretas PDF, incluidas las versiones anteriores y los duplicados asociados. Esta acción no se puede deshacer.</p></> : <><div className="delete-summary"><strong>{deleteConfirmation.students} estudiantes · {deleteConfirmation.pdfs} PDF</strong><span>Todos los registros del espacio seleccionado</span></div><p id="delete-description">Se eliminarán permanentemente todos los estudiantes, sus evaluaciones e historiales y todos los PDF de este espacio, incluidos los duplicados, las versiones anteriores y los documentos sin vincular. Se conservan el año, los criterios y los parámetros; la evaluación quedará abierta para iniciar un nuevo proceso. Esta acción no se puede deshacer.</p><label className="field delete-confirmation-input"><span>Escribe ELIMINAR TODO para confirmar</span><input value={deleteText} onChange={e => setDeleteText(e.target.value)} disabled={busy || deleting} autoComplete="off" spellCheck={false} /></label></>}{deleteError && <p className="alert error delete-error" role="alert">{deleteError}</p>}<button type="button" className="button ghost" disabled={busy || deleting} onClick={() => void download('/backup', `Respaldo_Circulos_${deleteConfirmation.dataset}.json`, deleteConfirmation.dataset)}><DatabaseBackup size={16} />{busy ? 'Descargando respaldo…' : 'Descargar respaldo'}</button><div className="modal-actions delete-actions"><button type="button" className="button secondary" data-delete-cancel disabled={busy || deleting} onClick={closeDeleteConfirmation}>Cancelar</button><button type="button" className="button danger" disabled={busy || deleting || (deleteConfirmation.kind === 'evaluation' && deleteText !== 'ELIMINAR TODO')} onClick={() => void confirmDeletion()}>{deleting ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}{deleting ? 'Eliminando…' : deleteConfirmation.kind === 'student' ? 'Eliminar estudiante' : 'Eliminar todos los datos de evaluación'}</button></div></div></div>}
    {restore && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title"><button className="modal-close icon-button" onClick={() => setRestore(null)} aria-label="Cancelar"><X size={20} /></button><span className="modal-illustration"><RotateCcw size={28} /></span><h2 id="restore-title">Restaurar copia de seguridad</h2><p>El archivo <strong>{restore.name}</strong> reemplazará los datos del espacio <strong>{dataset === 'real' ? 'real' : 'de demostración'}</strong>. Descarga un respaldo actual antes de continuar.</p><div className="button-row"><button className="button secondary" onClick={() => download('/backup', 'Respaldo_actual.json')}><DatabaseBackup size={16} />Respaldar actual</button><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); try { const body = await restore.text(); await request('/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); await refresh(); setRestore(null); setSelected(null); notify('Copia de seguridad restaurada correctamente.'); } catch (e) { notify((e as Error).message); } finally { setBusy(false); } }}>Restaurar datos</button></div></div></div>}
  </div>;
}
