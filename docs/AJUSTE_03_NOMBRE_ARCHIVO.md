# Nombres desde el archivo PDF y edición de respaldo

Este cambio incorpora la última instrucción del usuario y sustituye la restricción de identidad de solo lectura del ajuste anterior. El código del estudiante deja de ser un requisito de importación y confirmación.

Ejemplo exacto proporcionado:

`BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf`

Resultado antes de confirmar:

- Apellidos y nombres: **SEGURA CAMONES ANDRES ADRIAN**.
- Aula: **2.º F**.
- Casillero de nombre editable para corregir o completar el dato.
- Botones **Confirmar libreta** y **Eliminar libreta**.

Se retira el prefijo de boleta, aula, nivel y extensión. Se conservan orden, tildes y apellidos compuestos. Una corrección manual guardada prevalece sobre una lectura posterior. Los nombres genéricos de archivo no se convierten en alumnos; si no hay un nombre fiable, el casillero permite introducirlo.

La identificación y la lista se generan antes de la confirmación. Confirmar habilita A/B/C y calcula únicamente A si sus notas están completas. No requiere código, año reconocido ni notas completas: las notas ausentes dejan Académico pendiente, sin impedir el registro del estudiante ni la apertura de las áreas.

Las aulas siguen restringidas a 2.º F, 3.º F y 4.º F. El nombre del archivo tiene prioridad sobre una identidad distinta extraída del contenido. Los registros antiguos se identifican desde su nombre conservado sin esperar OCR. La lectura de calificaciones continúa procesándose desde el PDF; el reconocimiento de metadatos no se fuerza si el archivo ya proporciona nombre y aula.

Cada estudiante mantiene una clave interna estable para persistencia, respaldos y compatibilidad de versiones. La interfaz no pide ni muestra esa clave como código. Los datos manuales de Desempeño y Compromiso se conservan. Las coincidencias ambiguas de nombres en una misma aula no se fusionan automáticamente.
