# Validación de la edición web

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
