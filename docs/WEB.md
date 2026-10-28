# Edición web para navegador

Esta edición ejecuta la aplicación en el navegador, sin Docker, Node.js ni un servidor de base de datos. Reutiliza la interfaz y las fórmulas de la aplicación original. El almacenamiento persistente utiliza IndexedDB del navegador. Los PDF originales, los expedientes, la configuración y el historial permanecen en el dispositivo donde se abren.

## Construcción

Desde el repositorio, ejecuta:

```sh
npm ci
npm run build:web
```

El resultado es `web/index.html`, con JavaScript, estilos y los recursos importados incorporados en el propio documento. No depende del servidor Express ni envía solicitudes a sus rutas `/api/`. La construcción ejecuta `scripts/fetch-ocr-model.sh`, que descarga el modelo español desde una revisión oficial inmutable y comprueba su SHA-256 antes de incluirlo. La construcción no requiere Poppler ni el ejecutable nativo de Tesseract. El operador de la web no necesita instalar programas.

## Persistencia y copias de seguridad

Los datos pertenecen al navegador y al origen del sitio. Abrir la web en otro equipo, otro navegador o una dirección distinta no comparte automáticamente la misma base de estudiantes. El modo privado y borrar los datos de navegación pueden eliminar los registros locales.

Usa **Descargar copia de seguridad** para conservar el estado y los originales PDF en JSON. **Restaurar copia de seguridad** permite trasladarlos a otro navegador o recuperar un respaldo. Los datos ficticios de demostración permanecen separados de los registros reales.

## Publicación

La fuente de la aplicación está en `main`. El HTML compilado y verificado se publica en una rama independiente llamada **gh-pages**, con `index.html` y `.nojekyll` en su raíz. No requiere instalar programas en el equipo del operador ni contratar un servidor de base de datos.

El propietario debe habilitar GitHub Pages desde **Settings → Pages → Build and deployment**: elegir **Deploy from a branch**, seleccionar **gh-pages**, carpeta **/(root)** y pulsar **Save**. Esta activación pertenece a la cuenta de GitHub y no se obtiene únicamente subiendo los archivos. El repositorio debe seguir siendo público para usar esta opción gratuita.

La existencia del HTML o de la rama no demuestra que haya una dirección pública activa. Solo debe darse un enlace de acceso después de que la publicación finalice y se compruebe esa dirección.

El alojamiento estático publica la aplicación; los registros introducidos permanecen en el navegador del operador. Para compartir una base central entre varias computadoras, utiliza la edición de servidor con almacenamiento persistente y el acceso institucional correspondiente.
