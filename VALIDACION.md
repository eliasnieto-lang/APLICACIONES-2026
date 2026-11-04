# Validación de Selección de textos escolares 2027

Fecha: 4 de noviembre de 2026. Código y tablas separados de Círculos de Estudios.

## Sorteo, cronómetro, seguimiento y votos A5

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite | Aprobados | `npm run build` |
| Node: dominio, acceso, sesiones, cifrado, importación, audio, PDF/XLSX y lectura de marcas | 97 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt), `npm test` |
| PostgreSQL/PostgREST aislados | 90 grupos aprobados: 20 históricos + 13 acceso + 21 exposición + 9 actualizaciones + 12 jornada + 15 papel | [Resumen](docs/pruebas-acceso-y-exposicion.txt), scripts de pruebas |
| Chromium sobre Node/Express + PostgreSQL + PostgREST reales | 17 recorridos aprobados: 9 de acceso/evaluaciones + 8 de jornada/A5; sin errores de ejecución ni CSP | [Evaluaciones](docs/pruebas-navegador.json), [Jornada y A5](docs/pruebas-jornada-real.json) |
| Chromium aislado, sala y audio instrumentado | 5 recorridos aprobados | [Resultado](docs/pruebas-sala-sorteo.json) |
| Chromium aislado, orden docente, ranking y seguimiento | 3 recorridos aprobados | [Resultado](docs/pruebas-jornada-vistas.json) |
| Chromium aislado, impresión, cola de fotos y revisión | 7 recorridos aprobados | [Resultado](docs/pruebas-papel-ui.json) |
| Instalación Docker y persistencia | Aprobadas | `scripts/local-start.sh` y pruebas de migración |

El sorteo es aleatorio en el servidor y congela un único orden para Subdirección, docentes y proyección. Solo puede repetirse antes de comenzar y con motivo documentado. Los turnos exigen una copia actual del reloj: un comando atrasado no finaliza la editorial siguiente. Tampoco se pueden incorporar editoriales nuevas mediante importación después de empezar. Las proyecciones enumeran los campos públicos del sorteo y excluyen el ranking privado y las fichas ajenas.

Los cinco casos unitarios de audio y la instrumentación Chromium verifican una señal al inicio, aviso a cinco segundos y alarma al finalizar, sin duplicados al pausar o actualizar. El sonido depende de la activación del usuario y de que Sala o Proyección permanezca abierta en el equipo con parlantes.

El ranking considera todas las fichas vigentes cerradas, conserva el cero y muestra provisional si hay pendientes. Su huella detecta modificaciones posteriores del catálogo, participantes, criterios o sorteo. El seguimiento separa criterios respondidos de fichas cerradas y admite cualquier número de docentes.

## Impresión y reconocimiento de votos

Las once pruebas de PDF A5 y lectura de marcas incluyen tamaño real 148 × 210 mm, ambas áreas, QR distinto por hoja, cuatro marcas con margen de impresión, PDF real rasterizado, X/relleno/lápiz, perspectiva, rotación de 90 grados, blanco, marca múltiple, marca tenue, recorte y QR ajeno. La lectura es OMR del formato generado por la app; no es OCR de papeletas arbitrarias.

Las fotos se procesan localmente. No se suben imágenes, nombres ni identidad de votantes. Las lecturas claras se pueden sumar inmediatamente; las dudosas requieren comparación y confirmación humana. La base solo guarda huellas de códigos y conteos agregados separados por área. Las pruebas de HTTP simultáneo confirman una sola suma por ficha; el cierre distingue ganador, empate y ausencia de votos válidos. Un respaldo anterior no puede reducir conteos ni desconsumir fichas.

## Conservación y alcance

La actualización `supabase/migrations/004-sorteo-seguimiento-voto-a5.sql` es idéntica al esquema actual y debe ejecutarse como propietario antes de activar la interfaz. Los archivos 002 y 003 se mantienen intactos. Las nueve pruebas instalan 002, preservan las fichas originales al pasar a 003, actualizan a 004 y comprueban que repetirla conserva datos, accesos, versiones, historial y el sorteo. Las fichas históricas 0–2 mantienen su rúbrica y porcentaje; las actuales usan una descripción por criterio, 0–4, máximo 40 y suma × 2.5 para /100.

Las pruebas usan demostración o bases descartables y no se conectan a producción. La jornada real no recibió datos ficticios. Este informe no afirma que la actualización 004 ya se haya ejecutado en Supabase ni que el sitio público haya sido comprobado con esta versión; requiere su activación y el resultado del despliegue.

Cloudflare Pages y Supabase Free siguen siendo la alternativa gratuita dentro de las condiciones del proveedor. La lectura de fotos no usa servicios externos ni API de pago. Los respaldos administrativos contienen datos privados y deben conservarse con acceso restringido. Las decisiones y firmas formales siguen correspondiendo al centro.
