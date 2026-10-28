# Identidad automática y revisión con dos acciones

Documento histórico. La instrucción posterior en [AJUSTE_03_NOMBRE_ARCHIVO.md](AJUSTE_03_NOMBRE_ARCHIVO.md) prioriza el nombre del archivo, elimina el requisito de código y permite editar los apellidos y nombres.

Corrección solicitada después del primer ajuste: código, apellidos y nombres y aula deben proceder del PDF. La pantalla no muestra campos de identidad editables ni selectores de aula o de vinculación manual. Presenta los valores reconocidos y solo dos botones: **Confirmar libreta** y **Eliminar libreta**.

El lector reconoce etiquetas con y sin dos puntos, valores debajo de su etiqueta y encabezados en columnas. Distingue el código del estudiante del código modular del colegio y del DNI. Una cabecera escaneada también se procesa aunque las notas sean texto nativo. La combinación de texto y OCR conserva los valores nativos fiables y evita mezclar estudiantes o periodos distintos.

Los documentos pendientes que una versión anterior dejó sin identidad se vuelven a leer al abrir su revisión, usando el original que ya está guardado. Conservan identificador, archivo y checksum; las evaluaciones manuales de B y C se conservan. No hay bucle de relectura: cada documento se intenta una vez por apertura de Importación. Confirmar sigue siendo una acción explícita.

Si el documento no contiene una identidad legible o pertenece a otra aula, no se inventan nombres ni códigos y no se habilita la confirmación. Eliminar permanece como acción independiente de la confirmación y elimina la ficha vinculada y sus versiones conforme al primer ajuste.

La validación usa documentos generados con encabezados de tabla y PDF mixtos con cabecera rasterizada y notas nativas. Sigue pendiente recibir el PDF original de la captura del usuario para contrastar su diagramación específica.
