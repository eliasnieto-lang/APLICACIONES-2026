import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, ClipboardCheck, LayoutDashboard, Settings2, Monitor, Users, FileDown, LogOut, ArrowRight, ArrowLeft, ShieldCheck, RefreshCw, Menu, X, GraduationCap } from 'lucide-react';
import type { Area, Block, Dataset, Snapshot, Teacher, ViewProps } from '../shared/types';
import { AREAS, BLOCKS } from '../shared/domain';
import { presentationPublisherAvailable, presentationScore } from '../shared/presentation';
import { ApiError, createApi, signOut, type Config } from './client';
import { activeEntry, lastTeacherProfile, ownTeacherCode, rememberActiveEntry, rememberTeacherCode, takeAccessFragment } from './entry-session';

const Preparation = lazy(() => import('./views/PresentationPreparation'));
const Evaluations = lazy(() => import('./views/PresentationEvaluations'));
const Consolidation = lazy(() => import('./views/PresentationConsolidation'));
const LiveRoom = lazy(() => import('./views/LiveRoom'));
const Voting = lazy(() => import('./views/Voting'));
const PublicView = lazy(() => import('./views/PublicView'));
const Ballot = lazy(() => import('./views/Ballot'));
const Reports = lazy(() => import('./views/Reports'));
type Page = 'home' | 'prepare' | 'live' | 'evaluations' | 'shortlists' | 'voting' | 'reports';
type Mode = 'login' | 'private' | 'public' | 'ballot';
type EntryResult = { code: string; snapshot: Snapshot };

function rememberTeacherSnapshot(dataset: Dataset, code: string, snapshot: Snapshot) {
  if (snapshot.actor.role !== 'teacher') return;
  const teacher = snapshot.state.teachers.find(item => item.id === snapshot.actor.id);
  if (teacher?.lastNames && teacher.firstNames && teacher.area && teacher.categories?.length) {
    rememberTeacherCode(dataset, teacher.lastNames, teacher.firstNames, code, { area: teacher.area, categories: teacher.categories });
  }
}

class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <div className="notice danger" role="alert">No se pudo mostrar esta pantalla. Recarga la página para continuar; los datos confirmados siguen guardados en el servidor.<button onClick={() => location.reload()}>Recargar</button></div> : this.props.children;
  }
}

function teacherCoverage(snapshot: Snapshot, teacher: Teacher) {
  const s = snapshot.state;
  const units = new Set((teacher.categories || []).flatMap(block => s.publishers.filter(publisher => teacher.area && presentationPublisherAvailable(s, publisher.id, teacher.area, block)).map(publisher => `${publisher.id}:${teacher.area}:${block}`)));
  const closed = new Set(s.presentationEvaluations.filter(evaluation => evaluation.teacherId === teacher.id && evaluation.status === 'closed' && presentationScore(evaluation) !== null && units.has(`${evaluation.publisherId}:${evaluation.area}:${evaluation.block}`)).map(evaluation => `${evaluation.publisherId}:${evaluation.area}:${evaluation.block}`)).size;
  return { expected: units.size, closed, pending: Math.max(0, units.size - closed) };
}

function Home({ snapshot, go }: { snapshot: Snapshot; go: (page: Page) => void }) {
  const s = snapshot.state;
  const teachers = s.teachers.filter(teacher => teacher.area && teacher.categories?.length);
  const coverage = teachers.map(teacher => ({ teacher, ...teacherCoverage(snapshot, teacher) }));
  const closed = coverage.reduce((total, item) => total + item.closed, 0);
  const pending = coverage.reduce((total, item) => total + item.pending, 0);
  return <div className="stack roomy">
    <header className="page-heading"><span className="eyebrow">JORNADA 2027 · HUARAZ</span><h1>Elegir con evidencia.<br /><span>Decidir en comunidad.</span></h1><p>Escucha cada exposición, revisa el ejemplar físico y registra tu valoración.</p></header>
    <div className="hero"><div><span className="eyebrow">SELECCIÓN DE TEXTOS ESCOLARES</span><h2>Una decisión para todo el año.</h2><p>Matemática y Comunicación · Primaria y secundaria</p><button className="light" onClick={() => go(snapshot.actor.role === 'teacher' ? 'evaluations' : 'prepare')}>{snapshot.actor.role === 'teacher' ? 'Abrir mis evaluaciones' : 'Preparar la jornada'}<ArrowRight size={17} /></button></div><div className="hero-mark" aria-hidden="true"><BookOpen size={58} /><span>2027</span></div></div>
    <div className="stats-grid"><div className="stat"><span>Docentes registrados</span><strong>{teachers.length}</strong></div><div className="stat"><span>Fichas cerradas</span><strong>{closed}</strong></div><div className="stat"><span>Fichas pendientes</span><strong>{pending}</strong></div><div className="stat"><span>Ternas publicadas</span><strong>{s.presentationShortlists.filter(shortlist => shortlist.status === 'published').length}</strong></div></div>
    <section><div className="section-title"><h2>Recorrido de la jornada</h2><span className="muted">Una ficha por editorial, área y bloque</span></div><div className="step-grid">{[
      { n: '01', title: 'Preparar jornada', text: 'Editoriales, catálogo y organización de la jornada.', page: 'prepare', icon: Settings2 },
      { n: '02', title: 'Abrir sala', text: 'Exposiciones con un reloj común y revisión de ejemplares.', page: 'live', icon: Monitor },
      { n: '03', title: 'Evaluar las exposiciones', text: 'Valoración independiente por editorial, área y bloque.', page: 'evaluations', icon: ClipboardCheck },
      { n: '04', title: 'Revisar el consolidado', text: 'Promedios, participación docente y ternas por categoría.', page: 'shortlists', icon: BookOpen },
      { n: '05', title: 'Elección de familias', text: 'Revisión física, padrón y voto por grado y área.', page: 'voting', icon: Users },
      { n: '06', title: 'Cerrar y respaldar', text: 'Actas, fichas imprimibles y copia de seguridad.', page: 'reports', icon: FileDown },
    ].filter(item => snapshot.actor.role === 'coordinator' || snapshot.actor.role === 'teacher' && item.page === 'evaluations' || snapshot.actor.role === 'secretary' && ['prepare', 'live', 'voting', 'reports'].includes(item.page)).map(item => <button className="step-card" key={item.n} onClick={() => go(item.page as Page)}><div><span className="step-number">{item.n}</span><item.icon size={23} /></div><h3>{item.title}</h3><p>{item.text}</p><ArrowRight size={18} /></button>)}</div></section>
    {snapshot.actor.role === 'coordinator' && <div className="card"><h3>Participación de docentes evaluadores</h3>{coverage.length === 0 ? <p className="muted">Los docentes se registran con sus apellidos, nombres, área y bloques. Pueden participar todos los evaluadores de cada categoría.</p> : <div className="table-wrap"><table><thead><tr><th>Docente</th><th>Área y bloques</th><th>Fichas previstas</th><th>Cerradas</th><th>Pendientes</th></tr></thead><tbody>{coverage.map(({ teacher, expected, closed: done, pending: remaining }) => <tr key={teacher.id}><td>{teacher.name}</td><td>{AREAS.find(area => area.id === teacher.area)?.label}<br /><span className="muted">{teacher.categories?.join(' · ')}</span></td><td>{expected}</td><td>{done}</td><td>{remaining}</td></tr>)}</tbody></table></div>}</div>}
  </div>;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [dataset, setDataset] = useState<Dataset>(params.get('datos') === 'demo' ? 'demo' : 'real');
  const [mode, setMode] = useState<Mode>(params.get('vista') === 'publica' ? 'public' : params.get('vista') === 'voto' ? 'ballot' : 'login');
  const [loginType, setLoginType] = useState<'teacher' | 'director' | null>(null);
  const [lastNames, setLastNames] = useState('');
  const [firstNames, setFirstNames] = useState('');
  const [area, setArea] = useState<Area | ''>('');
  const [categories, setCategories] = useState<Block[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [credential, setCredential] = useState<{ code?: string }>(() => {
    const invitation = takeAccessFragment();
    if (invitation) rememberActiveEntry(dataset, { code: invitation });
    return {};
  });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [publicData, setPublicData] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [mobile, setMobile] = useState(false);
  const notify = useCallback((text: string, error = false) => setMessage({ text, error }), []);
  useEffect(() => {
    const profile = lastTeacherProfile(dataset);
    setLastNames(profile?.lastNames || ''); setFirstNames(profile?.firstNames || ''); setArea(profile?.area || ''); setCategories(profile?.categories || []);
  }, [dataset]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), 8000); return () => clearTimeout(timer); }, [message]);
  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' }).then(response => { if (!response.ok) throw Error(); return response.json(); }).then(value => {
      if (!['cloud', 'local'].includes(value.mode) || value.mode === 'cloud' && (!value.url || !value.publishableKey)) throw Error();
      setConfig(value);
    }).catch(() => setConfigError('No se pudo cargar la configuración de Selección de textos. Recarga la página o revisa config.json.'));
  }, []);
  const api = useMemo(() => config ? createApi(config, dataset, credential) : null, [config, dataset, credential]);
  const publicApi = useMemo(() => config ? createApi(config, dataset) : null, [config, dataset]);
  const refresh = useCallback(async () => { if (api) setSnapshot(await api.call<Snapshot>('snapshot')); }, [api]);
  const refreshPublic = useCallback(async () => { if (publicApi) setPublicData(await publicApi.call<Snapshot>('public_snapshot')); }, [publicApi]);
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const saved = activeEntry(dataset);
    if (!saved || params.get('vista') === 'publica' || params.get('vista') === 'voto') { setRestoring(false); return; }
    setRestoring(true);
    void createApi(config, dataset, saved).call<Snapshot>('snapshot').then(data => {
      if (cancelled) return;
      rememberTeacherSnapshot(dataset, saved.code, data);
      setCredential(saved); setSnapshot(data);
      const teacher = data.state.teachers.find(item => item.id === data.actor.id);
      if (data.actor.role === 'teacher' && (!teacher?.firstNames || !teacher.lastNames || !teacher.area || !teacher.categories?.length)) {
        setMode('login'); setLoginType('teacher');
        setFirstNames(teacher?.firstNames || ''); setLastNames(teacher?.lastNames || '');
        setArea(teacher?.area || ''); setCategories(teacher?.categories || []);
      } else {
        setMode('private'); setPage(data.actor.role === 'teacher' ? 'evaluations' : 'home');
      }
    }).catch(reason => {
      if (cancelled) return;
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) rememberActiveEntry(dataset, null);
      setError(reason instanceof Error ? reason.message : 'No se pudo recuperar el acceso.');
    }).finally(() => { if (!cancelled) setRestoring(false); });
    return () => { cancelled = true; };
  }, [config, dataset, params]);
  useEffect(() => {
    if (mode !== 'public' || !publicApi) return;
    void refreshPublic().catch(reason => setError(reason.message));
    const timer = setInterval(() => void refreshPublic().catch(reason => setError(reason.message)), 10000);
    return () => clearInterval(timer);
  }, [mode, publicApi, refreshPublic]);
  useEffect(() => {
    if (mode !== 'private' || snapshot?.actor.role !== 'coordinator' || !['home', 'prepare', 'live', 'shortlists'].includes(page)) return;
    void refresh().catch(reason => notify(reason.message, true));
    const timer = setInterval(() => void refresh().catch(() => undefined), 10000);
    return () => clearInterval(timer);
  }, [mode, page, snapshot?.actor.role, refresh, notify]);
  const enter = (result: EntryResult) => {
    if (!result.code || !result.snapshot?.actor) throw Error('El servidor no pudo confirmar el acceso. Inténtalo de nuevo.');
    const next = { code: result.code };
    rememberTeacherSnapshot(dataset, result.code, result.snapshot);
    rememberActiveEntry(dataset, next); setCredential(next); setSnapshot(result.snapshot); setMode('private');
    setPage(result.snapshot.actor.role === 'teacher' ? 'evaluations' : 'home');
  };
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!config || !loginType) return;
    if (loginType === 'teacher' && !categories.length) { setError('Selecciona al menos una categoría para evaluar.'); return; }
    setBusy(true); setError('');
    try {
      if (loginType === 'teacher') {
        const legacyTeacher = snapshot?.actor.role === 'teacher' ? snapshot.state.teachers.find(item => item.id === snapshot.actor.id) : undefined;
        const resumeCode = ownTeacherCode(dataset, lastNames, firstNames) || (legacyTeacher && !legacyTeacher.selfRegistered ? credential.code : undefined);
        const result = await createApi(config, dataset, { code: resumeCode }).call<EntryResult>('teacher_register', { lastNames: lastNames.trim(), firstNames: firstNames.trim(), area, categories });
        enter(result); rememberTeacherCode(dataset, lastNames, firstNames, result.code, { area: area as Area, categories });
      } else {
        const result = await createApi(config, dataset).call<EntryResult>('director_login', { password });
        enter(result);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo entrar.'); }
    finally { setBusy(false); setPassword(''); }
  };
  const logout = async () => {
    rememberActiveEntry(dataset, null); setMode('login'); setSnapshot(null); setCredential({}); setLoginType(null); setCode(''); setPassword(''); setError('');
    if (config) await signOut(config);
  };
  const chooseRole = (role: 'teacher' | 'director') => { setLoginType(role); setPassword(''); setError(''); };
  if (configError) return <main className="boot"><h1>Selección de textos escolares 2027</h1><p role="alert">{configError}</p><button onClick={() => location.reload()}>Recargar</button></main>;
  if (!config || restoring && mode === 'login') return <main className="boot"><BookOpen size={36} /><p>Cargando Selección de textos escolares 2027…</p></main>;
  if (mode === 'public') return <Boundary><Suspense fallback={<div className="boot">Cargando sala pública…</div>}><div className="public-top"><a href="/">Acceso del equipo</a><span>{dataset === 'demo' ? 'DEMOSTRACIÓN · DATOS FICTICIOS' : 'SELECCIÓN DE TEXTOS 2027'}</span></div>{error && <p className="notice danger" role="alert">{error}</p>}{publicData ? <PublicView data={publicData} refresh={refreshPublic} /> : <div className="boot">Esperando información del servidor…</div>}</Suspense></Boundary>;
  if (mode === 'ballot' && api && credential.code) return <Boundary><Suspense fallback={<div className="boot">Cargando cédula…</div>}><Ballot api={api} onExit={() => { setCredential({}); setCode(''); setMode('login'); }} /></Suspense></Boundary>;
  if (mode !== 'private' || !snapshot || !api) return <main className="login-shell">
    <section className="login-story"><img src="/colegio-albert-einstein.png" alt="Colegio Albert Einstein" /><div><span className="eyebrow">I.E.P. ALBERT EINSTEIN · HUARAZ</span><h1>Textos que acompañan.<br />Decisiones que cuentan.</h1><p>Selección de textos escolares 2027</p><div className="story-line" /><p className="story-detail">Evaluación pedagógica independiente.<br />Exposición editorial y revisión del libro físico.</p></div><span className="small">Matemática y Comunicación · Primaria y secundaria</span></section>
    <section className="login-panel"><div className="login-card"><div className="brand-mobile"><img src="/colegio-albert-einstein.png" alt="Colegio Albert Einstein" /></div><span className="eyebrow">SELECCIÓN DE TEXTOS ESCOLARES 2027</span>
      <h2>{mode === 'ballot' ? 'Voto digital anónimo' : loginType === 'teacher' ? 'Registro del docente evaluador' : loginType === 'director' ? 'Acceso del subdirector' : 'Bienvenido a la jornada'}</h2>
      <p className="muted">{mode === 'ballot' ? 'Usa la ficha anónima que te entregó la mesa.' : loginType === 'teacher' ? 'Ingresa tus datos y selecciona los bloques que evaluarás.' : loginType === 'director' ? 'Ingresa tu contraseña para administrar la jornada.' : 'Elige tu función para continuar.'}</p>
      <label className="field workspace-field">Espacio de trabajo<select value={dataset} disabled={busy} onChange={event => { setDataset(event.target.value as Dataset); setPassword(''); setError(''); }}><option value="real">Jornada real</option><option value="demo">Demostración · datos ficticios</option></select></label>
      {dataset === 'demo' && <div className="notice workspace-notice">Este espacio es de prueba. No registra evaluaciones de la jornada real.</div>}
      {mode !== 'ballot' && !loginType ? <div className="entry-options"><button className="primary role-entry" aria-label="INGRESAR COMO DOCENTE EVALUADOR" onClick={() => chooseRole('teacher')}><GraduationCap size={30} aria-hidden="true" /><span>INGRESAR COMO DOCENTE EVALUADOR<small>Registra tus datos y empieza a evaluar</small></span><ArrowRight size={21} aria-hidden="true" /></button><button className="primary role-entry" aria-label="INGRESAR COMO SUBDIRECTOR" onClick={() => chooseRole('director')}><ShieldCheck size={29} aria-hidden="true" /><span>INGRESAR COMO SUBDIRECTOR<small>Administra la jornada y revisa los resultados</small></span><ArrowRight size={21} aria-hidden="true" /></button></div> : <>
        {mode !== 'ballot' && <button className="link entry-back" disabled={busy} onClick={() => { setLoginType(null); setPassword(''); setError(''); }}><ArrowLeft size={15} />Cambiar función</button>}
        <form onSubmit={mode === 'ballot' ? async event => {
          event.preventDefault(); setError(''); setBusy(true);
          try { const next = { code: code.trim() }; await createApi(config, dataset, next).call('vote_preview'); setCredential(next); }
          catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
        } : login} className="stack entry-form">
          {mode === 'ballot' ? <label className="field">Código de la ficha de voto<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} required /></label> : loginType === 'director' ? <label className="field">Contraseña del subdirector<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required autoFocus /></label> : <>
            <div className="field-row teacher-names"><label className="field">Apellidos<input autoComplete="family-name" value={lastNames} onChange={event => setLastNames(event.target.value)} maxLength={120} required autoFocus /></label><label className="field">Nombres<input autoComplete="given-name" value={firstNames} onChange={event => setFirstNames(event.target.value)} maxLength={120} required /></label></div>
            <fieldset className="entry-fieldset"><legend>Área que evaluarás</legend><div className="entry-area-options">{AREAS.map(item => <label className={`entry-choice ${area === item.id ? 'checked' : ''}`} key={item.id}><input type="radio" name="teacher-area" value={item.id} checked={area === item.id} onChange={() => setArea(item.id)} required /><span>{item.label}</span></label>)}</div></fieldset>
            <fieldset className="entry-fieldset" aria-describedby="blocks-help"><legend>Categorías que evaluarás</legend><p className="muted small" id="blocks-help">Selecciona una o más categorías.</p><div className="entry-block-options">{BLOCKS.map(item => <label className={`entry-choice ${categories.includes(item.id) ? 'checked' : ''}`} key={item.id}><input type="checkbox" checked={categories.includes(item.id)} onChange={event => { setError(''); setCategories(current => event.target.checked ? [...current, item.id] : current.filter(block => block !== item.id)); }} /><span>{item.label}</span></label>)}</div></fieldset>
            <p className="entry-help">No necesitas contraseña. Tu acceso personal se conserva en este navegador para retomar tus fichas.</p>
          </>}
          {error && <div className="notice danger" role="alert">{error}</div>}
          <button type="submit" disabled={busy} className="primary full">{busy ? 'Verificando acceso…' : mode === 'ballot' ? 'Abrir mi cédula' : loginType === 'teacher' ? 'Comenzar mi evaluación' : 'Ingresar a la jornada'}<ArrowRight size={18} /></button>
        </form>
      </>}
      {mode !== 'ballot' && !loginType && error && <div className="notice danger entry-error" role="alert">{error}</div>}
      <div className="login-links"><a href={`/?vista=publica${dataset === 'demo' ? '&datos=demo' : ''}`}>Ver sala pública</a><button className="link" disabled={busy} onClick={() => { setMode(mode === 'ballot' ? 'login' : 'ballot'); setLoginType(null); setError(''); setCode(''); setPassword(''); }}>{mode === 'ballot' ? 'Volver al acceso del equipo' : 'Tengo una ficha de voto'}</button></div>
      <div className="login-foot"><ShieldCheck size={17} /><span>{mode === 'ballot' ? 'El voto no solicita tu nombre ni sección.' : 'Tus valoraciones se guardan con tu acceso personal y se confirman en el servidor.'}</span></div>
    </div></section>
  </main>;
  const nav = [
    { id: 'home', label: snapshot.actor.role === 'teacher' ? 'Mi jornada' : 'Panel del subdirector', icon: LayoutDashboard },
    { id: 'prepare', label: 'Preparar jornada', icon: Settings2 },
    { id: 'live', label: 'Sala en vivo', icon: Monitor },
    { id: 'evaluations', label: snapshot.actor.role === 'teacher' ? 'Mis evaluaciones' : 'Evaluaciones docentes', icon: ClipboardCheck },
    { id: 'shortlists', label: 'Consolidación y ternas', icon: BookOpen },
    { id: 'voting', label: 'Padrón y elección', icon: Users },
    { id: 'reports', label: 'Actas y respaldos', icon: FileDown },
  ].filter(item => snapshot.actor.role === 'coordinator' || snapshot.actor.role === 'teacher' && ['home', 'evaluations'].includes(item.id) || snapshot.actor.role === 'secretary' && ['home', 'prepare', 'live', 'voting', 'reports'].includes(item.id));
  const props: ViewProps = { snapshot, api, refresh, notify };
  return <Boundary><div className="app-shell"><aside className={`sidebar ${mobile ? 'open' : ''}`}><a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('home'); }}><img src="/colegio-albert-einstein.png" alt="Colegio Albert Einstein" /></a><div className="nav-caption">SELECCIÓN DE TEXTOS <span>2027</span></div><nav>{nav.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id as Page); setMobile(false); }}><item.icon size={19} />{item.label}</button>)}</nav><div className="sidebar-bottom"><ShieldCheck size={24} /><strong>Un proceso con respaldo</strong><p>Las valoraciones técnicas y el voto familiar conservan su propio lugar.</p><a target="_blank" rel="noreferrer" href={`/?vista=publica${dataset === 'demo' ? '&datos=demo' : ''}`}>Abrir sala pública ↗</a></div></aside><div className="app-body"><header className="topbar"><button className="mobile-menu" aria-label={mobile ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setMobile(!mobile)}>{mobile ? <X /> : <Menu />}</button><div><span className="breadcrumb">Selección de textos</span><span className="separator">/</span><strong>{nav.find(item => item.id === page)?.label}</strong></div><div className="topbar-actions"><span className={`pill ${dataset === 'demo' ? 'demo' : ''}`}>{dataset === 'demo' ? 'DEMOSTRACIÓN' : 'Jornada real'}</span><button className="icon-button" title="Actualizar información" aria-label="Actualizar información" onClick={() => void refresh().catch(reason => notify(reason.message, true))}><RefreshCw size={18} /></button><button className="exit-button" aria-label="Salir" onClick={() => void logout()}><LogOut size={17} /><span>Salir</span></button></div></header>{dataset === 'demo' && <div className="demo-banner">DEMOSTRACIÓN · Datos ficticios separados de la jornada real.</div>}<div className="actor-line"><span className="online-dot" />{snapshot.actor.name}<span className="muted">{snapshot.actor.role === 'coordinator' ? 'Subdirector' : snapshot.actor.role === 'secretary' ? 'Secretaría' : 'Docente evaluador'}</span></div><main className="main-content"><Suspense fallback={<div className="loading-panel">Cargando pantalla…</div>}>{page === 'home' ? <Home snapshot={snapshot} go={setPage} /> : page === 'prepare' ? <Preparation {...props} /> : page === 'live' ? <LiveRoom {...props} /> : page === 'evaluations' ? <Evaluations {...props} /> : page === 'shortlists' ? <Consolidation {...props} /> : page === 'voting' ? <Voting {...props} /> : <Reports {...props} />}</Suspense></main></div>{message && <div className={`toast ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label="Cerrar aviso"><X size={17} /></button></div>}</div></Boundary>;
}
