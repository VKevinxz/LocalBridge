/**
 * Crea un archivo nuevo elegido por el usuario sin posibilidad de reemplazar otro.
 *
 * Este helper no se expone como tool MCP. El path procede de un diálogo nativo del
 * proceso principal y `wx` hace atómica la garantía de "solo crear" frente a carreras.
 */
import { open, rm } from "node:fs/promises";

export async function createExclusiveFile(filePath: string, content: Buffer): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  let complete = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await rm(filePath, { force: true });
  }
}
