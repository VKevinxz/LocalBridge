import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineConfig } from 'vite';

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const PDF_WORKER_SOURCE = fileURLToPath(
  new URL('../../packages/mcp-server/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url),
);
const PDF_WORKER_DESTINATION = fileURLToPath(new URL('./out/server/pdf.worker.mjs', import.meta.url));
const requireFromMcpServer = createRequire(fileURLToPath(new URL('../../packages/mcp-server/package.json', import.meta.url)));
const CANVAS_SOURCE = dirname(requireFromMcpServer.resolve('@napi-rs/canvas'));
const requireFromCanvas = createRequire(join(CANVAS_SOURCE, 'package.json'));
const CANVAS_WINDOWS_SOURCE = dirname(requireFromCanvas.resolve('@napi-rs/canvas-win32-x64-msvc'));
const NATIVE_MODULES_DESTINATION = fileURLToPath(new URL('./out/server/node_modules/@napi-rs', import.meta.url));
// `clawpdf` is ESM-only and intentionally has no CommonJS export for
// `require.resolve`. It is a direct mcp-server dependency, so its published
// vendor path is stable behind pnpm's package-level node_modules link.
const PDFIUM_WASM_SOURCE = fileURLToPath(
  new URL('../../packages/mcp-server/node_modules/clawpdf/dist/vendor/pdfium.esm.wasm', import.meta.url),
);
const PDFIUM_WASM_DESTINATION = fileURLToPath(new URL('./out/server/pdfium.esm.wasm', import.meta.url));

export default defineConfig({
  plugins: [{
    name: 'localbridge-copy-document-runtime',
    async writeBundle() {
      await mkdir(fileURLToPath(new URL('./out/server', import.meta.url)), { recursive: true });
      await Promise.all([
        copyFile(PDF_WORKER_SOURCE, PDF_WORKER_DESTINATION),
        copyFile(PDFIUM_WASM_SOURCE, PDFIUM_WASM_DESTINATION),
      ]);
      await rm(NATIVE_MODULES_DESTINATION, { recursive: true, force: true });
      await mkdir(NATIVE_MODULES_DESTINATION, { recursive: true });
      await Promise.all([
        cp(CANVAS_SOURCE, join(NATIVE_MODULES_DESTINATION, 'canvas'), { recursive: true }),
        cp(CANVAS_WINDOWS_SOURCE, join(NATIVE_MODULES_DESTINATION, 'canvas-win32-x64-msvc'), { recursive: true }),
      ]);
    },
  }],
  build: {
    emptyOutDir: true,
    outDir: 'out/server',
    ssr: true,
    target: 'node22',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./src/server/index.ts', import.meta.url)),
        'document-worker': fileURLToPath(new URL('../../packages/mcp-server/src/document-worker.mjs', import.meta.url)),
      },
      external: [...NODE_BUILTINS, '@napi-rs/canvas'],
      output: {
        entryFileNames: '[name].cjs',
        chunkFileNames: '[name]-[hash].cjs',
        format: 'cjs',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
