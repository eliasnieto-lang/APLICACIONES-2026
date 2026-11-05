# Selección de textos escolares 2027 — votación por aula

Padrón con cinco secciones A–E por grado: P1=10 aulas, P2=20 y S1=15.
Cada aula tiene una ficha A5 personalizada con aula y folio corto, por ejemplo P1-01,
con opciones de Matemática y Comunicación. Las nuevas fichas no usan QR ni códigos largos.

El voto se transcribe manualmente seleccionando el aula y las dos opciones del papel.
Sin asistencia se registra por separado. Cada aula se cuenta una sola vez;
las correcciones antes del cierre conservan historial y no aumentan recibidas.
La tabla pública permite a las familias cotejar los votos registrados por aula.
Las fotos son un respaldo privado opcional que puede adjuntarse después del cierre.
El respaldo JSON incluye un manifiesto; las fotografías se descargan por separado.

Se conservan las votaciones anteriores, las notas y el historial sin reidentificarlos.
I11 sigue independiente de Sala, la escala es 0–4, máximo 44 y sin puntaje mínimo.
Las referencias MINEDU y los 70 puntos informativos se mantienen.

Fuente, manual y evidencia:
https://github.com/eliasnieto-lang/APLICACIONES-2026/tree/d9336b071026c5ccba7dcc4d9b691007110a0da5

Ejecutar como propietario de Supabase ANTES de activar esta rama:
https://raw.githubusercontent.com/eliasnieto-lang/APLICACIONES-2026/d9336b071026c5ccba7dcc4d9b691007110a0da5/supabase/migrations/007-padron-aulas-y-voto-manual.sql
Instalar o repetir la actualización no borra datos ni convierte los registros anónimos anteriores.

Cloudflare Pages: rama compilada, comando vacío, raíz vacía, salida `.`. Sin Wrangler.
Después del despliegue, recargar los navegadores.
