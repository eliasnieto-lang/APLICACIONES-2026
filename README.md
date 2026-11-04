# Selección de textos escolares 2027

Sitio compilado de I.E.P. Albert Einstein de Huaraz. Esta es la aplicación de selección de textos; el código y los datos de Círculos conservan su historial y sus tablas separadas.

Código fuente, migraciones, manual y pruebas: https://github.com/eliasnieto-lang/APLICACIONES-2026/tree/2396ff061711e3d87049e027e9c775241980a4d9

Antes del primer acceso, instalar como propietario en Supabase SQL Editor el archivo completo:
https://raw.githubusercontent.com/eliasnieto-lang/APLICACIONES-2026/2396ff061711e3d87049e027e9c775241980a4d9/supabase/schema.sql

Cloudflare Pages en esta rama compilada: comando de compilación vacío, raíz vacía y salida `.`. No se necesita Wrangler ni npm en esta rama. La publicación automática debe usar `web-evaluaciones-compartida`.

Coordinación usa el usuario de Authentication existente; docentes y secretaría usan sus códigos individuales. La jornada real inicia vacía; los datos ficticios se cargan en Demostración desde Coordinación.

Compilación fuente: 2396ff061711e3d87049e027e9c775241980a4d9
