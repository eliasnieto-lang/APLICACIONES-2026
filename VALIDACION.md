# Validación de Selección de textos escolares 2027

Fecha local: 4 de noviembre de 2026. Código y tablas separados de Círculos de Estudios.

## Padrón por aula, transcripción y cotejo familiar

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript y compilación Vite final | Aprobados | `npm run build` |
| Node: dominio, acceso, sesiones, criterios, PDF/XLSX, padrón y tabla pública | 120 aprobadas; 0 fallidas; 0 omitidas | [Salida](docs/pruebas-unitarias.txt) |
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

Las pruebas usan demostración local o bases descartables y no escriben en producción. La jornada real no recibió datos ficticios. Esta entrega requiere ejecutar 007 en Supabase antes de publicar la nueva interfaz. Las comprobaciones descritas aquí no equivalen a un ingreso probado en el sitio público. El código y las tablas de Círculos de Estudios se mantienen separados.
