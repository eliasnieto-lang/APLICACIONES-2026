# Validación de la aplicación

Comprobaciones realizadas el 27 de octubre de 2026 sobre una instancia local de producción, con una base SQLite temporal independiente de la instancia principal. Los estudiantes utilizados son ficticios; el registro creado por la prueba se elimina al finalizar.

## Prueba funcional en navegador

Resultado: **aprobada**, sin excepciones JavaScript.

| Flujo | Evidencia comprobada |
| --- | --- |
| Registro | Crear estudiante desde el formulario y abrir su ficha. |
| Académico | Editar 60 casillas con nivel A; confirmar las cinco áreas y la validación final; puntaje académico 75,00. |
| Desempeño | Registrar 200 días, 190 asistencias y 171 ingresos puntuales; validar asistencia y confirmar “Sin incidencias”; completar la validación de B. |
| Compromiso | Crear una convocatoria y un compromiso familiar, registrar cumplimiento y evidencia, confirmar ambos registros y validar C. |
| Autoguardado y trazabilidad | Esperar confirmación de guardado, comprobar historial y recuperar los cambios después de recargar. |
| Revisión posterior | Cambiar una nota invalida su área y la validación académica; conserva las confirmaciones de las otras dimensiones. |
| Búsqueda | Escribir el código completo sin pérdida de caracteres ni foco. |
| Descargas | Descargar desde la interfaz el ranking XLSX y la copia de seguridad JSON. |
| Demostración | Confirmar separación de estudiantes reales y ficticios. |
| Parámetros | Añadir un tipo de actividad por la interfaz, guardar y verificar su persistencia. |
| Restauración | Seleccionar el JSON en la interfaz, confirmar la restauración y comprobar igualdad completa del estado con el respaldo original. |
| Móvil | Vista de 390 píxeles sin desbordamiento horizontal de la página; abrir menú y navegar a Estudiantes. Las tablas conservan desplazamiento propio. |

La prueba automatizada reproducible se encuentra en `tests/browser-smoke.cjs`. La comprobación de guardado de parámetros y restauración también se ejecutó por navegador en la instancia aislada; el script principal conserva intactos los parámetros existentes.

```sh
npm run build
PORT=4117 DATA_DIR=/tmp/circulos-browser-test npm start
```

En otra terminal, con Playwright y Chromium disponibles:

```sh
node tests/browser-smoke.cjs
```

`APP_URL` y `CHROMIUM_PATH` permiten señalar otra instancia **aislada** y el ejecutable de Chromium. La prueba presupone que la evaluación está abierta. No debe ejecutarse sobre datos institucionales en uso.

## Otras pruebas

La comprobación final ejecutó `npm test` con **43 pruebas aprobadas, ninguna fallida, omitida o pendiente**, y `npm run build` aprobó tipos y compilación. `npm audit` no informó vulnerabilidades en las dependencias instaladas. El script de navegador se repitió contra la compilación final en otra instancia aislada (puerto 4118), con 60 casillas, tres dimensiones validadas, dos descargas y cero excepciones JavaScript.

`npm test` ejecuta las pruebas matemáticas, las integraciones de API y los casos de lectura PDF/OCR. Incluyen los valores de aceptación de la cartilla, diez PDF en una sola carga, duplicados, conservación de originales, persistencia después de reiniciar SQLite, los cuatro nombres de hoja del Excel, separación de pendientes, restauración y bloqueo tras cierre. El resultado vigente debe consultarse en la salida del comando; este documento no sustituye su ejecución.

## Pendientes para uso institucional

- No se recibió una libreta real de muestra. El extractor genérico y el OCR se probaron con PDF ficticios, incluido un escaneo; aún debe comprobarse el diseño concreto de las libretas institucionales. Los valores reconocidos quedan provisionales para revisión humana.
- Los pesos propuestos, los descuentos disciplinarios y la regla común de “No aplica” requieren confirmación institucional en Parámetros. Los datos reales no parten con esta aprobación.
- Estas comprobaciones corresponden a la máquina actual y a una instancia de prueba aislada. No prueban publicación, despliegue público ni restauración del entorno en una nueva tarea.

## Paquete para Windows con Docker Desktop

El error de la visualización «Index» corresponde a intentar abrir el proyecto dentro de una vista que no ejecuta el servidor y la base de datos. El acceso desde Windows se proporciona mediante un ZIP completo, Docker Desktop y `ABRIR_APP_WINDOWS.bat`.

Se construyó la imagen desde el Dockerfile y se comprobó Docker Compose en un proyecto temporal independiente, con el puerto 3041 limitado a la propia máquina. La aplicación respondió correctamente con usuario sin privilegios, sistema de archivos de solo lectura y volumen persistente. Se verificaron OCR en español de un PDF mixto, integridad SHA-256 del original, Excel de cuatro hojas y restauración exacta del respaldo. Después de eliminar y recrear el contenedor conservando el volumen, los registros y el PDF de prueba permanecieron intactos. Al finalizar se retiraron únicamente los recursos ficticios de ese proyecto.

Los lanzadores Windows se revisaron estáticamente, incluidas rutas con espacios y terminaciones CRLF dentro del ZIP. No se ejecutó una interfaz Windows en esta máquina Linux. El equipo del usuario debe disponer de Docker Desktop abierto; la primera instalación descarga los componentes. No se creó un enlace público de la aplicación.
