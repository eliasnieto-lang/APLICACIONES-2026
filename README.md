# Selección de textos escolares 2027

Aplicación de la I.E.P. Albert Einstein de Huaraz para valorar exposiciones editoriales mientras cada docente revisa el libro físico, consolidar sus resultados y publicar ternas por área y bloque. Admite Matemática y Comunicación, P1 (1.º–2.º de primaria), P2 (3.º–6.º de primaria) y S1 (1.º–3.º de secundaria), con cualquier cantidad de docentes evaluadores.

El procedimiento histórico por libro, grado, expediente y elección familiar se conserva por separado. Las notas de exposición no se convierten en notas por grado ni abren rondas familiares automáticamente. El código y las tablas propios (`textos_*`) no modifican Círculos de Estudios. El guion original está en [REQUISITOS.txt](REQUISITOS.txt).

## Recorrido vigente

1. **Preparar la jornada.** En la portada elija **INGRESAR COMO SUBDIRECTOR**, seleccione Jornada real o Demostración e ingrese la contraseña acordada por el colegio. Revise fecha, lugar, editoriales y reglas de la jornada. No hay puntaje mínimo para clasificar en el ranking o la terna. La primera ficha guardada fija las reglas. No necesita precargar libros, precios, registros OBNATE ni expedientes para recibir estas evaluaciones.
2. **Ingresar como docente.** Elija **INGRESAR COMO DOCENTE EVALUADOR**, escriba nombres y apellidos, seleccione Matemática o Comunicación y al menos un bloque P1/P2/S1. El registro es directo, sin correo ni contraseña docente; no existe un cupo de dos, tres o cinco docentes. El acceso personal se conserva en el navegador. Si ya se registró y perdió el acceso, solicite a Subdirección el enlace privado de recuperación.
3. **Evaluar la exposición.** Seleccione editorial y bloque de su perfil. Hay una ficha por docente + editorial + área + bloque. Observe la exposición y el ejemplar físico; marque expresamente diez criterios de exposición y un criterio adicional para la respuesta a la pregunta obligatoria: 0 Sin valoración, 1 En inicio, 2 En proceso, 3 Logrado o 4 Destacado. I11 se puede puntuar, guardar y cerrar sin iniciar la Sala ni esperar una confirmación, en Jornada real y Demostración. El máximo de la ficha vigente es 44 puntos y la nota /100 es suma × 100 / 44 (por ejemplo, 33/44 = 75/100). Las observaciones breves y la identificación del ejemplar son opcionales. Guarde y cierre la ficha cuando el servidor confirme; un cero elegido cuenta como respuesta y aporta cero puntos; las respuestas sin marcar permanecen pendientes.
4. **Consolidar y publicar.** Subdirección revisa inscritos, fichas cerradas, pendientes y promedios por editorial. Cada promedio incluye a todos los docentes del área y bloque que cerraron su ficha; es provisional mientras falten cierres. La publicación formal exige exactamente tres editoriales clasificadas, ninguna ficha pendiente, retiro documentado de las editoriales, aprobación de Dirección, apreciación y folio. El empate en el corte se compara por I2; si persiste, la publicación queda bloqueada. Si participan menos de tres editoriales no se inventan alternativas. La valoración docente orienta la clasificación; la elección final corresponde a los padres, que pueden elegir cualquiera de las tres.
5. **Documentar y respaldar.** En Actas y respaldos descargue la ficha de exposición PDF, la terna publicada PDF, el XLSX privado y el respaldo JSON. Las fichas individuales y sus observaciones solo corresponden al autor y a coordinación; la sala pública recibe únicamente resultados agregados publicados. Reabrir una ficha exige motivo, conserva su historial y deja sin vigencia la publicación afectada.

El panel incorpora **Sorteo en vivo**, **Ranking / Top**, **Docentes y avance** y **Votación de padres · A5**. El sorteo del servidor fija el orden compartido con todos los evaluadores y el cronómetro avisa al inicio, a cinco segundos y al finalizar. La votación usa una ficha A5 por aula (secciones A–E): 10 P1, 20 P2 y 15 S1. Imprime aula y folio corto; la transcripción es manual, sin escaneo ni código largo. La tabla pública muestra las opciones por aula para cotejo familiar. Las ausencias se registran aparte y las fotos son un respaldo privado opcional que puede adjuntarse después, incluso tras el cierre.

La ficha conserva **0–4** y los **70 puntos como referencia informativa**, con los indicadores observables enriquecidos a partir de la guía adjunta. Cada criterio remite a su fuente; el PDF completo se consulta desde la aplicación. Esta observación institucional orientativa no se confunde con la ficha integral MINEDU por texto. **Eliminar información** permite borrar registros concretos o vaciar Jornada real o Demostración con previsualización y confirmación, preservando el acceso de Subdirección.

El [manual](MANUAL.md) detalla acceso, exposición, recuperación y archivos históricos. El [informe de validación](VALIDACION.md) distingue pruebas locales y publicación.

## Opción A: nube gratuita

Se usa un sitio estático en Cloudflare Pages y PostgreSQL/Supabase Free. No se necesita contratar un dominio. Los equipos requieren Internet. Los límites y suspensión por inactividad del plan gratuito se consultan en el panel del proveedor; haga una prueba antes de la jornada.

Si ya instaló una versión anterior, ejecute primero el archivo completo [007-padron-aulas-y-voto-manual.sql](supabase/migrations/007-padron-aulas-y-voto-manual.sql) en **SQL Editor → New query → Run**, y luego publique la nueva interfaz. La instalación conserva las fichas previas y no borra registros ni cambia sus porcentajes; los navegadores con la interfaz anterior deben recargarse después del despliegue.

1. En el proyecto de Supabase existente, abra **SQL Editor**, pegue el archivo completo [supabase/schema.sql](supabase/schema.sql) y pulse **Run**. Se ejecuta como propietario, crea exclusivamente objetos `textos_*` y puede repetirse sin borrar datos. No ejecute `bootstrap-local.sql` en Supabase.
2. La portada usa el acceso directo de Subdirección. La contraseña se verifica exclusivamente en el servidor contra una huella con sal; el SQL no almacena su texto original. Coordine su entrega y cualquier cambio por un canal privado. El registro docente solicita nombres, apellidos, área y bloques; no requiere cuentas de correo. La autorización previa mediante Supabase Authentication sigue disponible para mantenimiento y compatibilidad, no es el recorrido principal de la portada.
3. Revise [public/config.json](public/config.json). Contiene únicamente configuración pública, incluida la URL y la clave **publishable**. Nunca coloque una clave `service_role`, contraseña de base de datos o contraseña personal en este archivo. Si cambia la URL del proyecto, actualice también `connect-src` en `public/_headers`.
4. Con Node.js 24, ejecute `npm ci` y `npm run build`. La carpeta de publicación es **dist**. Si conecta este código fuente por Git a Cloudflare Pages: Framework **None**, comando **npm run build**, salida **dist**, raíz vacía. Si publica una rama con los archivos ya compilados en la raíz: comando vacío, salida **.**, raíz vacía. No mezcle ambas configuraciones. No se necesita Wrangler.
5. Abra la dirección HTTPS de Pages y compruebe que la pantalla diga **Selección de textos escolares 2027**. Elija **INGRESAR COMO SUBDIRECTOR**, primero en Demostración. El enlace Sala pública permite proyectar sin iniciar sesión y excluye fichas y padrón.

Para otra instalación, cambie el usuario autorizado de `textos_coordinators` durante la instalación, como propietario; no se requieren claves administrativas en el navegador. Las tablas no admiten acceso directo del navegador: la función `textos_api` comprueba el rol en cada operación.

## Opción B: servidor del colegio, sin Internet durante la jornada

Requisitos para la instalación inicial: Docker Engine con Compose y Node.js 24. La descarga inicial de imágenes y dependencias necesita Internet; después se puede operar en la red local sin correo ni servicios externos.

```bash
cd seleccion-textos-2027
./scripts/local-start.sh
```

El comando crea contraseñas aleatorias locales en `local/.env`, inicia PostgreSQL, PostgREST y el servidor web, y deja el código de coordinación en `local/owner-code.txt`. No publique estos archivos. Para ver su código en su propia computadora:

```bash
cat local/owner-code.txt
```

Abra `http://localhost:8080` y use los dos botones de la portada. Subdirección ingresa con su contraseña configurada en el servidor y los docentes se registran directamente. Los códigos de propietario conservan una vía administrativa de recuperación: abra privadamente `http://localhost:8080/#access=SU-CODIGO`; para demostración use `http://localhost:8080/?datos=demo#access=SU-CODIGO-DEMO`. El navegador retira el código de la barra de direcciones. Estos códigos no son contraseñas docentes ni deben publicarse.

En otro equipo conectado a la misma red, abra `http://IP-DEL-SERVIDOR:8080` (por ejemplo, la dirección IPv4 que muestra `ipconfig` en Windows o la configuración de red del servidor). Permita el puerto 8080 en el cortafuegos de la red privada. Mantenga el servidor encendido y sin suspensión automática. No exponga ese puerto directamente a Internet.

HTTP local permite guardar en el servidor y conservar temporalmente el borrador en memoria durante una caída. Los borradores locales cifrados que sobreviven al cierre del navegador requieren un contexto seguro: HTTPS o localhost. Para HTTPS local configure un certificado confiable para los dispositivos y `TLS_CERT_FILE`/`TLS_KEY_FILE` en el servidor Node o un proxy HTTPS del colegio. La interfaz informa cuando el navegador no permite guardar el borrador cifrado. No cierre ni recargue una pestaña sin sincronizar.

Detener y volver a abrir conserva los datos:

```bash
./scripts/local-stop.sh
./scripts/local-start.sh
```

No use `docker compose down -v`: eliminaría el volumen persistente. Guarde también una copia privada descargada desde la aplicación.

## Desarrollo y pruebas

```bash
npm ci
npm test
npm run build
bash scripts/test-presentation-db.sh
bash scripts/test-scale-migration-db.sh
bash scripts/test-jornada-db.sh
bash scripts/test-paper-db.sh
bash scripts/test-questions-db.sh
bash scripts/test-cleanup-db.sh
```

Para desarrollar la interfaz: `npm run dev`. Para la base local use Compose; `npm start` sirve `dist` y reenvía las solicitudes a `POSTGREST_URL` (por defecto `http://127.0.0.1:3000`). Vite reenvía `/api` al servidor Node del puerto 8788.

Las pruebas PDF usan `pdftotext` y `pdftoppm` de Poppler para abrir y comprobar el contenido; instale `poppler-utils` en Linux si no está disponible. No se requiere para usar la aplicación. La prueba completa de navegador se ejecuta en una instalación local descartable con `node --import tsx tests/browser-presentation-local.mjs` (Chromium en `/usr/bin/chromium` o `CHROMIUM_PATH`). Usa solo la demostración; no la ejecute contra la base de una jornada en curso.

Las pruebas SQL utilizan servicios Docker aislados y datos ficticios, sin conectarse a producción. Consulte `scripts/test-db.sh` y el informe de validación entregado. La migración, el control de versiones y el recuento transaccional son el mismo código tanto en nube como en red local.

## Datos y privacidad

La votación nueva por aula conserva y publica las opciones de Matemática y Comunicación junto a aula y folio para el cotejo de las familias. No solicita nombres de padres. Las fotografías son un respaldo privado y opcional; el JSON contiene su manifiesto y las imágenes se descargan por separado. Las cédulas anónimas anteriores y la votación digital histórica conservan sus reglas propias.

- Las fichas vigentes guardan enteros 0/1/2/3/4 o pendiente; no hay puntajes precargados en la jornada real. Un dato desconocido conserva `null`.
- El puntaje vigente de exposición individual es 100/44 veces la suma de once criterios (diez de exposición y la respuesta obligatoria, máximo 44 antes de convertir a /100). El resultado por editorial, área y bloque promedia todas las fichas cerradas en la escala vigente 0–4 de sus docentes registrados, sin limitar evaluadores ni redondear para ordenar. Los cálculos históricos por libro y grado conservan sus reglas propias y no alimentan este promedio.
- Las fichas anteriores de exposición con escala 0–2 conservan sus respuestas, su máximo de 20 y su resultado original: 14/20 sigue siendo 70/100. Se identifican como históricas y pendientes de actualizar escala; no se mezclan con los nuevos promedios ni se convierten automáticamente. El docente debe volver a valorar los diez indicadores para usar la escala 0–4. PDF y XLSX indican la escala, suma y máximo de cada ficha.
- Los expedientes históricos conservan fuentes y verificaciones humanas. Son un archivo administrativo independiente de la ficha de exposición; la aplicación no certifica registros OBNATE ni reemplaza el control ministerial.
- La contraseña de Subdirección se conserva como huella con sal y se verifica en servidor. Los accesos personales emitidos tras el registro y los códigos de voto se conservan como huellas. Las opciones digitales se suman de forma atómica a contadores agregados, sin almacenar una cédula individual ni un vínculo sección/código/opción.
- La demostración se carga y reinicia solo en `demo`. La base real queda vacía hasta que coordinación registre datos auténticos.
- Un respaldo privado contiene información administrativa y huellas de códigos de voto, nunca los códigos originales. La restauración no restablece códigos consumidos; si la copia es anterior a votos conocidos, suspende la ronda y exige conciliación documentada.

Los PDF dejan espacios de firma, no simulan firmas oficiales ni envíos a autoridades. Los acuerdos pendientes se muestran como tales; una nota técnica nunca sustituye un empate familiar.
