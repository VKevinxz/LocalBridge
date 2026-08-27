import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));

export default {
  build: {
    emptyOutDir: true,
    outDir: resolve(scriptsDirectory, '../dist/electron-process-test'),
    ssr: resolve(scriptsDirectory, 'verify-electron-process-supervisor.ts'),
    target: 'node22',
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { entryFileNames: 'index.cjs', format: 'cjs', inlineDynamicImports: true },
    },
  },
  ssr: { noExternal: true },
};
