import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Los paquetes `@localbridge/*` (workspace de pnpm) se distribuyen como
 * TypeScript crudo (`main: "./src/index.ts"`, sin paso de build propio — se
 * ejecutan con `tsx` en el resto del monorepo). `externalizeDepsPlugin()` por
 * defecto los trataría como cualquier dependencia de npm ya compilada y los
 * dejaría fuera del bundle con un `require()`, pero Electron no sabe ejecutar
 * `.ts` directamente — hay que forzar a Vite a *empaquetarlos* (que sí resuelve
 * TypeScript de forma nativa vía esbuild), no a externalizarlos.
 */
const LOCALBRIDGE_PACKAGES = [
  '@modelcontextprotocol/client',
  '@localbridge/audit',
  '@localbridge/desktop-core',
  '@localbridge/development',
  '@localbridge/filesystem',
  '@localbridge/git',
  '@localbridge/mcp-server',
  '@localbridge/permissions',
  '@localbridge/shared',
  '@localbridge/validation',
  '@localbridge/workspace',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: LOCALBRIDGE_PACKAGES })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: LOCALBRIDGE_PACKAGES })],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: 'index.cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {},
});
