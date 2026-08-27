import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exportDiagnosticFile } from '@localbridge/desktop-core';

function diagnosticPath(): string {
  const target = path.join(os.tmpdir(), `localbridge-diagnostic-${randomUUID()}.txt`);
  createdPaths.push(target);
  return target;
}

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((target) => rm(target, { force: true })));
});

describe('exportación de diagnóstico', () => {
  it('crea un archivo nuevo con el contenido esperado', async () => {
    const target = diagnosticPath();

    await exportDiagnosticFile(target, 'estado: listo\n');

    await expect(readFile(target, 'utf8')).resolves.toBe('estado: listo\n');
  });

  it('rechaza sobrescribir y conserva byte a byte el archivo existente', async () => {
    const target = diagnosticPath();
    await writeFile(target, 'contenido original', 'utf8');

    await expect(exportDiagnosticFile(target, 'reemplazo')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(target, 'utf8')).resolves.toBe('contenido original');
  });
});
