# Validación de la edición web

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
