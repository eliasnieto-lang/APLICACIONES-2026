# Validación de la edición web

## Evaluación ponderada, otras aulas y permanencia

La versión vigente usa **50 % Académico, 25 % Desempeño y 25 % Compromiso**, siguiendo la última indicación del usuario. Permite excluir C por estudiante y redistribuir A/B a 66,67 %/33,33 %, conservar sus registros y registrar manualmente la permanencia. Admite secundaria 1.º–5.º, secciones A–Z, con filtros y posiciones por aula completa. Los promedios de las áreas se presentan sobre 100; Indaga completamente vacía se excluye en cualquier aula admitida.

Validación: `npm test` aprobó **181/181 pruebas**, incluidas **30 pruebas API**; TypeScript, `npm run build:web` y la aceptación completa `npm run test:web` también aprobaron. HTML probado: **10 337 893 bytes**, SHA-256 `9df4b727fda642874a80d36e9deca30a267436a789dd127b5e85f21e01a6edc9`.

El navegador comprobó A58,75/B95,50/C100 con total **78,25**, y **71,00** al excluir C sin perder sus registros; al incluirla de nuevo recuperó el resultado original. Dos libretas genuinas de **1.º A y 1.º B** produjeron listados, rankings y exportaciones separados, cada uno con su propio primer puesto. Con A75/B95,50 y C excluida, el total fue81,83. Las decisiones manuales Permanece/No permanece y la opción de C persistieron al recargar y en respaldos. Una libreta de 1.º B con Indaga vacía permitió revisión manual sin inventar notas; las áreas mostraron75/100. La API verificó también la corrección manual de aula, la conservación de campos nuevos ante guardados antiguos y el rechazo de un respaldo que mezcla la sección del alumno y la del PDF aprobado.

Las pruebas de migración conservan datos y criterios personalizados, completan los campos antiguos una sola vez y mantienen la evaluación cerrada. Los pesos del total ausentes se incorporan con aprobación pendiente de la nueva fórmula. Se verificaron los casos incompletos de A/B, los pesos inválidos, la normalización exacta de aulas y los empates por cohorte.

Se inspeccionaron los controles de evaluación/permanencia, los rankings de ambas aulas y la tabla académica con escala sobre100. Hubo **10 descargas**, sin errores de página/consola ni solicitudes HTTP durante las operaciones. Se conservaron los escenarios anteriores de OCR, restauración, eliminación individual/total, reimportación y reinicio. Todas las pruebas usaron documentos ficticios y almacenamiento temporal.

## Indaga no cursada en 4.º F y 5.º F

Se incorpora 5.º F junto con 2.º F, 3.º F y 4.º F. En 4.º F y 5.º F, Indaga completamente vacía en I–III queda excluida de promedios, progresión, pendientes y denominadores de avance. La fila original permanece vacía y visible; Ciencia y Tecnología requiere revisión manual y las demás competencias completas. Una sola nota de Indaga devuelve sus vacíos restantes al estado pendiente. Las otras aulas conservan las reglas anteriores.

Validación: **171/171 pruebas** en `npm test`, construcción `npm run build:web` y aceptación completa `npm run test:web` aprobadas. HTML comprobado: **10 328 121 bytes**, SHA-256 `ea6c3873fcc5efc2ef4a63b3919b904216b2052056aec917883e69b1ac490a11`.

Los PDF compactos de prueba de 4.º F y 5.º F conservaron Indaga vacía y las otras seis calificaciones A; el área promedió 3,00/4 y Académico 75,00. Confirmar el PDF dejó pendientes las marcas manuales del área y la confirmación final. Ambas pudieron confirmarse y persistieron después de recargar, sin OCR ni reescaneo automático por la fila no cursada. La imagen del área muestra dos competencias evaluadas y “No se evalúa en esta aula”. La API rechazó Indaga vacía en 2.º F/3.º F, Indaga parcial en 4.º F y otra nota faltante en 5.º F. También se verificaron las ponderaciones con notas mixtas, conservación de IV, normalización precisa de quinto y advertencias coherentes con la identidad del archivo.

Se conservaron los escenarios anteriores de respaldo, restauración, eliminación, reimportación, concursos y reinicio. Hubo siete descargas, sin errores de página o consola ni solicitudes HTTP durante las operaciones. Todos los datos fueron ficticios en directorios o perfiles temporales.

## Eliminación individual y total

La entrega incorpora **Eliminar estudiante** al final de la ficha y **Eliminar todos los datos de evaluación** en el panel principal. Funcionan con la evaluación abierta o cerrada, con confirmación explícita y respaldo opcional. La limpieza total exige `ELIMINAR TODO`, conserva los parámetros y abre el siguiente proceso; afecta únicamente al espacio seleccionado.

Validación: `npm test` aprobó **160 pruebas** y `npm run build:web` pasó. La aceptación completa `npm run test:web` terminó correctamente sobre el HTML de **10 326 133 bytes**, SHA-256 `9211a4ca1a73f385f5b1cf000a6233c18dbeb599b745cf9079fb1905264bcedc`.

Se verificó la espera de autoguardados y escaneos, cancelación sin cambios, respaldo opcional, eliminación individual con original/versiones/duplicado, conservación íntegra de otras fichas y reimportación del mismo PDF. La limpieza de una evaluación cerrada eliminó todos los registros y archivos reales, incluido un Blob huérfano sin metadatos, conservó todos los parámetros salvo `closed=false` y dejó el espacio de demostración idéntico. El panel y el respaldo quedaron vacíos, sin que reaparecieran datos tras reiniciar Chromium. La API añadió comprobaciones de estudiantes sin PDF, propietarios distintos con el mismo hash, confirmaciones desactualizadas y reversión transaccional ante fallos de persistencia.

Se completaron siete descargas en la primera sesión, sin errores de página/consola ni solicitudes HTTP durante las operaciones. Se inspeccionaron los dos controles y sus diálogos en escritorio y a 390 px. Todas las eliminaciones de prueba utilizaron directorios o perfiles temporales; no se limpiaron datos del usuario.

## Áreas aplicables y validación mínima

La versión vigente oculta e ignora las asignaturas sin ninguna nota AD/A/B/C de I–III. Las notas de IV por sí solas no hacen que un área sea cursada. Las asignaturas parcialmente registradas conservan sus pendientes. Los cursos y grupos no cursados se excluyen de promedios, progreso, escaneo automático y validaciones, sin borrar las filas originales.

`npm test` aprobó **156 pruebas** y la construcción portátil pasó. La aceptación del navegador verificó una libreta compacta de diez cursos con Matemática, Arte y Religión vacíos en I–III (AD en IV): solo se muestran siete áreas, se conservan los datos originales, G/A permanecen en75 para los cursos cursados y no se ejecuta un reescaneo innecesario. También se comprobaron los controles manuales por área y final, su persistencia sin modificar notas y el caso parcial que debe permanecer visible y pendiente.

Incidencias: categoría, fecha y descripción bastan para verificar, sin medida ni evidencia; los descuentos no aprobados continúan pendientes para el cálculo, sin impedir guardar la verificación. Familia: actividad, fecha y estado bastan para validar, sin justificación ni evidencia, y un nuevo registro cumplido produce CF100 con solo esos tres datos. Se conservaron la escala40/70/100 y los puntajes de referenciaA58,75/B95,50/C100/total84,75.

La aceptación terminó sin errores JavaScript, de consola ni solicitudes HTTP durante las operaciones. Se mantuvieron los escenarios previos de notas45/78, respaldos, restauración, eliminación, reimportación, persistencia y reescaneo.

## Concursos académicos y notas escaneadas

La versión vigente valida participación institucional con solo tipo de evento, fecha y ubicación/puesto. Ofrece únicamente concursos académicos locales (40), regionales (70) y nacionales (100); PI toma el mejor resultado. Los demás datos son opcionales.

Validación: `npm test` aprobó **141 pruebas**; construcción portátil y aceptación de navegador aprobadas. El navegador verificó PDF compactos genuinos con **45 notas de las áreas evaluables** y **78 notas de diez cursos**, lectura antes de confirmar, tablas de notas de solo lectura, los tres campos mínimos, cada omisión obligatoria, puntajes 40/70/100, reescaneo explícito y automático sin bucles, persistencia de asignaturas adicionales, protección de B/C y conservación del hash/identidad/aprobación del original. El ranking de prueba exportó A58,75, B95,50, C100 y total84,75. No hubo solicitudes HTTP durante las operaciones, errores de página ni errores de consola; se comprobaron cuatro descargas y reinicio del navegador.

Las pruebas automáticas incluyen lectura de tablas con área y primera competencia en una misma fila, áreas y etiquetas partidas, celdas dibujadas separadamente, vacíos sin desplazamiento y PDF vectoriales cuyo mapa de fuentes no permite obtener las notas. Esos últimos se renderizan para OCR local. Las notas inciertas siguen pendientes y no se inventan. El lector distingue textos de Inglés y Religión para no atribuirlos por alias a Comunicación o DPCC.

El PDF original de las capturas no ha sido adjuntado a este chat, de modo que aún falta verificar esa libreta específica. Los resultados anteriores corresponden a PDF de prueba generados y documentos OCR de integración.

## Nombre de archivo, código opcional y nombre editable

El ajuste vigente usa prioritariamente el nombre del archivo PDF para la identidad. La captura del usuario se reproduce con `BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf`: aparece **SEGURA CAMONES ANDRES ADRIAN**, aula **2.º F**, antes de confirmar, aun sin código ni año extraídos. El casillero de nombre permite corregir o completar la identidad.

Validación: `npm test` aprobó **107 pruebas**; se ejecutó además el caso actualizado de ingreso manual con PDF que solo contiene aula. La construcción portátil y `npm run test:web` pasaron. La aceptación verifica el nombre exacto, prioridad frente a un nombre distinto dentro del PDF, lista previa a la confirmación, edición manual sin código/año, A pendiente por falta de notas y apertura de A/B/C, migración inmediata desde archivos ya guardados, conservación de B/C y restauración después de editar el nombre sin mantener borradores obsoletos. No hubo solicitudes HTTP adicionales ni errores de página o consola.

Los identificadores internos permanecen en almacenamiento por compatibilidad, sin requisito de ingresarlos ni mostrarlos en la revisión. Sus columnas se ocultan en Excel. No se fuerza OCR de metadatos si el archivo ya proporciona nombre y aula; las calificaciones siguen leyendo el PDF y la progresión mantiene I–II frente a III.

## Identidad automática y dos acciones de revisión

El segundo ajuste elimina los campos editables de identidad. La revisión muestra código, apellidos y nombres y aula leídos del PDF, con únicamente **Confirmar libreta** y **Eliminar libreta**. Las libretas pendientes de una lectura anterior se reprocesan automáticamente desde su original conservado.

Validación del ajuste: `npm test` aprobó **81 pruebas**. `npm run build:web` y `npm run test:web` aprobaron el flujo completo de navegador, incluidos encabezados nativos sin dos puntos, encabezados rasterizados con las 45 notas nativas presentes, relectura de originales antiguos sin perder B/C, eliminación sin identidad, y restauración de respaldo mientras la revisión sigue abierta. La restauración no mantiene una identidad de una lectura obsoleta. No hubo solicitudes HTTP adicionales, errores de página ni errores de consola.

La prueba simultánea de varias instancias de OCR detectó saturación de OpenMP y expiraciones. Se limitó a un hilo cada proceso nativo de reconocimiento; la suite completa volvió a pasar en unos tres segundos, conservando las pruebas OCR reales. La edición de navegador conserva su reconocimiento local mediante WASM.

Los documentos de prueba son generados. Sigue pendiente recibir el PDF original mostrado por el usuario para verificar su formato concreto.

## Ajuste de libretas y tres bimestres

La prueba vigente es `npm run build:web && npm run test:web`, implementada en `tests/browser-adjustment.cjs`. Sirve únicamente el HTML generado, con un perfil de navegador aislado, y comprueba:

- Código, apellidos y nombres extraídos de PDF nativos con tres bimestres, lista automática y exclusión de aulas no habilitadas.
- Filtro exacto 2.º F, 3.º F y 4.º F, bloqueo previo y apertura de las tres áreas al confirmar.
- Académico automático con I–III y progresión del promedio I–II frente a III; B y C inicialmente vacíos.
- Captura manual de asistencia, concurso con puesto y representación, incumplimiento con observación/evidencia, validaciones y ranking.
- Excel con cuatro hojas, resultados esperados y registros pendientes separados.
- Nueva versión de libreta, duplicado, conservación de B/C, eliminación de ficha y todos los originales relacionados, y reimportación del mismo documento.
- Persistencia al reiniciar el navegador y ausencia de solicitudes HTTP a una API o a otros orígenes tras cargar el HTML.

Los scripts `tests/browser-web.cjs` y `tests/browser-smoke.cjs` conservan pruebas históricas de la primera versión. Los comandos npm `test:web` y `test:browser` ejecutan la prueba actual del ajuste. La validación matemática, SQLite y lectura PDF/OCR se ejecuta con `npm test`: 64 pruebas aprobadas en este ajuste, incluidas la protección de documentos reasignados a otro estudiante y la corrección de aula sin pérdida de datos manuales.

El flujo completo pasó en Chromium con datos ficticios: Académico 58,75 para notas C/B/A, Desempeño manual 95,50 y Compromiso manual 65,00. El total exportado coincide con su promedio. No hubo solicitudes HTTP adicionales, errores JavaScript ni errores de consola. También se verificaron bloqueo de modificaciones antes de confirmar, restauraciones con contenido adulterado y conflictos entre pestañas en una prueba aislada de la API local del navegador.

No se ha recibido una libreta real para verificar la diagramación institucional. El original y las observaciones permanecen disponibles para revisión.

## Registro histórico de la primera edición


La edición web usa el almacenamiento IndexedDB del navegador y procesa los documentos en el dispositivo. Esta validación es independiente de las pruebas de la edición con servidor y SQLite descritas en `VALIDACION.md`.

## Cómo repetir la prueba

Primero debe existir el archivo real `web/index.html`, generado por el proceso de compilación web. La prueba falla si el archivo falta: no crea una página ficticia ni utiliza el servidor de aplicación.

Para comprobar el archivo desde un origen web local, se sirve **únicamente** la carpeta de salida estática:

```sh
python3 -m http.server 4120 --bind 127.0.0.1 --directory web
```

En otra terminal:

```sh
APP_WEB_URL=http://127.0.0.1:4120/index.html node tests/browser-web.cjs
```

La prueba crea un perfil temporal nuevo de Chromium. No abre el perfil del operador ni usa sus registros institucionales. `CHROMIUM_PATH` permite indicar otro ejecutable. `KEEP_BROWSER_WEB_PROFILE=1` conserva el perfil temporal para diagnóstico.

El servidor anterior solo entrega archivos; no es una API ni un servidor de procesamiento de la aplicación. Después de cargar el documento, la prueba pone Chromium sin conexión durante la edición, la lectura PDF/OCR y las descargas. La conexión se permite otra vez únicamente para recargar el HTML estático y volver a abrir el navegador.

## Alcance de la prueba automatizada

`tests/browser-web.cjs` comprueba:

- Creación de la base IndexedDB en un perfil vacío.
- Registro manual y validación de las tres dimensiones, con 60 calificaciones A y puntaje académico de 75,00.
- Guardado automático, historial, recarga y conservación íntegra del estado después de cerrar y volver a abrir Chromium con el mismo perfil.
- Diez PDF de texto en una sola selección, identificación de sus estudiantes y conservación de los valores reconocidos como provisionales.
- Detección de duplicados y reemplazo explícito de una libreta con trazabilidad.
- Vista previa del original mediante una URL Blob local.
- Reconocimiento OCR español de un PDF mixto que combina cabecera digital y notas escaneadas.
- Descarga de plantilla CSV y de Excel; lectura del archivo Excel con ExcelJS para verificar sus cuatro hojas, puntajes y separación de pendientes.
- Copia de seguridad con integridad SHA-256 de cada PDF, alteración posterior de la base y restauración exacta del estado y de los documentos.
- Separación entre los registros del espacio real y los datos ficticios de demostración.
- Ausencia de solicitudes HTTP a `/api` y ausencia de solicitudes HTTP a otros orígenes.

El resultado de una ejecución correcta se guarda en `/tmp/circulos-web-result.json` y su captura en `/tmp/circulos-web.png`. Un fallo produce diagnóstico de solicitudes, errores JavaScript y una captura `/tmp/circulos-web-error.png`.

## Archivo local y límites de la comprobación

`CHECK_FILE_OPEN=1` añade un intento de abrir `web/index.html` mediante `file://`. Si una política del Chromium gestionado lo impide con `ERR_BLOCKED_BY_ADMINISTRATOR`, la prueba lo registra por separado; no modifica ni elude la política. Un resultado correcto bajo un origen HTTP estático no demuestra por sí solo que `file://` esté permitido en otros equipos.

No se ha recibido una libreta institucional real de muestra. Los PDF utilizados por esta prueba son ficticios y verifican el mecanismo de importación, revisión y OCR; todavía debe comprobarse el diseño concreto de las libretas del colegio. Los valores reconocidos requieren revisión visual.

Una prueba local tampoco demuestra publicación de un sitio público ni disponibilidad de un enlace de producción.

## Resultado de esta entrega

**Aprobado.** `tests/browser-web.cjs` terminó con código de salida 0 sobre el HTML definitivo de 10 264 458 bytes. SHA-256 del archivo comprobado:

```text
a6953d63a63b0b19dab19da729fcf0586d86224009af6f628e1138824985ea53
```

Se verificaron las tres dimensiones manuales, la recarga, diez PDF en lote, un duplicado, un reemplazo, OCR del PDF mixto, plantilla CSV, Excel con las cuatro hojas y valores esperados, respaldo con integridad de los PDF, restauración exacta y separación del espacio de demostración. Se completaron 15 descargas. No hubo solicitudes HTTP a una API ni a otros orígenes, solicitudes fallidas ni excepciones JavaScript. El servidor estático respondió 404 al favicon opcional en dos aperturas; esto no afectó los flujos.

Después de cerrar y volver a abrir Chromium con el mismo perfil se comprobó la igualdad del estado almacenado realmente en IndexedDB, la ficha con académico 75,00 y la disponibilidad de los originales PDF mediante URL Blob. No se descargaron archivos en esta segunda sesión: el Chromium gestionado de la máquina terminó con `SIGTRAP` al descargar después de reabrir un perfil en una reproducción mínima independiente. Las comprobaciones de descarga se completaron antes del reinicio; esta limitación del ejecutor se conserva explícitamente y no se ocultó con opciones de seguridad.

La apertura mediante `file://` fue bloqueada por la política del Chromium gestionado (`ERR_BLOCKED_BY_ADMINISTRATOR`). La validación aprobada corresponde al origen HTTP estático indicado, con el navegador sin conexión para los flujos funcionales; no establece que un archivo local pueda abrirse en cualquier equipo ni que se haya probado Windows.
