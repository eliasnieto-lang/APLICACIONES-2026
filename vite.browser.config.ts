import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Browser-only distribution: its JavaScript, styles and imported assets are inlined afterwards. */
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'web',
    emptyOutDir: true,
    target: 'es2023',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
    sourcemap: false,
    // OCR workers, the WASM core and Spanish model intentionally travel inside one HTML file.
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      input: fileURLToPath(new URL('./browser.html', import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
});
