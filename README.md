# Círculos de Estudios 2027 · Colegio Albert Einstein

Aplicación web en español para evaluar la permanencia en los Círculos: rendimiento académico (A), desempeño estudiantil (B) y compromiso institucional y familiar (C). La implementación sigue la [cartilla adjunta](docs/requisitos-cartilla.txt) con el [primer ajuste solicitado](docs/AJUSTE_01_LIBRETAS.md). Abre directamente el panel, sin pantalla de acceso.

## Edición web sin instalaciones

La edición para navegador reutiliza la interfaz, las fórmulas y las validaciones, y guarda expedientes y PDF en IndexedDB. Incluye lectura PDF, OCR español, exportación Excel y respaldo/restauración sin depender de Docker ni de un servidor de la aplicación. Consulta [la edición web y su publicación](docs/WEB.md).

Para construirla se ejecuta `npm run build:web`. El resultado `web/index.html` contiene los programas, estilos, logo, workers, WASM y modelo OCR en un único documento. La fuente se conserva en `main`; la distribución para GitHub Pages se publica en la raíz de `gh-pages`. La cuenta propietaria debe activar esa rama en Settings → Pages antes de que exista una dirección pública activa.

Los datos pertenecen al navegador del operador. No se sincronizan automáticamente entre dispositivos: utiliza los respaldos para trasladarlos. El modo privado o borrar los datos del sitio puede eliminar los registros locales.

## Edición de servidor y uso local

La visualización de un archivo `index.html` dentro del chat no ejecuta el servidor Express, SQLite ni el lector PDF. El puerto de la máquina de desarrollo tampoco constituye un enlace accesible desde tu computadora. Publicar el entorno de desarrollo conserva ese entorno; el alojamiento web de la aplicación es una operación distinta.

Para usarla en tu computadora, instala y abre Docker Desktop, descomprime el paquete completo y ejecuta **ABRIR_APP_WINDOWS.bat** en Windows, o `bash abrir-app.sh` en Linux/macOS. El lanzador construye los componentes, espera a que la aplicación esté lista y abre tu navegador. **DETENER_APP_WINDOWS.bat**, o `docker compose stop`, detiene la aplicación sin borrar el volumen de datos. La primera instalación requiere Internet.

El paquete se genera con `python3 scripts/package-release.py` en `entregables/Circulos_2027_Aplicacion.zip`. Usa una lista explícita de archivos y excluye los datos reales, credenciales, Git y caches de desarrollo. Para un enlace web compartido, utiliza el Dockerfile en un alojamiento elegido con almacenamiento persistente en `/app/data`; no se ha realizado ese despliegue.

## Iniciar

Requisitos: **Node.js 24 o superior**, npm, `poppler-utils` (`pdftotext`, `pdfinfo`, `pdftoppm`), `tesseract-ocr`, `curl` y `sha256sum`. Ya están disponibles en este entorno. En Debian/Ubuntu, los paquetes del sistema los instala un administrador con `apt-get install poppler-utils tesseract-ocr curl coreutils`.

```bash
cd /workspace/APLICACIONES-2026
bash scripts/setup.sh
npm run dev
```

El modo desarrollo sirve la interfaz en el puerto **5173**, con proxy de la API al **3001**. `npm run build` comprueba TypeScript y compila la interfaz. Para usar la compilación de producción, detén primero el servidor de desarrollo y ejecuta:

```bash
npm run build
npm start
```

Producción sirve la aplicación y la API en el puerto **3001**. `PORT` cambia ese puerto y `DATA_DIR` cambia el directorio persistente (predeterminado: `data/` dentro del repositorio). No se necesitan cuentas de servicios, claves API ni acceso a servicios de OCR externos.

`scripts/setup-ocr.sh` instala el modelo español de Tesseract en `.tools/tessdata/`, desde una revisión inmutable del repositorio oficial y con verificación SHA-256. Es idempotente y no requiere permisos de administrador. La aplicación puede recurrir al OCR inglés del sistema si ese modelo no está disponible, mostrando una advertencia.

## Flujo de trabajo

1. Revisa **Parámetros**: año, áreas y competencias, descuentos aprobados, pesos, tratamiento de “No aplica” y actividades de referencia. Solo están habilitadas 2.º F, 3.º F y 4.º F. Los cinco grupos necesarios para Ciencias y Letras son obligatorios. Agrega las demás áreas elegibles de la libreta para que G refleje el catálogo institucional completo.
2. Carga varios PDF a la vez en **Importar libretas**. Se procesan en lotes de diez y se conserva cada original. Código, apellidos y nombres reconocidos generan automáticamente la lista si el aula está habilitada. Una identidad incompleta o un aula distinta queda en revisión sin crear ficha; puedes corregir los datos contrastando el original. Los duplicados se detectan por SHA-256 y los reemplazos mantienen trazabilidad.
3. Contrasta identidad y notas con el PDF y pulsa **Confirmar libreta y habilitar evaluación**. Se abren Académico, Desempeño y Compromiso; solo Académico se carga y calcula automáticamente, usando I, II y III. Si faltan notas, corrige las casillas y confirma las áreas pendientes. El texto extraído se conserva. **Eliminar libreta y ficha** elimina el estudiante y todas sus versiones de PDF, previa confirmación.
4. Completa asistencia, días formalmente eximidos, puntualidad y disciplina. “Sin incidencias” requiere confirmación expresa. Cada incidencia verificada requiere fecha, categoría, descripción, medida y evidencia.
5. Desempeño y Compromiso comienzan vacíos. Registra manualmente asistencia, disciplina, participación y familia con fecha, exigibilidad, estado, observación y evidencia. Para concursos indica nombre, ubicación/puesto y si representa al colegio. **Registrar incumplimiento** permite documentar lo negativo del compromiso. La pauta de referencia no crea registros automáticamente.
6. Valida cada dimensión. Los cambios guardados recalculan puntajes e invalidan las confirmaciones afectadas. El historial conserva el antes y el después. La aprobación institucional de los criterios se realiza explícitamente en Parámetros.
7. **Generar ranking consolidado** descarga un XLSX con **RANKING**, **DETALLE**, **PENDIENTES** y **CONFIGURACIÓN**. Grado y sección definen cohortes comparables con posiciones independientes. Los empates a dos decimales comparten posición. Los expedientes pendientes aparecen únicamente en PENDIENTES.
8. El cierre bloquea la edición de registros y criterios. Reabrir exige confirmación explícita. Los resultados apoyan la revisión institucional y no emiten una decisión automática de exclusión.

La importación Excel/CSV de asistencia usa las columnas `codigo,dias,eximidos,asistencias,puntuales`; `dias` son días lectivos brutos y `eximidos` se restan para obtener días exigibles. Descarga la plantilla desde Importación. Las filas erróneas se informan sin inventar datos.

## Fórmulas y datos faltantes

El motor compartido está en [`shared/calculations.ts`](shared/calculations.ts), utilizado por la interfaz, el servidor y la exportación. No se redondean cálculos intermedios. AD/A/B/C equivalen a 4/3/2/1; primero se promedian competencias por área y bimestre y después se asigna el mismo peso a cada área.

- `A = 0,40 G + 0,40 R + 0,20 P` inicialmente; sus pesos internos son configurables.
- `B = 0,60 AP + 0,40 D` inicialmente. Una tardanza no se vuelve a descontar en disciplina.
- `C = 0,70 PI + 0,30 CF` es una propuesta que requiere aprobación institucional.
- `TOTAL = (A + B + C) / 3`, siempre con peso igual de las tres dimensiones.

Solo se evalúan I, II y III: `S1 = promedio de I–II`, `S2 = III`. En R, Ciencias pesa 60 % y Letras 40 % inicialmente. Las notas históricas de IV en respaldos se conservan, pero no participan en el cálculo. Las tres dimensiones permanecen bloqueadas hasta confirmar la libreta.

Las casillas vacías permanecen pendientes. Una dimensión incompleta impide calcular el total; un puntaje calculable pero sin revisión se presenta provisional y no clasifica. El avance mide casillas/registros validados, independientemente del puntaje. Un avance del 100 % todavía requiere las tres confirmaciones finales y criterios aprobados.

Cuando PI o CF no tienen obligaciones exigibles, se muestra “No aplica”. Por defecto C permanece pendiente. La institución puede aprobar una regla común que use el otro subcomponente si solo uno no aplica. Si ambos no aplican, C permanece pendiente. Cero asistencias tampoco genera automáticamente una puntualidad artificial; requiere resolver esa excepción.

## Persistencia, respaldo y demostración

SQLite guarda expedientes, configuración, historial y PDF originales en `data/circulos.sqlite`. El navegador solo representa los datos; cerrar o recargar no borra los registros. Conserva el directorio `data/` en un volumen persistente al desplegar. No borres la base para actualizar la aplicación.

El icono **Copia de seguridad** descarga JSON con el estado y todos los originales en base64. **Restaurar** valida el esquema, las referencias y los checksums antes de reemplazar el espacio seleccionado en una transacción. Descarga siempre un respaldo actual antes de restaurar. Reabre una evaluación cerrada antes de restaurar. Los respaldos reales y de demostración no se pueden mezclar. El espacio tiene un límite de respaldo de 512 MB: una operación que lo excedería se rechaza antes de guardarse, para conservar la posibilidad de restauración.

**Explorar demostración** usa un espacio independiente con ocho estudiantes ficticios. Sus fichas quedan pendientes de libreta y no tienen Desempeño ni Compromiso precargados. La base real comienza vacía y sin criterios aprobados.

La ausencia de inicio de sesión responde a la cartilla. Para datos personales reales, sirve la aplicación en una red institucional controlada o detrás del control de acceso de la infraestructura. No hay autorización por usuario ni identidad de operador en el historial; este registra fecha y valores modificados.

## Reconocimiento PDF y límites

El lector combina Poppler y OCR local en español. Reconoce metadatos etiquetados, nombres/alias de áreas del catálogo y filas de competencias con tres o cuatro niveles explícitos; solo importa I–III. Las filas desconocidas, repetidas o ilegibles quedan para revisión. **No se ha recibido una libreta escolar real para validar su diagramación institucional**: el parser genérico no garantiza extracción perfecta en cualquier plantilla. La transcripción manual y el contraste con el original están disponibles aunque no se reconozcan notas.

Límites por documento: 20 MB, 20 páginas de texto u 8 páginas para OCR y 3 minutos de reconocimiento. El PDF se procesa en la máquina; no se envía a un proveedor externo. Las evidencias de asistencia, incidencias y compromisos se registran como referencias documentales o enlaces; el respaldo integra los PDF escolares subidos, no los documentos alojados en esos enlaces externos.

## Verificación

```bash
npm test
npm run build
```

Las pruebas incluyen todos los ejemplos numéricos de la cartilla, incompletos, empates, no aplicabilidad, criterios de cohorte, persistencia tras reinicio, diez PDF simultáneos, duplicados, PDF escaneado con OCR real, exportación Excel y respaldo/restauración con integridad. Las fixtures son ficticias.

También existe una prueba de navegador en `tests/browser-smoke.cjs`, para una instancia de prueba abierta con base vacía. Playwright está fijado como dependencia de desarrollo y el entorno ya proporciona Chromium. Inicia una instancia con `DATA_DIR` temporal y ejecuta `APP_URL=<dirección de la instancia> npm run test:browser`; `CHROMIUM_PATH` permite indicar otra instalación de Chromium. Crea y limpia un estudiante ficticio, comprueba las tres dimensiones, autoguardado, recarga, filtros, descargas y navegación a 390 px. No la ejecutes sobre datos institucionales.

## Organización

- `src/`: panel, listado, fichas, importación, ranking y parámetros.
- `shared/`: tipos, cálculos y datos de demostración.
- `server/`: API, validación, SQLite, PDF/OCR y XLSX.
- `scripts/`: instalación repetible y modelo OCR verificado.
- `tests/`: aceptación matemática, integración API y navegador.

La publicación de la fuente y la distribución en GitHub no equivale por sí sola a habilitar un sitio web. El estado de acceso debe comprobarse después de activar el alojamiento. La edición de servidor y sus herramientas locales se conservan como alternativa para una base central compartida.
