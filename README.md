# Selección de textos escolares 2027 — jornada y votos A5

Sorteo aleatorio en servidor de las editoriales registradas, con un orden guardado
que comparten Subdirección, docentes y proyección. Turnos protegidos frente a controles
atrasados; pitido al iniciar, aviso a cinco segundos y alarma al terminar.

Panel del Subdirector: Ranking / Top al terminar las exposiciones; Docentes y avance
con porcentajes de criterios guardados y fichas cerradas por separado.

Votación de padres: una ficha A5 de tamaño real con Matemática y Comunicación de la
misma categoría, casillas para marcar, código anónimo único y cuatro marcas de registro.
Las fotos se leen localmente: las claras se pueden contar de inmediato y las dudosas
pasan a revisión. Una ficha repetida solo cuenta una vez. No se guardan fotografías
ni identidades de votantes. El PDF se genera desde la aplicación para cada lote.

Fuente, manual y evidencia:
https://github.com/eliasnieto-lang/APLICACIONES-2026/tree/e5a9fe8c3506c6d1642c882aadaceea0abb82d5e

Antes de activar esta rama, ejecutar la actualización completa como propietario de Supabase:
https://raw.githubusercontent.com/eliasnieto-lang/APLICACIONES-2026/e5a9fe8c3506c6d1642c882aadaceea0abb82d5e/supabase/migrations/004-sorteo-seguimiento-voto-a5.sql
La actualización conserva datos, fichas, accesos e historial y puede repetirse.
Después del despliegue, recargar los navegadores.

Cloudflare Pages: rama compilada, comando vacío, raíz vacía, salida `.`. Sin Wrangler.
