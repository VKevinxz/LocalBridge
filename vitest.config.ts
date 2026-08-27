import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Las pruebas de seguridad y protocolo abren transportes; un timeout corto
    // convierte un cuelgue en un fallo visible en lugar de en una espera larga.
    testTimeout: 10_000,
  },
});
