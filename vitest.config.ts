import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Los runners Windows comparten CPU y disco con procesos nativos de las pruebas.
    // Acotamos la concurrencia en CI conservando todos los casos y sus timeouts.
    ...(process.env['CI'] ? { maxWorkers: 2 } : {}),
    // Las pruebas de seguridad y protocolo abren transportes; un timeout corto
    // convierte un cuelgue en un fallo visible en lugar de en una espera larga.
    testTimeout: 10_000,
  },
});
