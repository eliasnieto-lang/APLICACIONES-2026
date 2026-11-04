# Contrato compartido de la aplicación

Transporte cloud/local: RPC `textos_api(p_action text, p_payload jsonb default '{}', p_code text default null, p_dataset text default 'real') returns jsonb`. Los errores usan PT400, PT401, PT403, PT404, PT409, PT413 y PT423.

`snapshot` devuelve Snapshot de shared/types.ts. Coordinación cloud se reconoce por auth.uid() en textos_coordinators; códigos privados para docentes/secretaría y coordinación local. Las tablas no conceden acceso directo anon/authenticated. Los códigos se guardan solo como huellas, salvo la devolución única al crearlos. Cada código docente está ligado al dataset y teacherId.

`public_snapshot`, `vote_preview`, `vote_cast` son las únicas acciones anónimas sin rol personal. Votación no envía JWT de coordinación, ni registra relación código/opciones/identidad en auditoría. API pública nunca devuelve fichas docentes, padrón, códigos, auditoría ni conteos de rondas abiertas.

Acciones privadas y payload:
- settings_save {settings,expectedVersion,reopenReason?}
- publisher_save {publisher}; series_save {series}; offer_save {offer}; book_save {book,supersedes?,reason?}; teacher_save {teacher}; assignment_save {assignment}; section_save {section}. Cada entidad tiene id/version. Las nuevas admiten id vacío. Devuelven la entidad guardada.
- attendance_save {teacherId,present,evidence}
- access_create {role:'teacher'|'secretary',teacherId?,name?,expiresAt?} devuelve {code,role,name}. Solo coordinación.
- evaluation_save {assignmentId,scores,evidence,notes,expectedVersion,objection,objectionDetail} y evaluation_close {assignmentId,expectedVersion} devuelven Evaluation. Solo docente dueño. evaluation_reopen {assignmentId,reason} solo coordinación, conserva historia y no cambia puntajes.
- review_request {categoryId,offerIds,unitReference,reason} crea asignaciones adicionales para los mismos docentes.
- turn_control {command:'start'|'pause'|'resume'|'finish'|'next',publisherId?} devuelve Turn.
- shortlist_publish {categoryId,directorApproved,statement,folio}; shortlist_exception {gradeId,area,offerIds,reason,folio,directorApproved,article113}; shortlist_reopen {shortlistId,reason}.
- round_create {gradeId,mode,areas?,physicalReviewConfirmed} devuelve Round borrador; round_open {roundId}; delivery_mark {roundId,sectionId,delivered}; paper_tally_save {roundId,deposited,counts,expectedVersion}; round_close {roundId}; runoff_open {roundId,area,mode?}; ballots_generate {roundId,count?} devuelve {codes:string[]}; round_reconcile {roundId,reason,action:'void-and-restart'}.
- vote_preview usa p_code y devuelve solo grado/ronda/opciones públicas; vote_cast usa p_code y payload {choices:{MAT:offerId|null,COM:offerId|null},confirmed:true}, devuelve {accepted:true}. Solo huellas usadas y agregados, sin voto individual.
- incident_save {incident}; import_preview {kind,rows}; import_apply {kind,rows,confirmed:true}; kind titles/topics/practice/sections.
- backup_get devuelve respaldo privado completo; restore_preview {backup}; restore_apply {backup,confirmation:'RESTAURAR',reason}; demo_reset solo coordinación.

No devolver éxito de guardado sin transacción confirmada. expectedVersion aplica al borrador de la ficha y las entidades editadas. Nuevos textos/ediciones no reutilizan evaluaciones. Reglas bloqueadas con la primera ficha recibida; reapertura con motivo/versionado. Los snapshots de ternas y resultados usados son históricos.

Una ronda restaurada desde antes del último voto queda suspendida y conserva el consumo de códigos. Conciliación documentada antes de otra ronda; una copia no puede volver a habilitar votos consumidos.
