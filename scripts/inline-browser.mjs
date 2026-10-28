#!/usr/bin/env node
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'web');
const input = path.join(directory, 'browser.html');
let html = await readFile(input, 'utf8');
// Discover tags before inserting JavaScript, which can itself contain HTML fragments.
const scripts = [...html.matchAll(/<script\b([^>]*?)\bsrc="([^\"]+)"([^>]*)>\s*<\/script>/g)];
const links = [...html.matchAll(/<link\b([^>]*?)\bhref="([^\"]+)"([^>]*?)>/g)];

function localAsset(value) {
  const name = value.replace(/^\.\//, '').replace(/^\//, '');
  const target = path.resolve(directory, name);
  if (!target.startsWith(`${directory}${path.sep}`)) throw new Error(`Recurso fuera de la distribución: ${value}`);
  return target;
}

for (const match of scripts) {
  const script = await readFile(localAsset(match[2]), 'utf8');
  // A literal closing tag inside a bundled string must not terminate the HTML script element.
  const escaped = script.replace(/<\/script/gi, '<\\/script');
  // A replacement callback preserves literal "$&", "$`" and "$'" in bundled libraries.
  html = html.replace(match[0], () => `<script type="module">\n${escaped}\n</script>`);
}
for (const match of links) {
  if (/\brel="stylesheet"/.test(match[0])) {
    const css = await readFile(localAsset(match[2]), 'utf8');
    html = html.replace(match[0], () => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
  } else if (/\brel="modulepreload"/.test(match[0])) {
    html = html.replace(match[0], '');
  }
}

const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
if (/<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"|(?:src|href)="(?:\.?\/)?assets\//.test(markup)) {
  throw new Error('La distribución conserva una dependencia local fuera del HTML.');
}
await writeFile(path.join(directory, 'index.html'), html, 'utf8');
// Keep the publication artifact compact: only the standalone entry is required.
await rm(input);
await rm(path.join(directory, 'assets'), { recursive: true, force: true });
console.log(`Versión web autocontenida: ${path.join(directory, 'index.html')} (${Buffer.byteLength(html).toLocaleString('es-PE')} bytes).`);
