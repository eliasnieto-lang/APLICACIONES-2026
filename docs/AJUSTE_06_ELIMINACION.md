# Eliminación individual y limpieza de la evaluación

Se incorporan dos controles para retirar las pruebas cargadas y preparar un nuevo proceso. Están disponibles con la evaluación abierta o cerrada.

## Desde la ficha

**Eliminar estudiante** aparece al final de cada ficha. El diálogo identifica al estudiante, el aula y el espacio seleccionado, y permite cancelar o descargar una copia de seguridad. Confirmar elimina el expediente completo: evaluaciones, registros manuales, historial, libreta original, versiones anteriores y copias duplicadas vinculadas. Los expedientes y PDF pertenecientes a otros estudiantes se conservan.

La acción también funciona con estudiantes sin PDF. El original eliminado puede volver a importarse como una nueva libreta, sin recuperar la evaluación anterior.

## Desde el panel principal

**Eliminar todos los datos de evaluación** muestra cuántos estudiantes y libretas se borrarán en el espacio seleccionado. Exige escribir exactamente `ELIMINAR TODO` y confirmar. Se eliminan todos los expedientes, evaluaciones, registros manuales, historial y PDF de ese espacio, incluidos los documentos pendientes, duplicados o sin estudiante y los archivos huérfanos.

Los parámetros institucionales se conservan. Solo se desactiva el cierre para dejar listo el siguiente proceso. Limpiar los datos reales no modifica demostración, y limpiar demostración no modifica los datos reales.

## Guardado y confirmación

Los controles esperan a que terminen el autoguardado y el escaneo en curso antes de presentar la confirmación. El diálogo queda asociado al espacio mostrado; cambiar de espacio cancela la confirmación pendiente. Durante la eliminación se bloquean las acciones incompatibles y se descartan respuestas antiguas para evitar que vuelvan a aparecer registros eliminados.

La confirmación puede cancelarse sin cambios. Descargar un respaldo es opcional y no elimina datos. Después de confirmar, la recuperación requiere un respaldo anterior; el diálogo explica el alcance antes de ejecutar la acción.

La edición web elimina el estado y los archivos en una transacción IndexedDB y retira sus URL temporales. La edición de servidor ejecuta la limpieza en una transacción SQLite. Ambas comprueban confirmaciones desactualizadas y conservan intacto el otro espacio.
