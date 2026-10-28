# Áreas cursadas y validación con datos mínimos

Esta mejora incorpora las correcciones del usuario posteriores a concursos y escaneo.

## Áreas que se consideran

Una asignatura sin ninguna nota válida AD/A/B/C en I, II o III se considera no cursada para ese estudiante. No aparece en la vista previa ni en Académico, no agrega pendientes, no cuenta en el avance y no afecta G, R ni P. Las notas de IV por sí solas no vuelven aplicable un curso. El archivo, sus filas originales e historial se conservan en almacenamiento y respaldos.

Las áreas con alguna nota de I–III siguen siendo aplicables. Si les falta una nota, la lectura permanece incompleta: no se oculta el curso ni se inventan calificaciones. Si faltan cursos enteros en Ciencias o Letras, el cálculo usa los cursos y grupos disponibles sin tratarlos como cero. Sin ningún curso evaluable con notas, A queda pendiente y el avance académico no se convierte en 100 %.

Las áreas adicionales de la libreta siguen la misma regla de visibilidad. Los promedios personales y el Excel no incluyen los cursos totalmente vacíos. Los catálogos institucionales se conservan y no se borran asignaturas de otros estudiantes.

## Confirmación manual de Académico

Se añade **Validar manualmente las notas de esta área** para cada área aplicable completa y una confirmación final de Académico. Se pueden confirmar las notas reconocidas aunque la validación automática no haya quedado marcada. El acto se guarda en el historial y no modifica niveles de logro ni agrega notas.

La validación manual requiere que las notas de I–III del área aplicable estén completas; si la lectura de una asignatura parcialmente registrada aún tiene vacíos, debe reintentarse el escaneo. Las áreas totalmente vacías no exigen confirmación. La lectura de notas continúa siendo automática y sus celdas permanecen de solo lectura.

Los rescaneos automáticos no se disparan por tener marcas de validación pendientes ni por asignaturas totalmente vacías cuando existen notas leídas en otros cursos. Los controles manuales y el escaneo se coordinan para evitar que uno sobrescriba la revisión del otro.

## Incidencias

Para verificar una incidencia bastan una categoría válida, una fecha válida y una descripción. La medida aplicada y la evidencia o referencia documental son opcionales. La confirmación del registro disciplinario sigue siendo explícita.

Verificar la incidencia no inventa un descuento: si la categoría aún no tiene un descuento aprobado en Parámetros, la verificación se guarda y el puntaje disciplinario sigue pendiente de esa definición institucional.

## Compromiso

Un compromiso familiar o registro histórico se valida con actividad o nombre, fecha y estado (Cumplió, No cumplió, Justificada o No aplica). La justificación, observación y evidencia dejan de ser obligatorias incluso en los estados de incumplimiento, justificado y No aplica.

Un registro familiar nuevo creado expresamente se considera exigible de entrada, de modo que cumplir con los tres campos mínimos no requiera una cuarta acción para que se cuente. El operador conserva la opción de excluirlo; el estado No aplica mantiene su regla institucional. Los registros existentes no se crean ni se cambian automáticamente.

Concursos académicos conservan su mínimo anterior (tipo/alcance, fecha y ubicación), su escala 40/70/100 y PI por mejor resultado. No se cambia esa ponderación ni la asistencia.
