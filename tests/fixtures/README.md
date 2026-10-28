# PDF de prueba

`scanned.pdf` contiene una imagen con datos totalmente ficticios (`SC-001`, Ana Pérez), sin capa de texto. Comprueba que se ejecutan realmente la rasterización y el OCR. Se generó con Pillow y ReportLab durante el desarrollo; estas bibliotecas no se necesitan para ejecutar la aplicación ni las pruebas.

La prueba de lectura nativa genera su PDF directamente en TypeScript. Ninguna prueba transmite documentos a un servicio externo.

`mixed.pdf` combina una cabecera de texto nativo de más de 100 caracteres con una imagen de la misma libreta ficticia. Verifica que la presencia de texto nativo no impida el OCR de las notas escaneadas.
