# Contrato compartido de la aplicación

Transporte cloud/local: RPC `textos_api(p_action text, p_payload jsonb default '{}', p_code text default null, p_dataset text default 'real') returns jsonb`. Los errores usan PT400, PT401, PT403, PT404, PT409, PT413, PT423 y PT429.

`snapshot` devuelve Snapshot de shared/types.ts. Subdirección ingresa con contraseña validada por PostgreSQL; el servidor devuelve un código privado de sesión. Coordinación cloud por auth.uid() en textos_coordinators y los códigos privados anteriores siguen funcionando. Las tablas no conceden acceso directo anon/authenticated. Los códigos se guardan solo como huellas, salvo la devolución única al crearlos. Cada código docente está ligado al dataset y teacherId.

`teacher_register`, `director_login`, `public_snapshot`, `vote_preview` y `vote_cast` admiten peticiones sin sesión previa. Votación no envía JWT de coordinación, ni registra relación código/opciones/identidad en auditoría. API pública nunca devuelve fichas docentes, padrón, códigos, auditoría ni conteos de rondas abiertas.

Acceso directo:
- `teacher_register {lastNames,firstNames,area:'MAT'|'COM',categories:('P1'|'P2'|'S1')[]}` devuelve `{code,snapshot:Snapshot}`. Apellidos y nombres son obligatorios; área única, una o más categorías distintas. Se normalizan espacios y se validan los campos en el servidor. No exige correo ni contraseña y no limita el número de docentes. Guarda `name`, `lastNames`, `firstNames`, `area`, `categories` y `selfRegistered:true` en Teacher, conservando identidad y datos anteriores al actualizar.
- Sin `p_code` crea un perfil nuevo. Un nombre completo canónico ya existente, incluso legado, devuelve PT409 y pide a Subdirección un enlace privado de recuperación; nunca entrega fichas por coincidencia de nombre. Con `p_code` docente válido actualiza únicamente su propio perfil, sin asumir el nombre de otro docente. Una sesión inválida, vencida, revocada o de otro dataset devuelve PT401. Las fichas e historial permanecen intactos. Una inscripción nueva o un cambio de área/categorías conserva las publicaciones afectadas como versiones históricas y exige consolidar nuevamente el conjunto de docentes; reingresar con el mismo perfil de categorías mantiene la publicación vigente.
- `director_login {password}` devuelve `{code,snapshot:Snapshot}` con rol `coordinator`. La contraseña nunca se compara en el navegador. El código opaco se guarda solo como huella en PostgreSQL y queda ligado al dataset. Las sesiones emitidas por estas dos acciones duran 180 días.
- Error de contraseña: HTTP401 con `{error:{code:'PT401',message}}`; bloqueo temporal: HTTP429 con `{error:{code:'PT429',message}}`. Estos dos errores se devuelven sin excepción SQL para confirmar los intentos fallidos: cinco fallos por dataset bloquean el ingreso durante un minuto; la ventana de intentos dura quince minutos. Un ingreso correcto reinicia el contador. Los clientes deben leer `error.code` y `error.message` además del formato de errores PostgREST habitual.
- El navegador conserva su sesión privada. `access_create` permite a Subdirección generar un código docente que la interfaz entrega como enlace con fragmento privado para recuperar un perfil existente.

Evaluación de exposición y texto físico:
- `presentation_save {publisherId,area,block,scaleMax:4,scores,notes,generalObservation,physicalText,expectedVersion,materialViewed?}` crea o actualiza la ficha propia de diez indicadores. `scores` contiene enteros 0–4 o `null`: 0 = Sin valoración, 1 = En inicio, 2 = En proceso, 3 = Logrado, 4 = Destacado. El 0 seleccionado es una respuesta y aporta cero al total; `null` indica que aún falta responder y mantiene la ficha pendiente. La nota es `sum(scores) × 2.5`, sobre 100; el máximo bruto es 40. `presentation_close {evaluationId,expectedVersion,scaleMax:4}` exige diez respuestas válidas.
- `presentation_restart_scale {evaluationId,expectedVersion,scaleMax:4}` permite únicamente al docente dueño iniciar explícitamente una nueva valoración de su ficha histórica 0–2. Conserva el original en historial y devuelve la misma unidad/id con versión incrementada, escala 4, diez puntajes `null`, estado borrador y observaciones conservadas. No convierte números antiguos ni necesita que Subdirección puntúe o reabra primero. Una ficha actual 0–4 no admite este reinicio.
- `scaleMax` ausente en una ficha guardada significa escala histórica 0–2, nunca escala inferida por sus números. Los porcentajes históricos siguen usando `sum × 5`. Un formulario antiguo con diez valores 2 conserva 100/100; una nueva ficha 0–4 con diez valores 2 obtiene 50/100. Los cierres históricos quedan pendientes de actualización de escala y se excluyen de los promedios actuales; `pendingScaleUpdate` cuenta esas fichas. Los navegadores que guardan/cierran sin `scaleMax:4`, o intentan guardar directamente una ficha 0–2, reciben PT409 para actualizar la aplicación/iniciar la nueva valoración.
- `presentation_reopen {evaluationId,reason}` solo Subdirección, conserva el original y su escala. `presentation_summary {}` devuelve los seis resúmenes de área/categoría con promedios por editorial a Subdirección/mesa. `presentation_shortlist_publish {area,block,statement,folio,directorApproved:true}` exige retiro registrado de las editoriales con referencia, deriva exactamente tres editoriales aptas del resumen y publica una versión agregada histórica con `snapshot.scaleMax:4`; no acepta una selección arbitraria de editoriales.
- La unidad es editorial × área × categoría, con una ficha por docente para esa unidad. Cualquier número de docentes válidos puede evaluar; los indicadores observados directamente no requieren expedientes, asignaciones ni filtros ministeriales cargados previamente. El docente solo escribe su área/categorías; recibe únicamente sus fichas. No hay acceso público a puntajes individuales. `presentationEvaluations` y `presentationShortlists` son colecciones separadas de los registros históricos por libro; la escala de esos registros de libros permanece 0–2. Las reglas precisas de cierre, promedio y publicación se describen en `shared/presentation-contract.md`.

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


## Sorteo, seguimiento y ranking (actualización 004)

`presentation_draw` es exclusivo de Subdirección: recibe `expectedVersion` del sorteo (0 al crearlo), `confirmArrivals: true` y motivo de al menos ocho caracteres si se repite. El servidor sortea todas las editoriales con UUID aleatorios, congela sus nombres y orden, y permite repetir únicamente antes de empezar. `turn_control` con sorteo recibe `expectedTurn` completo además del comando; un control desactualizado devuelve PT409. Finalizar marca una sola editorial y el siguiente inicio respeta el orden. Las proyecciones pública y docente solo reciben los campos enumerados del sorteo.

`presentation_ranking_generate` recibe la versión esperada del ranking (0 al crearlo), requiere el sorteo terminado y toma los promedios actuales de todas las categorías. Distingue resultados provisionales y conserva su snapshot; `stale` se calcula mediante una huella de catálogo, docentes, fichas, reglas y sorteo. Los filtros y Top no cambian las notas ni publican una terna formal. El progreso docente cuenta criterios guardados (incluido 0) y cierres por separado.

## Votación de padres A5

`paper_poll_create` recibe `block`, `areas`, `rankingId` y `expectedRankingVersion`. La interfaz usa MAT y COM en una misma categoría. Se exige ranking final vigente y dos o tres opciones reales por área; la consulta del servidor recalcula las categorías y no confía en datos de un respaldo modificado.

`paper_ballots_generate` recibe `pollId`, `expectedVersion` y cantidad 1–200; retorna `{poll,codes}` una sola vez. El PDF y el QR se construyen localmente. Los códigos anónimos se guardan solo como huellas en una tabla privada, sin nombre ni selección.

`paper_scan_cast` recibe `pollId`, código y `choices` para todas las áreas: id de editorial, `null` para blanco o `__invalid__` para nulo. Consume el código e incrementa los agregados en una transacción; una repetición devuelve PT409. Las fotos y píxeles no salen del navegador. La detección de marcas requiere el formato generado y las lecturas dudosas pasan a revisión. No se escribe el código ni las selecciones en auditoría.

`paper_poll_close` requiere versión, cierra recepción y devuelve resultados separados por área, sin declarar ganador en empate o ausencia de votos válidos. El respaldo incluye `paperTokens` como huellas; su restauración no puede reducir conteos, perder códigos emitidos ni volver a habilitar un código consumido. La votación actual por exposición se conserva separada de las rondas históricas por libro y grado.


## Actualización 005: valoración adaptada y eliminación

La rúbrica vigente usa `scaleMax:4`, `rubricVersion:2`, diez `scores` y `responseScore` adicional; `questionVersion` identifica la pregunta respondida. El máximo es44 y la nota orientativa es la suma de los once criterios ×100/44. El cero seleccionado cuenta cero; `null` sigue pendiente. Las notas anteriores de diez criterios0–4 conservan /40 y las0–2, /20. `presentation_enable_question` conserva las diez respuestas de una ficha0–4 anterior y archiva su versión antes de añadir I11. Los clientes anteriores deben actualizarse antes de guardar.

`presentation_question_save` es exclusivo de coordinación. Registra representante, área, pregunta, resumen y confirmación; el servidor exige CAS, conserva historial y bloquea cambios después del cierre o de una valoración cerrada vinculada. `turn_control.finish` requiere una pregunta respondida por editorial. Cerrar la ficha exige once valoraciones y versión actual de pregunta. El ranking orienta la clasificación de tres editoriales sin mínimo de puntos; la votación familiar calcula su propio resultado, independiente del primer puesto técnico.

`data_delete_preview` y `data_delete_apply` están disponibles exclusivamente para coordinación, en el dataset actual (`real` o `demo`). La previsualización no modifica datos; `apply` exige la versión previsualizada y confirmación exacta. Admite catorce ámbitos de registros, cascadas referenciales, revocación de accesos docentes y retirada de votos/resultados dependientes. El vaciado total conserva configuración y credenciales administrativas. Instalar/repetir el SQL no ejecuta el borrado.

Las referencias MINEDU son documentales: el colegio conserva su escala0–4; no convierte automáticamente esos niveles al instrumento integral0–2 de la guía. Se identifican verificaciones pendientes, el mínimo formal de70 se muestra como información y se proporciona el PDF adjunto.
