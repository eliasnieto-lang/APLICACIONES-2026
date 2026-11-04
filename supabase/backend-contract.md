# Contrato del servidor

Se implementa `textos_api` con la firma de `shared/api-contract.md`. Los cambios se confirman en una sola transacción y los errores PT409 conservan la versión anterior. Las operaciones guardan la entidad indicada; `snapshot` entrega el estado filtrado por rol.

La coordinación local se crea únicamente como propietario de PostgreSQL mediante `select public.textos_bootstrap_local('real');`; devuelve un código una sola vez. La migración registra la cuenta cloud autorizada. No hay una contraseña de coordinación incorporada en el código fuente.

`demo_reset` admite `{state: State}` para cargar la demostración ficticia; sin estado vacía solo la demostración. Nunca acepta modificar `real`. `backup_get` devuelve `{format, dataset, createdAt, state, history, ballots, aggregates}`. Los códigos originales no se guardan; los respaldos privados contienen sus huellas y consumo. La restauración mantiene el consumo posterior conocido y suspende las rondas que requieren conciliación. Las credenciales personales no se importan desde respaldos.

`import_preview` acepta `kind` y las filas canónicas normalizadas por `shared/imports.ts`; devuelve `{valid, errors, warnings, rows}`. `import_apply` exige `confirmed:true` y vuelve a ejecutar los validadores del servidor antes de aplicar todas las filas en una transacción. Títulos crea editorial/serie/oferta por claves naturales y rechaza códigos de libro duplicados; temas y práctica identifican el texto por `bookCode`. No admite modificar un expediente cerrado por importación.

Las fichas, asignaciones y datos del padrón quedan fuera de la proyección. Secretaría no recibe fichas ni notas; el docente recibe únicamente asignaciones, textos y fichas propias. Ningún rol recibe conteos de rondas abiertas en la proyección pública. El servidor nunca guarda una cédula individual ni vincula opción con código o sección.


`public_snapshot` devuelve el sobre `Snapshot` estándar. Su estado vacía docentes, fichas, asignaciones, revisiones, padrón, entregas, incidencias y bitácora. Solo incluye los libros de los grados efectivamente publicados. Las instantáneas anidadas de las ternas públicas muestran los puntajes agregados de las finalistas y reglas; no incluyen expedientes internos de candidatas excluidas.

`vote_preview` devuelve `{roundId,gradeId,number,areas,options:{MAT?:[{id,label,title,edition,publisher}],COM?:[...]},confirmed:false}`. `vote_cast` exige `confirmed:true` y una clave por cada área de esa ronda; `null` significa blanco. Las cédulas no guardan marca horaria individual. El contador de cédulas recibidas y las sumas por opción se confirman de forma atómica bajo el bloqueo de la jornada.

`restore_preview` devuelve `{valid,dataset,version,suspendedRoundIds,books,evaluations,rounds}`. Una restauración anterior a un consumo conocido, conteos conocidos o cierre ya registrado suspende la ronda afectada y conserva el consumo de sus códigos. En una instalación real sin historial local de esa ronda, las rondas importadas abiertas o en borrador también quedan suspendidas: la copia no permite saber qué códigos se consumieron después de crearla. Los resultados cerrados se conservan. `round_reconcile` exige anulación con motivo y crea una ronda nueva en borrador; las cédulas nuevas requieren acreditar la entrega de la nueva ronda.

`section_save` acepta además `remove:true` para eliminar una sección todavía sin entregas. `turn_control finish` conserva `startedAt` y fija `pausedAt` a la hora del servidor como inicio del registro/cambio; `start` y `next` requieren `publisherId` y reinician el turno.

El respaldo privado incluye el historial completo. Las fichas históricas conocidas de ocho indicadores se migran a diez dejando I9/I10 en `null`, sus referencias vacías y la ficha en borrador; el original permanece en el historial. No recuperan aptitud hasta que el docente completa y cierra los diez indicadores.
