import { describe, expect, it } from "vitest";

import { parsePdfDocument, readRasterImage, renderPdfDocument } from "../../packages/mcp-server/src/document-reader.js";
import { buildPdfFixture } from "../helpers/pdf-fixture.js";

describe("document.read PDF worker", () => {
  it("extrae texto por páginas sin recibir una ruta del documento", async () => {
    const result = await parsePdfDocument(buildPdfFixture({ pages: ["Pagina uno", "Pagina dos"] }), {
      startPage: 2,
      endPage: 2,
      maxChars: 50_000,
    });
    expect(result).toMatchObject({ pageCount: 2, startPage: 2, endPage: 2, text: "Pagina dos", truncated: false });
    expect(result.pageSummaries).toEqual([
      expect.objectContaining({ page: 2, textCharacters: 10, classification: expect.stringMatching(/^(?:text|mixed)$/) }),
    ]);
    expect(result.recommendedMode).toMatch(/^(?:text|mixed)$/);
  });

  it("acota el texto extraído", async () => {
    const result = await parsePdfDocument(buildPdfFixture({ pages: Array.from({ length: 20 }, () => "word ".repeat(40)) }), { maxChars: 1_000 });
    expect(result.text).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
    expect(result.endPage).toBe(result.pageSummaries.at(-1)?.page);
    expect(result.endPage).toBeLessThan(20);
    expect(result.hasMorePages).toBe(true);
    expect(result.nextPage).toBe(result.endPage + 1);
  });

  it("detecta y omite acciones JavaScript", async () => {
    const result = await parsePdfDocument(buildPdfFixture({ javascript: true }), { maxChars: 50_000 });
    expect(result.warnings).toContain("active-content-ignored");
  });

  it("no confunde texto o bytes de imagen con acciones PDF", async () => {
    const result = await parsePdfDocument(buildPdfFixture({ pages: ["Marcador inocuo /AA dentro del contenido"] }), { maxChars: 50_000 });
    expect(result.warnings).not.toContain("active-content-ignored");
  });

  it("informa explícitamente PDF escaneado o sin texto", async () => {
    await expect(parsePdfDocument(buildPdfFixture({ pages: [null] }), { maxChars: 50_000 }))
      .rejects.toMatchObject({ code: "DOCUMENT_NO_TEXT" });
  });

  it("rechaza contenido malformado y rangos inválidos", async () => {
    await expect(parsePdfDocument(Buffer.from("not a pdf"), { maxChars: 50_000 }))
      .rejects.toMatchObject({ code: "DOCUMENT_UNSUPPORTED" });
    await expect(parsePdfDocument(buildPdfFixture(), { startPage: 2, maxChars: 50_000 }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("renderiza una página sin texto como PNG o JPEG acotado", async () => {
    const result = await renderPdfDocument(buildPdfFixture({ pages: [null] }), {
      pages: [1], detail: "standard",
    });
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ page: 1, detail: "standard", renderer: "pdfium", width: 1237, height: 1600 });
    expect(["image/png", "image/jpeg"]).toContain(result.pages[0]?.mimeType);
    expect(result.pages[0]?.bytes.byteLength).toBeGreaterThan(100);
  });

  it("clasifica contenido mixto y visual y respeta la rotación de página", async () => {
    const source = buildPdfFixture({ pages: [
      { text: "Texto con diagrama", visual: true },
      { visual: true },
      { text: "Pagina apaisada", rotate: 90 },
    ] });
    const read = await parsePdfDocument(source, { startPage: 1, endPage: 3, maxChars: 50_000 });
    expect(read.recommendedMode).toBe("mixed");
    expect(read.pageSummaries).toEqual([
      expect.objectContaining({ page: 1, classification: "mixed", hasVectorDrawing: true }),
      expect.objectContaining({ page: 2, classification: "visual", hasVectorDrawing: true }),
      expect.objectContaining({ page: 3, classification: "text", widthPoints: 792, heightPoints: 612 }),
    ]);

    const rendered = await renderPdfDocument(source, { pages: [3], detail: "standard" });
    expect(rendered.pages[0]).toMatchObject({ page: 3, renderer: "pdfium", width: 1600, height: 1237 });
  });

  it("procesa un PDF grande mediante rangos sin entregar una ruta al worker", async () => {
    const bytes = buildPdfFixture({ pages: Array.from({ length: 300 }, (_value, index) => `Page ${index + 1} ${"content ".repeat(40)}`) });
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    const requests: Array<[number, number]> = [];
    const result = await parsePdfDocument({
      size: bytes.byteLength,
      readRange: async (offset, length) => {
        requests.push([offset, length]);
        return bytes.subarray(offset, offset + length);
      },
    }, { startPage: 250, endPage: 250, maxChars: 50_000 });
    expect(result.text).toContain("Page 250");
    expect(requests[0]).toEqual([0, 64 * 1024]);
    expect(requests.some(([offset]) => offset >= 64 * 1024)).toBe(true);
  });

  it("renderiza páginas de una fuente PDF virtual mayor de 250 MiB sin materializarla", async () => {
    const prefix = buildPdfFixture({ pages: ['PDF virtual grande'] });
    const marker = Buffer.from(`startxref\n${/startxref\n(\d+)/.exec(prefix.toString('latin1'))?.[1]}\n%%EOF\n`, 'latin1');
    const totalSize = 260 * 1024 * 1024 + marker.length;
    let largestRange = 0;
    let totalDelivered = 0;
    const source = {
      size: totalSize,
      readRange: async (offset: number, length: number) => {
        largestRange = Math.max(largestRange, length);
        totalDelivered += length;
        const output = Buffer.alloc(length, 0x20);
        const copySegment = (segment: Buffer, segmentOffset: number): void => {
          const begin = Math.max(offset, segmentOffset);
          const end = Math.min(offset + length, segmentOffset + segment.length);
          if (end > begin) segment.copy(output, begin - offset, begin - segmentOffset, end - segmentOffset);
        };
        copySegment(prefix, 0);
        copySegment(marker, totalSize - marker.length);
        return output;
      },
    };
    const rendered = await renderPdfDocument(source, { pages: [1], detail: 'standard' });
    expect(rendered.pages[0]).toMatchObject({ page: 1, width: 1236, height: 1600 });
    expect(largestRange).toBeLessThanOrEqual(128 * 1024);
    expect(totalDelivered).toBeLessThan(4 * 1024 * 1024);
  });

  it("cancela un worker PDF en curso sin esperar al timeout del parser", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = parsePdfDocument(buildPdfFixture({ pages: Array.from({ length: 50 }, () => 'texto '.repeat(500)) }), {
      maxChars: 50_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("decodifica JPEG y WebP pasivos y normaliza su transporte", async () => {
    const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAACP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ4AWA1P/9k=", "base64");
    const webp = Buffer.from("UklGRiACAABXRUJQVlA4WAoAAAAgAAAABwAABQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMgAAABACAJ0BKggABgAAwBIloAJ0ugH4AfoAA8gA/vDEC/+jiX73dP+jjf/kb+PnRv/KBAAA", "base64");
    const [jpegResult, webpResult] = await Promise.all([
      readRasterImage(jpeg, { detail: "standard" }),
      readRasterImage(webp, { detail: "standard" }),
    ]);
    expect(jpegResult).toMatchObject({ sourceMimeType: "image/jpeg", width: 8, height: 6 });
    expect(webpResult).toMatchObject({ sourceMimeType: "image/webp", width: 8, height: 6 });
    expect([jpegResult.mimeType, webpResult.mimeType]).toEqual(["image/png", "image/png"]);
  });

  it("rechaza una imagen con dimensiones hostiles antes de decodificar", async () => {
    const fake = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fake);
    fake.writeUInt32BE(100_000, 16);
    fake.writeUInt32BE(100_000, 20);
    await expect(readRasterImage(fake, { detail: "standard" })).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });
});
