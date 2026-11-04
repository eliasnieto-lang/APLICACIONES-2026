# Validación de Selección de textos escolares 2027

Fecha: 4 de noviembre de 2026. Aplicación nueva, separada de Círculos de Estudios.

## Resultados de la actualización de acceso y evaluación de exposición

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite | Aprobados | `npm run build` |
| Pruebas Node de dominio, acceso, sesiones, cifrado, importación y PDF/XLSX | 66 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt), `npm test` |
| PostgreSQL/PostgREST histórico, acceso y exposición | 49 grupos aprobados: 20 + 13 + 16 | [Informe](docs/pruebas-acceso-y-exposicion.txt), scripts `test-db.sh`, `test-access-db.sh`, `test-presentation-db.sh` |
| Chromium contra Node/Express, PostgreSQL y PostgREST reales | 7 recorridos aprobados; 0 errores de ejecución | [Resultado](docs/pruebas-navegador.json), `tests/browser-presentation-local.mjs` |
| Interfaz de exposición y borradores con servidor simulado | 9 comprobaciones aprobadas | Complementarias a las pruebas de servidor |
| Instalación local Docker e idempotencia de la migración | Aprobadas | `scripts/local-start.sh` y reaplicación del esquema sobre registros existentes |

Los siete recorridos reales comprueban los dos botones de entrada, contraseña de Subdirector validada por servidor, registro de una editorial sin libros ni expedientes, cinco docentes sin contraseña con categorías múltiples, cierre de diez criterios observados, promedio 80 a partir de cinco notas 70/75/80/85/90, independencia de la segunda categoría y privacidad de la proyección en celular.

La actualización usa una ficha por docente, editorial, área y categoría. No exige registros OBNATE, precios, muestras de práctica ni expedientes precargados para evaluar la exposición y el texto físico. Las fichas por texto/grado anteriores se conservan en sus colecciones históricas y no se reutilizan como valoraciones de exposición.

Las pruebas SQL comprueban además que un sexto docente puede incorporarse sin cupo, que las publicaciones previas conservan su historial y se revisan para incorporar nuevas fichas, que el reingreso del mismo perfil no invalida publicaciones, y que la migración puede repetirse sin borrar datos, contraseñas verificadas, accesos ni historial. La contraseña de Subdirección no está en texto plano en el cliente, la configuración pública ni los archivos fuente.

Los PDF nuevos de exposición y las exportaciones XLSX se abrieron y verificaron. Las pruebas históricas de voto anónimo, doble envío, reinicio, conciliación, segunda vuelta y restauración siguen aprobadas. La jornada real permanece sin datos ficticios; todos los recorridos nuevos se ejecutaron en demostración o en bases descartables.

## Alcance y límites

- La publicación en la cuenta Cloudflare y la instalación en Supabase requieren los servicios de esa cuenta. La actualización se activa con el archivo completo `supabase/migrations/002-acceso-directo.sql`, idéntico al esquema actual y repetible sin borrar registros. Este informe confirma funcionamiento local; no constituye una comprobación del sitio público ni de una migración aún no ejecutada en Supabase.
- La URL, clave publishable y usuario autorizado de la instalación cloud corresponden al proyecto proporcionado por el usuario. No hay claves administrativas ni contraseñas personales en el código. Coordinación debe instalar `supabase/schema.sql` como propietario.
- La red local funciona sin Internet después de instalar las imágenes. El borrador persistente cifrado requiere HTTPS o localhost; en HTTP desde otro dispositivo se conserva en memoria y se informa esa condición.
- Las importaciones se previsualizan y no sobrescriben datos existentes. El servidor admite hasta 2000 filas por lote; divida las cargas mayores. Los archivos CSV/XLSX tienen un límite de 8 MB. El respaldo JSON se valida antes de aplicarse y las peticiones tienen un límite de 16 MB.
- El plan cloud es gratuito dentro de los límites y las condiciones de Cloudflare Pages/Supabase Free. El servidor local no depende de esas cuentas durante la jornada.
- `npm audit` detectó ocho avisos moderados transitivos relacionados con minimatch/glob en la cadena de ExcelJS/archiver; ninguno alto o crítico. Los patrones de archivos no proceden de usuarios y la interfaz usa la compilación de navegador de ExcelJS. La auditoría no se presenta como libre de avisos; las actualizaciones deben conservar las pruebas de importación y exportación.
- La comprobación de requisitos ministeriales y la revisión del ejemplar son humanas. El sistema registra fuentes y decisiones; no certifica consultas en OBNATE, no presenta expedientes ante entidades y no reemplaza firmas formales.

La base de jornada real inicia sin editoriales, textos, docentes, fichas ni votos ficticios. Los datos de ensayo viven en `demo`; las pruebas SQL crean su propia base descartable y la eliminan al terminar.
