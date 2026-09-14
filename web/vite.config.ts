import { defineConfig } from 'vite';

/*
  base './' so the built game runs from any folder: itch.io serves an upload
  from a nested path, and an absolute base would 404 every asset.

  public/assets is a directory junction to ../assets rather than a copy —
  the authored cast alone is ~146 MB, and two copies of it on disk would drift.

  The Draco and Basis decoders need no configuration: DRACOLoader and
  KTX2Loader locate them with `new URL('../libs/…', import.meta.url)`, which
  Vite serves in dev and emits, hashed, into dist/assets on build — always the
  copy that matches the installed three.js.
*/
export default defineConfig({
  base: './',

  resolve: {
    alias: [
      /* The loaders and utils in three/addons import from bare 'three'. Pointing
         that at the WebGPU build keeps ONE copy of the core classes in the
         bundle. Without it there are two — which doubles the download and
         quietly breaks anything that compares classes across the boundary.
         The regex is anchored so 'three/addons/...' is left alone. */
      { find: /^three$/, replacement: 'three/webgpu' },
    ],
  },

  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },

  build: {
    target: 'es2022',        // top-level await: WebGPURenderer.init() is async
    outDir: 'dist',
    sourcemap: true,
    assetsInlineLimit: 0,    // never base64 a texture into the JS bundle
    chunkSizeWarningLimit: 1600,
  },
});
