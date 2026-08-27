import { createExclusiveFile } from "@localbridge/filesystem";

export async function exportDiagnosticFile(filePath: string, text: string): Promise<void> {
  await createExclusiveFile(filePath, Buffer.from(text, "utf8"));
}
