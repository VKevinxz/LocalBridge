import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Los runners Windows comparten CPU y disco con procesos nativos de las pruebas.
    // La misma concurrencia acotada local/CI evita que la suite exacta se vuelva
    // dependiente de cuántos hilos tenga el host; se conservan todos los casos.
    maxWorkers: 2,
    // Las pruebas de seguridad y protocolo abren transportes; un timeout corto
    // convierte un cuelgue en un fallo visible en lugar de en una espera larga.
    testTimeout: 10_000,
  },
});
