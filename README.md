# Selección de textos escolares 2027 — indicaciones y visita a mesas

Sala en vivo incluye un panel de indicaciones para las editoriales y proyección
compartida. Explica el tiempo total por editorial aunque participen varios
representantes, sorteo, evaluación y criterios, año de edición/PVP del kit por área,
retiro obligatorio del auditorio, tres finalistas y elección familiar.
El cumplimiento del tiempo queda explícito en I3. Se conservan 11 criterios/44.

Proyectar indicaciones funciona antes del ranking. Iniciar visita a mesas muestra
las tres finalistas vigentes por área y grupo de grados, con una cuenta regresiva
de 10 minutos por defecto, editable de 1 a 60, pausa, reanudación y finalización.
El tiempo se conserva al recargar y la tabla pública de votos sigue accesible.
No cambia el cronómetro de exposición, las reglas, las notas ni los votos.

Esta mejora utiliza settings_save y public_snapshot de SQL007 ya instalado.
NO necesita ejecutar otra actualización SQL. Los esquemas/migraciones no cambian.
Para una instalación nueva, consultar el manual y la migración007 del código fuente.

Fuente, manual y evidencia:
https://github.com/eliasnieto-lang/APLICACIONES-2026/tree/a5e1d4daeb9de38ec5e83f888b2f534d84f27259

Cloudflare Pages: rama compilada, comando vacío, raíz vacía, salida `.`. Sin Wrangler.
Después del despliegue, recargar los navegadores.
