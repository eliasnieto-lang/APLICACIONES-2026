# Secciones A–E y estudiantes sin concursos

## Desplegables de aulas

Las opciones actuales son **1.º a 5.º de secundaria**, con secciones **A, B, C, D y E**: 25 combinaciones. La importación y los criterios de Parámetros usan ese catálogo. Los filtros de Estudiantes y Ranking muestran únicamente las aulas A–E presentes en los datos.

Los expedientes y PDF cargados antes de esta corrección no se borran ni se cambian de aula. Los registros históricos F u otras secciones siguen accesibles en Todos y desde su ficha, aunque esas secciones ya no se ofrecen como opciones del desplegable. La identidad y aprobación de esos documentos se conservan. Los ejemplos nuevos de demostración utilizan aulas A–E, sin reescribir una demostración ya guardada.

## No participó en concursos

Cuando no hay concursos registrados, el botón **No participó en concursos** guarda una confirmación explícita del operador. No crea un concurso ficticio y no exige tipo, fecha ni ubicación. La vista muestra **No participó en concursos · PI: 0 puntos**, con **Deshacer confirmación**.

La confirmación equivale a participación institucional revisada, con **PI=0**, y no a “No aplica”. Por tanto, si Compromiso está incluida, el puntaje C todavía requiere los compromisos familiares y su validación final. Con CF100 y la ponderación interna vigente, C es30. Si Compromiso está excluida para ese estudiante, esta información se conserva sin intervenir en el total.

Deshacer devuelve la participación vacía a pendiente. Agregar un concurso retira la confirmación y recupera los requisitos normales de tipo, fecha y puesto. Ambas acciones invalidan la revisión final de C hasta confirmarla de nuevo. No se permite guardar simultáneamente la confirmación de ausencia y eventos registrados; no se eliminan concursos existentes automáticamente.

`Student.noContestParticipation` es un campo opcional compatible con respaldos anteriores, cuyo valor ausente equivale a false. Se conserva en guardados antiguos, historial, respaldo, restauración, reinicio y exportación Excel. La aplicación no lo marca automáticamente por encontrar una lista vacía: una lista sin revisar sigue pendiente.
