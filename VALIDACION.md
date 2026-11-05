# Validación de Selección de textos escolares 2027

Fecha local: 5 de noviembre de 2026. Código y tablas separados de Círculos de Estudios.

## Evaluación docente desde celulares

La vista del docente tiene navegación propia, avance individual, selectores de categoría y editorial, cinco niveles 0–4 en una fila, observaciones desplegables y acciones de guardado accesibles durante la ficha. El estado distingue guardado confirmado, cambios pendientes y conflictos; los avisos conservan un acceso para revisar el detalle. Se respetan las áreas seguras y, en pantallas de poca altura o con teclado, las acciones vuelven al flujo para no cubrir el formulario.

Chromium comprobó en un navegador con emulación táctil los anchos 320, 360, 390 y 430 px: sin desbordes horizontales, objetivos de pulsación de al menos 44 px, campos de 16 px y etiquetas completas dentro de sus botones. También se verificaron navegación al siguiente criterio pendiente, campos inferiores accesibles y disposición horizontal. Esto no sustituye una prueba física en cada modelo de teléfono o en Safari de iOS.

La ficha aislada aprobó 10 recorridos, incluidos los valores 0 y 4, cierre de once criterios, borradores cifrados sin conexión, conflictos entre pestañas y conservación de notas históricas ([resultado](docs/pruebas-docente-movil-ficha.json)). La suite Node completa conserva 135 pruebas aprobadas; TypeScript y Vite compilan sin errores. El esquema y las migraciones SQL permanecen sin cambios: no se requiere otra instalación en Supabase.

El recorrido integrado con Node/Express, PostgreSQL y PostgREST locales aprobó **9 comprobaciones**: registro desde el teléfono, navegación, guardado y cierre real con I11 igual a cero, avance propio de 1/9 = 11 %, restauración de sesión y escritorio de Subdirección a 1440 px. Se incluyeron 320 × 568, 390 × 500 y 844 × 390 para revisar pantallas cortas, teclado simulado y orientación horizontal. No hubo errores de página ni solicitudes de escritura a la jornada real ([resultado y medidas](docs/pruebas-docente-movil.json)).

## Sirena y texto de resultados

La alarma usa barridos de frecuencia más presentes: 2,4 segundos al faltar cinco segundos y 4,2 al finalizar. Se conserva el pitido inicial, la detección única de cada umbral y el bloqueo de sonidos antiguos al recargar, pausar o silenciar. **Probar sirena** reproduce la alarma final.

Chromium aprobó 7 recorridos del controlador y WebAudio nativo, incluida cancelación de la sirena al silenciar. La medición OfflineAudioContext dio RMS 0,306/0,360 frente a 0,125 de referencia y picos 0,629/0,736, inferiores al nivel de saturación ([medición](docs/pruebas-sirena-medicion.json), [recorridos](docs/pruebas-sirena-ui.json)).

La regresión de votación aprobó 12 recorridos y confirma **Editorial elegida** para resultados ganadores; empates, blancos y nulos conservan sus estados. Son cambios de interfaz/audio: no se modifican SQL, reglas, puntajes ni votos.

## Indicaciones y visita compartida a mesas de muestra

| Comprobación actual | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación final | Aprobados | `npm run build` |
| Node completo, incluidas indicaciones, agenda, modelo y pantalla pública | 135 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt) |
| SQL/HTTP sobre versión 007 inmutable | 10 grupos aprobados | [Salida](docs/pruebas-auditorio-api.txt) |
| Chromium con backend local real | 10 recorridos aprobados | [Resultado](docs/pruebas-auditorio-real.json) |
| Chromium aislado: controles y público | 8 + 5 recorridos aprobados | [Controles](docs/pruebas-auditorio-controles.json), [Público](docs/pruebas-auditorio-publico.json) |

Se comprobó el procedimiento completo, el tiempo compartido entre representantes, I3, edición/PVP por área y el retiro de todas las editoriales. La agenda de referencia se ajusta al tiempo configurado, sin presentar diez minutos cuando corresponden quince.

La proyección de indicaciones funciona antes del ranking. La visita exige finalistas vigentes y tres propuestas por categoría, conserva un deadline compartido y admite duración de 1–60 minutos, pausa, reanudación, vencimiento y retorno a Sala. El reloj y las finalistas se conservan al recargar y en otra sesión. Se probaron móvil de 390 px y proyector de 1920 px sin desbordes, además del acceso permanente a la tabla de votos.

La prueba SQL instala expresamente 007 sin cambios. `settings_save` y `public_snapshot` conservan la proyección, con CAS y permisos vigentes. Reglas bloqueadas, notas de máximo 44, cierres, turnos, votos, fotografías y credenciales permanecen iguales. Las modificaciones se probaron solo en demo local o bases descartables; no se escribió configuración en producción. El esquema y las migraciones 002–007 permanecen intactos y esta interfaz no necesita otro SQL.

## Validación de referencia del padrón 007

## Padrón por aula, transcripción y cotejo familiar

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite final | Aprobados | `npm run build` |
| Node: dominio, acceso, sesiones, criterios, PDF/XLSX, padrón y tabla pública | 120 pruebas de base, incluidas en las 135 actuales | [Salida](docs/pruebas-unitarias.txt) |
| PostgreSQL/PostgREST aislados | 87 grupos: 21 padrón y voto manual + 15 compatibilidad anónima + 22 migraciones + 12 fotos privadas + 17 eliminación | [Salida](docs/pruebas-acceso-y-exposicion.txt) |
| Chromium sobre Node/Express + PostgreSQL/PostgREST reales | 11 recorridos de jornada, padrón, voto manual, A5, corrección y cotejo público | [Resultado](docs/pruebas-jornada-real.json) |
| Chromium aislado, transcripción e impresión por aula | 12 recorridos aprobados | [Resultado](docs/pruebas-papel-ui.json) |
| Chromium aislado, fotos de respaldo | 5 recorridos aprobados | [Resultado](docs/pruebas-fotos-ui.json) |
| Docker final y correspondencia de archivos | Compilación saludable; 34 archivos iguales a dist | `scripts/local-start.sh` y manifiesto local |

## Registro y control de fichas

El padrón contiene cinco secciones A–E por grado: P1=10 aulas, P2=20 y S1=15, sin duplicados. El folio corto identifica cada aula dentro de la votación y figura en su ficha A5 con ambas áreas. Los PDF nuevos no imprimen QR, códigos largos ni instrucciones de escaneo. Su tamaño es 148 × 210 mm.

La generación excluye ausentes y no vuelve a contar como nueva una reposición. Es posible registrar manualmente el voto antes de generar su PDF. La asistencia pendiente pasa a presente al contar, pero un aula marcada sin asistencia no puede votar hasta corregir su asistencia. Una ficha recibida no puede convertirse en ausencia. Los votos en blanco y nulos conservan significado separado en cada área.

La transcripción utiliza aula/folio y opciones de las dos áreas. La base bloquea el dataset, comprueba las versiones y consume una sola representación por aula. Reintentos y solicitudes simultáneas no agregan votos duplicados. Corregir exige motivo y versiones de votación y voto; resta el registro anterior, suma el nuevo y conserva historial sin aumentar recibidas. Se corrige mientras la votación está abierta y se coteja el papel antes del cierre.

La tabla pública muestra las opciones por aula durante el registro y después del cierre, conforme al pedido del centro. La proyección enumera solo campos permitidos; excluye credenciales, códigos internos, motivos privados, fotos y datos individuales de docentes. Los votos anónimos anteriores no se publican por aula ni reciben una identidad retroactiva.

## Fotos opcionales e independientes

Las fotos son privadas para Subdirección y se pueden adjuntar después del voto, incluso tras el cierre. Guardar, consultar, descargar y eliminar fotos no cambia votos, asistencia ni versiones de votación. Se comprueban permisos, dataset/aula, formato, tamaño, duplicados y cupo; el navegador prepara una imagen legible sin interpretar sus marcas. El JSON general incluye un manifiesto, no los bytes; las imágenes se descargan por separado para conservarlas con el respaldo.

Las pruebas cubren borrado en cascada de una votación y sus fotos, así como vista previa de las cantidades. Las fotos no pasan a la sala pública. No se usa OCR ni un servicio de pago para el registro actual.

## Conservación de la jornada y alcance

`supabase/migrations/007-padron-aulas-y-voto-manual.sql` coincide con el esquema actual. Los archivos 002–006 permanecen intactos. Las 22 pruebas de migración instalan las versiones anteriores, conservan notas 20/40/44, accesos, credenciales, historial y votos anónimos emitidos/consumidos, y verifican que instalar o repetir 007 no borra ni reidentifica registros. Los códigos pendientes de una votación anterior siguen funcionando en su contrato de compatibilidad; no se solicitan en el flujo actual.

Se conservan I11 independiente de Sala, la escala 0–4, once criterios de máximo 44, las referencias MINEDU y los 70 puntos solo informativos. Las fichas históricas retienen sus porcentajes hasta su actualización expresa. La valoración docente orienta; la elección final corresponde a las familias.

Las pruebas usan demostración local o bases descartables y no escriben en producción. La jornada real no recibió datos ficticios. La instalación 007 fue confirmada por el usuario y su despliegue se completó previamente; la mejora actual de auditorio utiliza esa misma base. Las comprobaciones descritas aquí no equivalen a un ingreso probado en el sitio público. El código y las tablas de Círculos de Estudios se mantienen separados.
