# Selección de textos escolares 2027 — I11 independiente

Cada docente puede puntuar, guardar y cerrar I11 sin iniciar Sala en vivo ni esperar
una confirmación administrativa, en Jornada real y en Demostración.

Sala en vivo usa una sola casilla que confirma que un representante docente hizo
la pregunta y la editorial respondió. Se guarda automáticamente, sin solicitar
nombre, área ni transcripciones. El turno conserva esa confirmación al finalizar;
marcarla, retirarla o borrarla no modifica las notas docentes ya registradas.

Se conservan la escala 0–4, once criterios de igual peso (máximo 44 y nota /100),
las referencias a la guía MINEDU y los 70 puntos solo informativos. La valoración
docente orienta la clasificación de tres propuestas; las familias realizan la elección.
También se conservan sorteo, cronómetro, seguimiento, eliminación administrativa,
ranking y votación A5. Los datos anteriores mantienen sus valores e historial.

Fuente, manual y evidencia:
https://github.com/eliasnieto-lang/APLICACIONES-2026/tree/b14458301e555bd7e8c0865099fd29527f2a19a7

Ejecutar como propietario de Supabase ANTES de activar esta rama:
https://raw.githubusercontent.com/eliasnieto-lang/APLICACIONES-2026/b14458301e555bd7e8c0865099fd29527f2a19a7/supabase/migrations/006-confirmacion-simple-e-i11-independiente.sql
Instalar o repetir la actualización no borra datos.

Cloudflare Pages: rama compilada, comando vacío, raíz vacía, salida `.`. Sin Wrangler.
Después del despliegue, recargar los navegadores.
