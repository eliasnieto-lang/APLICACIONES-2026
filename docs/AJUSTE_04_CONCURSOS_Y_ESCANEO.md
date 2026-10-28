# Concursos académicos y lectura completa de las notas

El ajuste posterior [AJUSTE_05_AREAS_Y_VALIDACION.md](AJUSTE_05_AREAS_Y_VALIDACION.md) excluye cursos totalmente vacíos y simplifica las incidencias y los compromisos familiares.

Esta modificación incorpora las dos correcciones más recientes del usuario.

## Participación institucional

El único tipo de participación nuevo es **CONCURSOS ACADÉMICOS**. El control de tipo de evento permite elegir el alcance y su puntaje:

| Alcance | Puntaje sobre 100 |
| --- | ---: |
| Local | 40 |
| Regional | 70 |
| Nacional | 100 |

Para confirmar un registro solo son obligatorios el tipo de evento (con su alcance), una fecha válida y la ubicación o puesto. El nombre específico del concurso, observaciones, evidencia, representación del colegio y demás datos quedan opcionales. La interfaz no exige otra casilla para habilitar la validación.

Participación institucional usa el mejor resultado registrado, sin sumar concursos de menor alcance para superar uno nacional. Un incumplimiento explícito puntúa cero; los estados justificado y No aplica conservan el tratamiento institucional. Los valores pueden verse provisionales antes de validar los registros, pero el ranking conserva sus requisitos de validación.

Los registros históricos se conservan. Cuando se mezclan registros antiguos sin clasificación con nuevos concursos, se pide clasificarlos expresamente antes de emitir PI y C definitivos. La corrección no convierte otros eventos antiguos en concursos ni inventa sus alcances. Los compromisos familiares conservan sus reglas de fecha y evidencia.

## Notas leídas del PDF

Las calificaciones de Académico son de solo lectura. Las notas se extraen del PDF, y el cálculo se actualiza automáticamente; no se presentan casilleros para introducir niveles de logro manualmente.

El lector admite tablas compactas en las que área y primera competencia comparten fila, etiquetas y columnas de área partidas en varias líneas, celdas de notas dibujadas por separado y columnas I–IV con vacíos. Se evalúan únicamente I, II y III, conservando cada posición. No se rellenan valores ilegibles ni se desplazan las notas cuando una celda está vacía.

Si el texto del PDF no permite reconocer las notas, se representa la página para aplicar OCR local aunque el PDF no contenga una imagen escaneada. Un documento aprobado con notas incompletas se vuelve a escanear una vez al abrir su ficha con esta versión. **Volver a escanear notas** permite reintentar; una lectura incompleta conserva sus pendientes.

Se capturan también Inglés, Educación Física, Arte y Cultura, Educación Religiosa y Educación para el Trabajo cuando aparecen en la libreta. Los documentos de prueba con diez áreas contienen **78 notas de I–III**, que quedan almacenadas y visibles. Estas áreas adicionales no alteran automáticamente la lista de áreas elegibles ni los criterios ya configurados para G y R.

La actualización de notas utiliza el original conservado. Mantiene su identificador, hash, nombre, aula, aprobación y todos los datos manuales de B y C. Las notas anteriores procedentes del mismo documento pueden completar vacíos de una nueva lectura; los antiguos ajustes manuales de A no se usan como fuente del escaneo. Las áreas adicionales sobreviven a respaldos, restauración y Excel.

Las pruebas usan PDF reales generados con tablas compactas y texto vectorial, además de documentos escaneados. No se ha recibido todavía el PDF original de las capturas del usuario: falta contrastar su diagramación y calidad concretas. El archivo cargado en la versión web permanece en el navegador del operador y no llega automáticamente a este chat.
