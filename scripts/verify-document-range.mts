import { open, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openWorkspaceBinaryRangeReader } from "@localbridge/filesystem";
import { parsePdfDocument } from "../packages/mcp-server/src/document-reader.js";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

const MEBIBYTE = 1024 * 1024;
const TARGETS = [25, 100, 250] as const;
const WHITESPACE_CHUNK = Buffer.alloc(4 * MEBIBYTE, 0x20);

function workspace(rootPath: string): AuthorizedWorkspace {
  return {
    id: "ws_document_range_benchmark",
    name: "document-range-benchmark",
    rootPath,
    enabled: true,
    createdAt: new Date().toISOString(),
    permissions: { read: true, write: false, overwrite: false, gitRead: false, validations: false, gitWrite: false },
    limits: { maxFileBytes: MEBIBYTE, maxTreeEntries: 10, maxTreeDepth: 2 },
    denyPatterns: [],
    validationProfiles: {},
  };
}

function buildLargePdfParts(targetBytes: number): { prefix: Buffer; paddingBytes: number; suffix: Buffer } {
  const pages = ["First range page", "Middle range page", "Final range page"];
  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>");
  pages.forEach((text, index) => {
    const pageId = 3 + index;
    const contentId = 6 + index;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(9, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let id = 1; id <= 9; id += 1) {
    offsets.set(id, Buffer.byteLength(body));
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  offsets.set(10, Buffer.byteLength(body));
  let paddingBytes = targetBytes - Buffer.byteLength(body) - 512;
  let prefix = Buffer.alloc(0);
  let suffix = Buffer.alloc(0);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    prefix = Buffer.from(`${body}10 0 obj\n<< /Length ${paddingBytes} >>\nstream\n`, "binary");
    const streamEnd = "\nendstream\nendobj\n";
    const xrefOffset = prefix.byteLength + paddingBytes + Buffer.byteLength(streamEnd);
    let xref = `xref\n0 11\n0000000000 65535 f \n`;
    for (let id = 1; id <= 10; id += 1) xref += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
    suffix = Buffer.from(`${streamEnd}${xref}trailer\n<< /Size 11 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "binary");
    const nextPadding = targetBytes - prefix.byteLength - suffix.byteLength;
    if (nextPadding === paddingBytes) break;
    paddingBytes = nextPadding;
  }
  if (paddingBytes < 0 || prefix.byteLength + paddingBytes + suffix.byteLength !== targetBytes) {
    throw new Error(`cannot construct exact ${targetBytes}-byte fixture`);
  }
  return { prefix, paddingBytes, suffix };
}

async function writeLargePdf(filePath: string, targetBytes: number): Promise<void> {
  const { prefix, paddingBytes, suffix } = buildLargePdfParts(targetBytes);
  const handle = await open(filePath, "w");
  try {
    await handle.write(prefix);
    let remaining = paddingBytes;
    while (remaining > 0) {
      const length = Math.min(remaining, WHITESPACE_CHUNK.byteLength);
      await handle.write(WHITESPACE_CHUNK, 0, length);
      remaining -= length;
    }
    await handle.write(suffix);
  } finally {
    await handle.close();
  }
}

async function verifyTarget(root: string, sizeMiB: number): Promise<Record<string, number | string>> {
  const relativePath = `range-${sizeMiB}mib.pdf`;
  const targetBytes = sizeMiB * MEBIBYTE;
  await writeLargePdf(path.join(root, relativePath), targetBytes);
  let authorityChecks = 0;
  const source = await openWorkspaceBinaryRangeReader(workspace(root), relativePath, {
    hardLimitBytes: 250 * MEBIBYTE,
    checkAuthority: async () => { authorityChecks += 1; },
  });
  let rangeRequests = 0;
  let rangeBytes = 0;
  let maximumRangeBytes = 0;
  const measuredSource = {
    size: source.size,
    hasActivePdfSyntax: source.hasActivePdfSyntax,
    readRange: async (offset: number, length: number) => {
      rangeRequests += 1;
      rangeBytes += length;
      maximumRangeBytes = Math.max(maximumRangeBytes, length);
      return source.readRange(offset, length);
    },
  };
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const startedAt = performance.now();
  try {
    for (const [page, expected] of [[1, "First"], [2, "Middle"], [3, "Final"]] as const) {
      let result;
      try {
        result = await parsePdfDocument(measuredSource, { startPage: page, endPage: page, maxChars: 10_000 });
      } catch (error) {
        throw new Error(`${sizeMiB} MiB page ${page} failed after ${rangeRequests} ranges/${rangeBytes} bytes`, { cause: error });
      }
      if (!result.text.includes(expected)) throw new Error(`${sizeMiB} MiB page ${page} mismatch`);
    }
  } finally {
    clearInterval(sampler);
    await source.close();
  }
  if (source.size !== targetBytes) throw new Error(`${sizeMiB} MiB fixture has wrong size`);
  if (maximumRangeBytes > 4 * MEBIBYTE || rangeBytes >= source.size * 3) {
    throw new Error(`${sizeMiB} MiB range transport exceeded its bounded budget`);
  }
  return {
    sourceMiB: sizeMiB,
    elapsedMs: Math.round(performance.now() - startedAt),
    peakRssMiB: Math.round(peakRss / MEBIBYTE),
    rangeRequests,
    rangeMiB: Number((rangeBytes / MEBIBYTE).toFixed(2)),
    maximumRangeKiB: Math.round(maximumRangeBytes / 1024),
    authorityChecks,
    sha256: source.sha256,
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-document-range-"));
  const resolvedRoot = path.resolve(root);
  if (!resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("refusing unsafe benchmark cleanup");
  try {
    const results = [];
    for (const target of TARGETS) results.push(await verifyTarget(root, target));
    process.stdout.write(`${JSON.stringify({ ok: true, maximumSourceMiB: 250, results }, null, 2)}\n`);
  } finally {
    await rm(resolvedRoot, { recursive: true, force: true });
  }
}

await main();
