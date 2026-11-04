# Validación de Selección de textos escolares 2027

Fecha: 4 de noviembre de 2026. Aplicación nueva, separada de Círculos de Estudios.

## Resultados ejecutados

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite de producción | Aprobados | `npm run build` |
| Pruebas de dominio, importaciones, cliente, borradores cifrados y PDF/XLSX | 49 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt), `npm test` |
| PostgreSQL 16 y PostgREST 12, mediante HTTP real | 20 grupos aprobados | [Salida](docs/pruebas-sql.txt), `sh scripts/test-db.sh` |
| Aplicación completa en Chromium con Node/Express y PostgreSQL reales | 7 recorridos aprobados; 0 errores de ejecución del navegador | [Resultado](docs/pruebas-navegador.json), `tests/browser-local.mjs` |
| Sala, elección, cédula y comparación pública con API simulada | 22 comprobaciones aprobadas | Prueba complementaria de interfaz; no sustituye la prueba SQL |
| Instalación local Docker, migración repetible y solicitud de salud | Aprobadas | `scripts/local-start.sh`, servicio `seleccion-textos-2027`, base `ready` |

Los siete recorridos reales cubren identidad correcta de la aplicación, coordinación y jornada real vacía, importación CSV con confirmación, corrección documentada de expediente cerrado, dos docentes independientes, recuperación de borrador tras corte de red y cierre confirmado, privacidad de la sala pública en celular y descarga de ficha PDF.

Las pruebas SQL incluyen rechazo de acceso directo a tablas y funciones internas, permisos por rol, privacidad de fichas, control de versión entre pestañas, puntajes inválidos y pendientes, cierre y reapertura con historial, cálculos de 70/100 y 82,50, corte por grado, desempate I2 y revisión adicional comparable, incidencia formal 11.3, publicación autorizada, escrutinio conciliado por área, voto concurrente de uso único y reinicio real de PostgreSQL, segunda vuelta limitada al área empatada, respaldo/restauración, migración de ocho indicadores y protección contra reutilización de códigos.

La restauración se probó tanto sobre una base con votos posteriores conocidos como en una instalación real **aislada y descartable** sin historial previo. En la segunda, las rondas abiertas o en preparación se suspenden; los resultados cerrados se conservan. Nunca se cargaron estos datos en Supabase ni en la jornada real de desarrollo.

Los PDF se abrieron con `pdf-lib` y `pdftotext`: se verificaron A4, contenido, precios, votos y espacios de firmas, además de ausencia de datos privados en las cédulas. No se simularon firmas ni comunicaciones.

## Alcance y límites

- La publicación en la cuenta Cloudflare y la instalación en Supabase requieren los servicios de esa cuenta. Este informe confirma funcionamiento local; no constituye una comprobación del sitio público ni de una migración aún no ejecutada en Supabase.
- La URL, clave publishable y usuario autorizado de la instalación cloud corresponden al proyecto proporcionado por el usuario. No hay claves administrativas ni contraseñas personales en el código. Coordinación debe instalar `supabase/schema.sql` como propietario.
- La red local funciona sin Internet después de instalar las imágenes. El borrador persistente cifrado requiere HTTPS o localhost; en HTTP desde otro dispositivo se conserva en memoria y se informa esa condición.
- Las importaciones se previsualizan y no sobrescriben datos existentes. El servidor admite hasta 2000 filas por lote; divida las cargas mayores. Los archivos CSV/XLSX tienen un límite de 8 MB. El respaldo JSON se valida antes de aplicarse y las peticiones tienen un límite de 16 MB.
- El plan cloud es gratuito dentro de los límites y las condiciones de Cloudflare Pages/Supabase Free. El servidor local no depende de esas cuentas durante la jornada.
- `npm audit` detectó ocho avisos moderados transitivos relacionados con minimatch/glob en la cadena de ExcelJS/archiver; ninguno alto o crítico. Los patrones de archivos no proceden de usuarios y la interfaz usa la compilación de navegador de ExcelJS. La auditoría no se presenta como libre de avisos; las actualizaciones deben conservar las pruebas de importación y exportación.
- La comprobación de requisitos ministeriales y la revisión del ejemplar son humanas. El sistema registra fuentes y decisiones; no certifica consultas en OBNATE, no presenta expedientes ante entidades y no reemplaza firmas formales.

La base de jornada real inicia sin editoriales, textos, docentes, fichas ni votos ficticios. Los datos de ensayo viven en `demo`; las pruebas SQL crean su propia base descartable y la eliminan al terminar.
