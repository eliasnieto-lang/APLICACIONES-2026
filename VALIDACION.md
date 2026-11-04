# Validación de Selección de textos escolares 2027

Fecha: 4 de noviembre de 2026. Código y tablas separados de Círculos de Estudios.

## Confirmación simple y valoración I11 independiente

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite | Aprobados | `npm run build` |
| Node: dominio, acceso, sesiones, cifrado, importación, audio, PDF/XLSX y lectura de marcas | 112 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt), `npm test` |
| PostgreSQL/PostgREST aislados | 98 grupos aprobados para esta actualización: 25 exposición + 16 actualizaciones + 12 jornada + 15 papel + 13 preguntas + 17 eliminación | [Resumen](docs/pruebas-acceso-y-exposicion.txt), scripts de pruebas |
| Chromium sobre Node/Express + PostgreSQL + PostgREST reales | 25 recorridos aprobados: 10 de acceso/evaluaciones + 8 de jornada/A5 + 7 de eliminación; sin errores de ejecución ni CSP | [Evaluaciones](docs/pruebas-navegador.json), [Jornada y A5](docs/pruebas-jornada-real.json), [Eliminación](docs/pruebas-borrado-real.json) |
| Chromium aislado, ficha docente y conservación de escala | 9 recorridos aprobados | [Resultado](docs/pruebas-escala-docente.json) |
| Chromium aislado, confirmación con una casilla | 8 recorridos aprobados | [Resultado](docs/pruebas-preguntas-ui.json) |
| Chromium aislado, eliminación y controles de acceso | 8 recorridos aprobados | [Resultado](docs/pruebas-borrado-ui.json) |
| Chromium aislado, filtros y consolidación | 8 recorridos aprobados | [Resultado](docs/pruebas-filtros-subdireccion.json) |
| Chromium aislado, sala y audio instrumentado | 5 recorridos aprobados | [Resultado](docs/pruebas-sala-sorteo.json) |
| Chromium aislado, orden docente, ranking y seguimiento | 3 recorridos aprobados | [Resultado](docs/pruebas-jornada-vistas.json) |
| Chromium aislado, impresión, cola de fotos y revisión | 7 recorridos aprobados | [Resultado](docs/pruebas-papel-ui.json) |
| Instalación Docker y persistencia | Aprobadas | `scripts/local-start.sh` y pruebas de migración |

Los siete recorridos aislados suman 48 comprobaciones de interfaz. La entrega final se compiló nuevamente y sus 34 archivos coinciden exactamente con los servidos por la instalación local Docker.

El sorteo es aleatorio en el servidor y congela un único orden para Subdirección, docentes y proyección. Solo puede repetirse antes de comenzar y con motivo documentado. Los turnos exigen una copia actual del reloj: un comando atrasado no finaliza la editorial siguiente. Tampoco se pueden incorporar editoriales nuevas mediante importación después de empezar. Las proyecciones enumeran los campos públicos del sorteo y excluyen el ranking privado y las fichas ajenas.

Los cinco casos unitarios de audio y la instrumentación Chromium verifican una señal al inicio, aviso a cinco segundos y alarma al finalizar, sin duplicados al pausar o actualizar. El sonido depende de la activación del usuario y de que Sala o Proyección permanezca abierta en el equipo con parlantes.

El ranking considera todas las fichas vigentes cerradas, conserva el cero y muestra provisional si hay pendientes. Su huella detecta modificaciones posteriores del catálogo, participantes, criterios o sorteo. El seguimiento separa criterios respondidos de fichas cerradas y admite cualquier número de docentes.

## Eliminación y transparencia del instrumento

Subdirección puede eliminar en Jornada real o Demostración, con previsualización de registros y cascadas antes de confirmar. Las 17 pruebas SQL cubren los 14 ámbitos, CAS, revocación de accesos docentes, retirada de votos y códigos dependientes y aislamiento entre espacios. El vaciado conserva la contraseña, el acceso administrativo y la configuración. Los seis recorridos reales de navegador comprueban borrado selectivo/total, rechazo de previsualización desactualizada y nueva inscripción posterior. Ninguna prueba borró datos de producción.

Cada docente puede guardar y cerrar I11 sin registro de pregunta, turno iniciado ni confirmación de Sala, tanto en Jornada real como en Demostración. La Sala solicita una única casilla con guardado automático, sin nombre, área ni transcripciones. Cambiar, retirar o eliminar la confirmación conserva las notas, los cierres y los promedios; el cero sigue siendo una respuesta válida. Solo finalizar el turno requiere confirmar que la pregunta se hizo y la editorial respondió. Una confirmación eliminada puede recuperarse incluso después de finalizar, sin reabrir fichas. Los rankings y la clasificación no exigen puntaje mínimo; los padres eligen entre tres propuestas y el primer puesto técnico no determina el ganador de la votación.

La referencia documental MINEDU mantiene el PDF adjunto íntegro (40 páginas) y los puntos de sus 27 indicadores suman 100. Las 4 pruebas de referencia distinguen niveles 0–2 de la guía de la escala institucional 0–4, descalificación de puntaje parcial 0, niveles intermedios no definidos y las matrices según área/nivel. Los enlaces a las páginas fuente y las verificaciones pendientes están visibles en la ficha, portada, sala pública y reportes. Los 70 puntos se presentan solo como información conforme a la decisión del usuario; el instrumento adaptado y la observación de una muestra no se presentan como una verificación integral por texto ni como comprobación de vigencia normativa para 2027. La guía proporcionada tiene metadatos de 2013.

## Impresión y reconocimiento de votos

Las once pruebas de PDF A5 y lectura de marcas incluyen tamaño real 148 × 210 mm, ambas áreas, QR distinto por hoja, cuatro marcas con margen de impresión, PDF real rasterizado, X/relleno/lápiz, perspectiva, rotación de 90 grados, blanco, marca múltiple, marca tenue, recorte y QR ajeno. La lectura es OMR del formato generado por la app; no es OCR de papeletas arbitrarias.

Las fotos se procesan localmente. No se suben imágenes, nombres ni identidad de votantes. Las lecturas claras se pueden sumar inmediatamente; las dudosas requieren comparación y confirmación humana. La base solo guarda huellas de códigos y conteos agregados separados por área. Las pruebas de HTTP simultáneo confirman una sola suma por ficha; el cierre distingue ganador, empate y ausencia de votos válidos. Un respaldo anterior no puede reducir conteos ni desconsumir fichas.

## Conservación y alcance

La actualización `supabase/migrations/006-confirmacion-simple-e-i11-independiente.sql` es idéntica al esquema actual y debe ejecutarse como propietario antes de activar la interfaz. Los archivos 002, 003, 004 y 005 se mantienen intactos. Las dieciséis pruebas instalan 002, preservan las fichas originales al pasar a 003, 004 y 005, actualizan a 006 y comprueban que instalar/repetirla no ejecuta el borrado ni altera datos, accesos, notas, versiones, transcripciones anteriores o historial. Las fichas históricas 0–2 mantienen su rúbrica y porcentaje; las actuales usan diez criterios de exposición y la respuesta obligatoria, escala 0–4, máximo 44 y suma × 100 / 44. Las fichas anteriores 0–4 mantienen su máximo 40 y porcentaje hasta que el autor las amplía explícitamente, conservando sus diez respuestas.

Las pruebas usan demostración o bases descartables y no se conectan a producción. La jornada real no recibió datos ficticios. La instalación 005 y su despliegue se confirmaron anteriormente. Esta entrega requiere ejecutar 006 en Supabase antes de publicar la nueva interfaz; las pruebas aquí descritas no se conectan al sitio ni a la base de producción.

Cloudflare Pages y Supabase Free siguen siendo la alternativa gratuita dentro de las condiciones del proveedor. La lectura de fotos no usa servicios externos ni API de pago. Los respaldos administrativos contienen datos privados y deben conservarse con acceso restringido. Las decisiones y firmas formales siguen correspondiendo al centro.
