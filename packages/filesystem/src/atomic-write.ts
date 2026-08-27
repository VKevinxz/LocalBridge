/**
 * Escritura atómica (SECURITY.md §7, ADR-0005): temp en el mismo directorio +
 * fsync + rename. Un crash a mitad de escritura deja el destino intacto y, como
 * mucho, un temporal — nunca contenido truncado en la ruta final.
 */

import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Escribe `content` de forma atómica en `realParentDir/basename`.
 *
 * El temporal vive en el mismo directorio que el destino a propósito: un
 * `rename` entre directorios distintos (y con más razón entre volúmenes) no es
 * atómico en todos los sistemas de archivos; dentro del mismo directorio, sí.
 */
export async function atomicWrite(realParentDir: string, basename: string, content: Buffer): Promise<void> {
  const tempPath = path.join(realParentDir, `.${basename}.tmp-${randomUUID()}`);
  const finalPath = path.join(realParentDir, basename);

  const handle = await open(tempPath, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
