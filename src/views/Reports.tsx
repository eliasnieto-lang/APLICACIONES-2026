import { useState } from 'react';
import type { ViewProps } from '../../shared/types';
import { demoState } from '../../shared/defaults';
import { GRADES } from '../../shared/domain';
import { buildComparisonPdf, buildMinutesPdf, buildPaperBallotPdf, buildPrivateWorkbook, buildShortlistPdf, buildTeacherPdf, downloadBytes } from '../reports';

type Kind = 'ficha' | 'cedula' | 'mesas' | 'terna' | 'acta';
interface RestorePreview { valid: boolean; dataset?: string; version?: number; suspendedRoundIds?: string[]; books?: number; evaluations?: number; rounds?: number }
export default function Reports({ snapshot, api, refresh, notify }: ViewProps) {
  const state = snapshot.state; const coordinator = snapshot.actor.role === 'coordinator';
  const [kind, setKind] = useState<Kind>(coordinator ? 'ficha' : 'cedula');
  const [bookId, setBookId] = useState(state.books[0]?.id ?? '');
  const [evaluationId, setEvaluationId] = useState('');
  const [roundId, setRoundId] = useState(state.rounds[0]?.id ?? '');
  const [shortlistId, setShortlistId] = useState(state.shortlists[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<unknown>(null);
  const [backupName, setBackupName] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const round = state.rounds.find(item => item.id === roundId);
  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (error) { notify(error instanceof Error ? error.message : 'No se pudo generar el documento.', true); } finally { setBusy(false); } };
  const generate = () => run(async () => {
    const options = { demo: snapshot.dataset === 'demo', generatedAt: snapshot.serverNow };
    const bytes = kind === 'ficha' ? await buildTeacherPdf(state, bookId, evaluationId || undefined, options)
      : kind === 'cedula' ? await buildPaperBallotPdf(state, roundId, options)
      : kind === 'mesas' ? await buildComparisonPdf(state, roundId, options)
      : kind === 'terna' ? await buildShortlistPdf(state, shortlistId, options)
      : await buildMinutesPdf(state, roundId, options);
    downloadBytes(bytes, `${kind}-textos-2027-${snapshot.dataset}.pdf`, 'application/pdf'); notify('PDF A4 generado. Revise el documento antes de imprimir y recoger firmas.');
  });
  const chooseBackup = (file: File) => run(async () => {
    setBackup(null); setPreview(null); setConfirmation(''); setReason(''); setBackupName(file.name);
    if (file.size > 16 * 1024 * 1024) throw new Error('El respaldo supera 16 MB. Use un respaldo generado por el sistema.');
    let parsed: unknown; try { parsed = JSON.parse(await file.text()); } catch { throw new Error('El archivo no es un respaldo JSON válido.'); }
    const result = await api.call<RestorePreview>('restore_preview', { backup: parsed });
    setBackup(parsed); setPreview(result);
  });
  if (!['coordinator', 'secretary'].includes(snapshot.actor.role)) return <div className="notice">Los documentos administrativos corresponden a Coordinación y Secretaría.</div>;
  const disabled = busy || (kind === 'ficha' && !bookId) || (kind === 'terna' && !shortlistId) || (['cedula', 'mesas', 'acta'].includes(kind) && !roundId) || (kind === 'cedula' && round?.mode !== 'paper') || (kind === 'acta' && round?.status !== 'closed');
  return <div className="stack">
    <header><h1>Actas, material y respaldo</h1><p className="muted">Documentos A4 con sus versiones y espacios para firmas. Los resultados publicados son agregados.</p></header>
    <section className="card stack"><h2>Generar PDF para revisión e impresión</h2><label className="field">Documento<select value={kind} onChange={e => setKind(e.target.value as Kind)}>{coordinator && <option value="ficha">Ficha individual del docente (reservada)</option>}<option value="cedula">Cédula anónima en papel</option><option value="mesas">Tarjetas comparativas de mesas</option><option value="terna">Constancia de una versión de terna</option><option value="acta">Acta final por grado y área</option></select></label>
      {kind === 'ficha' && coordinator && <div className="grid"><label className="field">Título, edición y grado<select value={bookId} onChange={e => { setBookId(e.target.value); setEvaluationId(''); }}><option value="">Seleccione título</option>{state.books.map(book => <option key={book.id} value={book.id}>{book.code} · {book.title} · {GRADES.find(grade => grade.id === book.gradeId)?.label} · {book.edition}</option>)}</select></label><label className="field">Ficha a imprimir<select value={evaluationId} onChange={e => setEvaluationId(e.target.value)}><option value="">Ficha en blanco (sin puntajes por defecto)</option>{state.evaluations.filter(item => item.bookId === bookId).map(evaluation => <option key={evaluation.id} value={evaluation.id}>{state.teachers.find(teacher => teacher.id === evaluation.teacherId)?.name} · {evaluation.status === 'closed' ? 'cerrada' : 'borrador'} · v{evaluation.version}</option>)}</select></label></div>}
      {['cedula', 'mesas', 'acta'].includes(kind) && <label className="field">Ronda por grado<select value={roundId} onChange={e => setRoundId(e.target.value)}><option value="">Seleccione ronda</option>{state.rounds.map(round => <option key={round.id} value={round.id}>{GRADES.find(grade => grade.id === round.gradeId)?.label} · ronda {round.number} · {round.mode === 'paper' ? 'papel' : 'digital'} · {round.status}</option>)}</select></label>}
      {kind === 'terna' && <label className="field">Versión histórica de terna<select value={shortlistId} onChange={e => setShortlistId(e.target.value)}><option value="">Seleccione terna</option>{state.shortlists.map(shortlist => <option key={shortlist.id} value={shortlist.id}>{shortlist.categoryId} · {shortlist.scope === 'grade' ? shortlist.gradeIds.join(', ') : 'bloque'} · v{shortlist.version} · folio {shortlist.folio} · {shortlist.status}</option>)}</select></label>}
      {kind === 'ficha' && <div className="notice">Documento interno: contiene la valoración de un docente. Entregue cada ficha únicamente al docente correspondiente y a Coordinación.</div>}
      {kind === 'cedula' && <div className="notice">La cédula no incluye sección, representante, firma ni código individual. La acreditación y la entrega se registran por separado.{round?.mode === 'digital' && ' Esta ronda es digital: no se puede habilitar además votación en papel.'}</div>}
      {kind === 'acta' && round?.status !== 'closed' && <div className="notice">Cierre la ronda en Padrón y elección para emitir el acta final. Un empate o la falta de votos válidos se documenta sin inventar un ganador.</div>}
      <div className="row"><button className="primary" disabled={disabled} onClick={generate}>{busy ? 'Generando…' : 'Descargar PDF A4'}</button><span className="muted">Los cierres en la aplicación no sustituyen las firmas formales.</span></div>
    </section>
    {coordinator && <>
      <section className="card stack"><h2>Exportación de trabajo interna</h2><p>El libro XLSX incluye catálogo, precios, fichas docentes, padrón, versiones de ternas e incidencias. Los conteos se exportan agregados por ronda cerrada; el padrón conserva únicamente acreditación.</p><div className="notice">Contiene datos personales y observaciones reservadas. Guárdelo con acceso restringido. No incluye códigos de acceso ni una relación entre identidad y opción de voto.</div><button disabled={busy} onClick={() => run(async () => { const bytes = await buildPrivateWorkbook(state); downloadBytes(bytes, `exportacion-interna-textos-2027-${snapshot.dataset}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); notify('Exportación interna XLSX descargada.'); })}>Descargar XLSX privado</button></section>
      <section className="card stack"><h2>Respaldo transaccional</h2><p>Descargue una copia completa desde el servidor para conservar puntajes, cierres, versiones, códigos consumidos y conteos de la misma instantánea. La exportación XLSX no sustituye este respaldo.</p><button disabled={busy} onClick={() => run(async () => { const result = await api.call('backup_get'); downloadBytes(JSON.stringify(result, null, 2), `respaldo-textos-2027-${snapshot.dataset}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, 'application/json'); notify('Respaldo privado descargado desde el servidor.'); })}>Descargar respaldo privado JSON</button></section>
      <section className="card stack"><h2>Restaurar con vista previa</h2><p>Seleccione una copia generada por esta aplicación. Antes de aplicar, el servidor revisa el respaldo y detecta rondas que deben suspenderse para conciliar votos ya emitidos.</p><label className="field">Archivo de respaldo JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) chooseBackup(file); }} /></label>
        {preview && <><div className={`notice ${preview.valid ? '' : 'danger'}`}><strong>{backupName}</strong><p>Espacio: {preview.dataset ?? snapshot.dataset} · versión {preview.version ?? 'por confirmar'} · {preview.books ?? '?'} títulos · {preview.evaluations ?? '?'} fichas · {preview.rounds ?? '?'} rondas.</p>{preview.suspendedRoundIds?.length ? <p>El servidor suspenderá {preview.suspendedRoundIds.length} ronda(s) y exigirá conciliación documentada. Los códigos ya consumidos no se vuelven a habilitar.</p> : <p>Vista previa del servidor completada. La aplicación definitiva vuelve a comprobar la instantánea.</p>}</div><label className="field">Motivo y referencia documental<textarea required rows={3} value={reason} onChange={e => setReason(e.target.value)} /></label><label className="field">Escriba RESTAURAR para confirmar<input autoComplete="off" spellCheck={false} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label><button className="danger" disabled={busy || !preview.valid || confirmation !== 'RESTAURAR' || !reason.trim() || !backup} onClick={() => run(async () => { await api.call('restore_apply', { backup, confirmation, reason }); await refresh(); setPreview(null); setBackup(null); setConfirmation(''); setReason(''); notify('Respaldo restaurado. Revise las rondas suspendidas antes de continuar.'); })}>Aplicar restauración documentada</button></>}
      </section>
      {snapshot.dataset === 'demo' && <section className="card stack"><h2>Reiniciar la demostración</h2><p>Recrea los datos ficticios de este espacio y su reloj comprimido. La jornada real se conserva en su propio espacio.</p><label className="row"><input type="checkbox" checked={resetConfirmed} onChange={e => setResetConfirmed(e.target.checked)} /> Confirmo reemplazar los datos de la demostración.</label><button className="danger" disabled={busy || !resetConfirmed} onClick={() => run(async () => { await api.call('demo_reset', { state: demoState() }); await refresh(); setResetConfirmed(false); notify('Demostración reiniciada con datos ficticios.'); })}>Reiniciar solo demostración</button></section>}
    </>}
  </div>;
}
