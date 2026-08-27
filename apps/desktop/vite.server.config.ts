import { builtinModules } from 'node:module';

import { defineConfig } from 'vite';

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'out/server',
    ssr: 'src/server/index.ts',
    target: 'node22',
    rollupOptions: {
      external: NODE_BUILTINS,
      output: {
        entryFileNames: 'index.cjs',
        format: 'cjs',
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
