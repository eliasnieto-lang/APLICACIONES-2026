import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installBrowserBackend } from './browser/backend';
import './styles.css';

const root = document.getElementById('root')!;

function showOpeningError(error: unknown) {
  root.removeAttribute('role');
  root.removeAttribute('aria-live');
  const main = document.createElement('main');
  main.style.cssText = 'max-width:620px;margin:12vh auto;padding:32px;background:white;border:1px solid #eadde3;border-radius:14px;font-family:system-ui;color:#5f3546';
  const heading = document.createElement('h1');
  heading.textContent = 'No se pudo abrir el almacenamiento de la aplicación';
  heading.style.fontSize = '23px';
  const description = document.createElement('p');
  description.textContent = 'La versión web guarda los registros en este navegador. Permite el almacenamiento del sitio y vuelve a abrirla en Chrome o Edge. Los datos no se enviaron a un servidor.';
  description.style.cssText = 'margin:18px 0;line-height:1.8;font-size:14px';
  const detail = document.createElement('p');
  detail.textContent = error instanceof Error ? error.message : 'El navegador no permitió inicializar la base de datos local.';
  detail.style.cssText = 'padding:14px;background:#fff4f6;border-radius:6px;line-height:1.7;font-size:12px';
  const retry = document.createElement('button');
  retry.textContent = 'Volver a intentar';
  retry.style.cssText = 'margin-top:20px;border:0;border-radius:6px;padding:12px 18px;background:#ac253b;color:white;cursor:pointer';
  retry.addEventListener('click', () => window.location.reload());
  main.append(heading, description, detail, retry);
  root.replaceChildren(main);
}

// Install the persistent browser adapter before React mounts, so App never contacts Express.
installBrowserBackend().then(() => {
  root.removeAttribute('role');
  root.removeAttribute('aria-live');
  createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
}).catch(showOpeningError);
