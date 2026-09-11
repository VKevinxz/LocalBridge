import { parentPort } from "node:worker_threads";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument, OPS, PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES_PER_READ = 50;
const MAX_PAGES_PER_RENDER = 4;
const RANGE_CHUNK_BYTES = 64 * 1024;
const MAX_ENCODED_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_PDFIUM_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_PDFIUM_RENDER_PIXELS = 12_000_000;

const IMAGE_OPERATORS = new Set([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintSolidColorImageMask,
].filter(Number.isInteger));
const VECTOR_OPERATORS = new Set([
  OPS.constructPath,
  OPS.paintFormXObjectBegin,
  OPS.beginAnnotation,
].filter(Number.isInteger));

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  parentPort?.postMessage({ type: "result", ok: false, code }, []);
}

function transferableBytes(bytes) {
  return Uint8Array.from(bytes);
}

class WorkerRangeTransport extends PDFDataRangeTransport {
  #nextRequestId = 1;
  #listener;

  constructor(length, initialData) {
    // No progressive stream follows the first chunk. Marking it complete makes
    // PDF.js request the xref/page ranges it needs instead of walking the file.
    super(length, initialData, true);
    this.#listener = (message) => {
      if (message?.type !== "range-response") return;
      if (message.ok !== true) {
        this.abort();
        return;
      }
      this.onDataRange(message.begin, new Uint8Array(message.bytes));
    };
    parentPort?.on("message", this.#listener);
  }

  requestDataRange(begin, end) {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    parentPort?.postMessage({ type: "range-request", requestId, begin, end }, []);
  }

  dispose() {
    if (this.#listener !== undefined) parentPort?.off("message", this.#listener);
    this.#listener = undefined;
  }
}

function commonPdfOptions() {
  return {
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWasm: false,
    verbosity: 0,
  };
}

function hasDeclaredActivePdfSyntax(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  let structural = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "%") {
      const end = text.indexOf("\n", index + 1);
      index = end === -1 ? text.length : end + 1;
      structural += " ";
      continue;
    }
    if (text[index] === "(") {
      let depth = 1;
      index += 1;
      while (index < text.length && depth > 0) {
        if (text[index] === "\\") index += 2;
        else {
          if (text[index] === "(") depth += 1;
          else if (text[index] === ")") depth -= 1;
          index += 1;
        }
      }
      structural += " ";
      continue;
    }
    if (text[index] === "<" && text[index + 1] !== "<" && text[index - 1] !== "<") {
      const end = text.indexOf(">", index + 1);
      index = end === -1 ? text.length : end + 1;
      structural += " ";
      continue;
    }
    if (text.startsWith("stream", index) && /\s/.test(text[index - 1] ?? " ") && /[\r\n]/.test(text[index + 6] ?? "")) {
      const end = text.indexOf("endstream", index + 6);
      index = end === -1 ? text.length : end + "endstream".length;
      structural += " ";
      continue;
    }
    structural += text[index];
    index += 1;
  }
  return /\/(?:JavaScript|OpenAction|AA)\b/.test(structural);
}

function createPdfLoadingTask(message) {
  if (message.source?.kind === "range") {
    const initialData = new Uint8Array(message.source.initialData);
    if (initialData.byteLength < 5 || new TextDecoder("ascii").decode(initialData.subarray(0, 5)) !== "%PDF-") {
      throw codedError("DOCUMENT_UNSUPPORTED");
    }
    const range = new WorkerRangeTransport(message.source.length, initialData);
    const loadingTask = getDocument({
      ...commonPdfOptions(),
      range,
      length: message.source.length,
      rangeChunkSize: RANGE_CHUNK_BYTES,
      disableStream: true,
      disableAutoFetch: true,
    });
    return {
      loadingTask,
      dispose: () => range.dispose(),
      hasActiveSyntax: message.source.hasActivePdfSyntax === true,
    };
  }

  const bytes = new Uint8Array(message.bytes);
  if (bytes.byteLength < 5 || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw codedError("DOCUMENT_UNSUPPORTED");
  }
  return {
    loadingTask: getDocument({ ...commonPdfOptions(), data: Uint8Array.from(bytes) }),
    dispose: () => undefined,
    hasActiveSyntax: hasDeclaredActivePdfSyntax(bytes),
  };
}

async function documentWarnings(document, hasActiveSyntax) {
  const warnings = [];
  const [actions, openAction, attachments] = await Promise.all([
    document.getJSActions().catch(() => null),
    document.getOpenAction().catch(() => null),
    document.getAttachments().catch(() => null),
  ]);
  if ((actions !== null && Object.keys(actions).length > 0) || openAction !== null || hasActiveSyntax) {
    warnings.push("active-content-ignored");
  }
  if (attachments !== null && Object.keys(attachments).length > 0) warnings.push("attachments-ignored");
  return warnings;
}

function pageClassification(textCharacters, hasRasterImages, hasVectorDrawing) {
  const hasGraphics = hasRasterImages || hasVectorDrawing;
  if (textCharacters === 0) return hasGraphics ? "visual" : "empty";
  return hasGraphics ? "mixed" : "text";
}

async function readPdf(message) {
  const { loadingTask, dispose, hasActiveSyntax } = createPdfLoadingTask(message);
  try {
    const document = await loadingTask.promise;
    const pageCount = document.numPages;
    const startPage = message.startPage ?? 1;
    const endPage = Math.min(message.endPage ?? Math.min(pageCount, startPage + MAX_PAGES_PER_READ - 1), pageCount);
    if (startPage > pageCount || endPage < startPage || endPage - startPage + 1 > MAX_PAGES_PER_READ) {
      throw codedError("INVALID_INPUT");
    }

    const warnings = await documentWarnings(document, hasActiveSyntax);
    const pageSummaries = [];
    let text = "";
    let truncated = false;
    for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const [content, operators] = await Promise.all([
          page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
          page.getOperatorList({ intent: "display" }),
        ]);
        const pageText = content.items
          .filter((item) => typeof item?.str === "string")
          .map((item) => item.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const viewport = page.getViewport({ scale: 1 });
        const hasRasterImages = operators.fnArray.some((operator) => IMAGE_OPERATORS.has(operator));
        const hasVectorDrawing = operators.fnArray.some((operator) => VECTOR_OPERATORS.has(operator));
        pageSummaries.push({
          page: pageNumber,
          widthPoints: viewport.width,
          heightPoints: viewport.height,
          textCharacters: pageText.length,
          hasRasterImages,
          hasVectorDrawing,
          classification: pageClassification(pageText.length, hasRasterImages, hasVectorDrawing),
        });
        const separator = text.length === 0 ? "" : "\n\n";
        const next = `${separator}${pageText}`;
        if (text.length + next.length > message.maxChars) {
          text += next.slice(0, Math.max(0, message.maxChars - text.length));
          truncated = true;
          break;
        }
        text += next;
      } finally {
        page.cleanup();
      }
    }
    if (text.trim().length === 0) throw codedError("DOCUMENT_NO_TEXT");
    const classifications = new Set(pageSummaries.map((summary) => summary.classification));
    const recommendedMode = classifications.has("visual") || classifications.has("empty")
      ? (classifications.has("text") || classifications.has("mixed") ? "mixed" : "visual")
      : classifications.has("mixed") ? "mixed" : "text";
    const processedEndPage = pageSummaries.at(-1)?.page ?? startPage;
    return {
      pageCount,
      startPage,
      endPage: processedEndPage,
      text,
      truncated,
      warnings,
      pageSummaries,
      recommendedMode,
      hasMorePages: processedEndPage < pageCount,
      ...(processedEndPage < pageCount ? { nextPage: processedEndPage + 1 } : {}),
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
    dispose();
  }
}

function renderDimensions(viewport, detail) {
  const targetLongEdge = detail === "high" ? 2400 : 1600;
  const maxPixels = detail === "high" ? 12_000_000 : 8_000_000;
  const longEdgeScale = targetLongEdge / Math.max(viewport.width, viewport.height);
  const pixelScale = Math.sqrt(maxPixels / (viewport.width * viewport.height));
  return { scale: Math.min(longEdgeScale, pixelScale), maxPixels };
}

async function encodeCanvasWithin(canvas, maximumBytes, errorCode) {
  let current = canvas;
  let resized = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const png = await current.encode("png");
    if (png.byteLength <= maximumBytes) {
      return { bytes: png, mimeType: "image/png", fallbackApplied: resized, canvas: current };
    }
    const jpeg = await current.encode("jpeg", 90);
    if (jpeg.byteLength <= maximumBytes) {
      return { bytes: jpeg, mimeType: "image/jpeg", fallbackApplied: true, canvas: current };
    }
    const width = Math.max(1, Math.floor(current.width * 0.75));
    const height = Math.max(1, Math.floor(current.height * 0.75));
    const reduced = createCanvas(width, height);
    const context = reduced.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(current, 0, 0, width, height);
    current = reduced;
    resized = true;
  }
  throw codedError(errorCode);
}

async function encodePdfiumPngWithin(png, maximumBytes, maxPixels) {
  const metadata = rasterMetadata(png);
  if (metadata.sourceMimeType !== "image/png" || metadata.width * metadata.height > maxPixels) {
    throw codedError("DOCUMENT_RENDER_TOO_LARGE");
  }
  if (png.byteLength <= maximumBytes) {
    return {
      bytes: png,
      mimeType: "image/png",
      fallbackApplied: false,
      width: metadata.width,
      height: metadata.height,
    };
  }
  const image = await loadImage(png);
  const canvas = createCanvas(metadata.width, metadata.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encoded = await encodeCanvasWithin(canvas, maximumBytes, "DOCUMENT_RENDER_TOO_LARGE");
  return {
    bytes: encoded.bytes,
    mimeType: encoded.mimeType,
    fallbackApplied: true,
    width: encoded.canvas.width,
    height: encoded.canvas.height,
  };
}

async function renderPdfiumPage(document, pageNumber, detail) {
  const page = document.page(pageNumber);
  const rotated = page.rotation === 90 || page.rotation === 270;
  const baseViewport = {
    width: rotated ? page.height : page.width,
    height: rotated ? page.width : page.height,
  };
  const { scale, maxPixels } = renderDimensions(baseViewport, detail);
  const png = await page.png({ scale, background: "white", forms: true, compress: true });
  const encoded = await encodePdfiumPngWithin(png, MAX_ENCODED_PAGE_BYTES, maxPixels);
  const bytes = transferableBytes(encoded.bytes);
  return {
    page: pageNumber,
    width: encoded.width,
    height: encoded.height,
    mimeType: encoded.mimeType,
    encodedBytes: bytes.byteLength,
    detail,
    renderer: "pdfium",
    fallbackApplied: encoded.fallbackApplied,
    bytes,
  };
}

async function renderPdfJsPage(page, pageNumber, detail) {
  const baseViewport = page.getViewport({ scale: 1 });
  const { scale } = renderDimensions(baseViewport, detail);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const renderTask = page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" });
  await renderTask.promise;
  const encoded = await encodeCanvasWithin(canvas, MAX_ENCODED_PAGE_BYTES, "DOCUMENT_RENDER_TOO_LARGE");
  const bytes = transferableBytes(encoded.bytes);
  return {
    page: pageNumber,
    width: encoded.canvas.width,
    height: encoded.canvas.height,
    mimeType: encoded.mimeType,
    encodedBytes: bytes.byteLength,
    detail,
    renderer: "pdfjs",
    fallbackApplied: encoded.fallbackApplied,
    bytes,
  };
}

async function renderPdf(message) {
  const pages = [...new Set(message.pages)];
  if (pages.length < 1 || pages.length > MAX_PAGES_PER_RENDER || pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw codedError("INVALID_INPUT");
  }
  const { loadingTask, dispose, hasActiveSyntax } = createPdfLoadingTask(message);
  let pdfiumEngine;
  let pdfiumDocument;
  try {
    const document = await loadingTask.promise;
    if (pages.some((page) => page > document.numPages)) throw codedError("INVALID_INPUT");
    const warnings = await documentWarnings(document, hasActiveSyntax);
    const sourceBytes = message.bytes === undefined ? undefined : new Uint8Array(message.bytes);
    if (sourceBytes !== undefined && sourceBytes.byteLength <= MAX_PDFIUM_SOURCE_BYTES) {
      try {
        const { createEngine } = await import("clawpdf");
        pdfiumEngine = await createEngine({ maxRenderPixels: MAX_PDFIUM_RENDER_PIXELS });
        pdfiumDocument = await pdfiumEngine.open(Uint8Array.from(sourceBytes));
        if (pdfiumDocument.pageCount !== document.numPages) throw codedError("DOCUMENT_RENDER_FAILED");
      } catch {
        pdfiumDocument?.destroy();
        pdfiumDocument = undefined;
        await pdfiumEngine?.destroy().catch(() => undefined);
        pdfiumEngine = undefined;
        warnings.push("pdfium-render-fallback");
      }
    }
    const rendered = [];
    for (const pageNumber of pages) {
      const page = await document.getPage(pageNumber);
      try {
        if (pdfiumDocument !== undefined) {
          try {
            rendered.push(await renderPdfiumPage(pdfiumDocument, pageNumber, message.detail));
            continue;
          } catch {
            if (!warnings.includes("pdfium-render-fallback")) warnings.push("pdfium-render-fallback");
          }
        }
        rendered.push(await renderPdfJsPage(page, pageNumber, message.detail));
      } finally {
        page.cleanup();
      }
    }
    return { pageCount: document.numPages, warnings, pages: rendered };
  } finally {
    pdfiumDocument?.destroy();
    await pdfiumEngine?.destroy().catch(() => undefined);
    await loadingTask.destroy().catch(() => undefined);
    dispose();
  }
}

function rasterMetadata(bytes) {
  if (bytes.byteLength >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { sourceMimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      let markerOffset = offset + 1;
      while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) markerOffset += 1;
      const marker = bytes[markerOffset];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset = markerOffset + 1; continue; }
      if (markerOffset + 2 >= bytes.byteLength) break;
      const segmentLength = view.getUint16(markerOffset + 1);
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segmentLength >= 7 && markerOffset + 8 < bytes.byteLength) {
        return { sourceMimeType: "image/jpeg", height: view.getUint16(markerOffset + 4), width: view.getUint16(markerOffset + 6) };
      }
      if (segmentLength < 2) break;
      offset = markerOffset + 1 + segmentLength;
    }
  }
  if (bytes.byteLength >= 30 && new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP") {
    const chunk = new TextDecoder("ascii").decode(bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { sourceMimeType: "image/webp", width, height };
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { sourceMimeType: "image/webp", width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height = 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { sourceMimeType: "image/webp", width, height };
    }
  }
  throw codedError("IMAGE_UNSUPPORTED");
}

async function readImage(message) {
  const bytes = new Uint8Array(message.bytes);
  const metadata = rasterMetadata(bytes);
  if (metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw codedError("IMAGE_TOO_LARGE");
  }
  const image = await loadImage(bytes);
  if (image.width !== metadata.width || image.height !== metadata.height) throw codedError("IMAGE_UNSUPPORTED");
  const targetLongEdge = message.detail === "high" ? 2400 : 1600;
  const scale = Math.min(1, targetLongEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  if (metadata.sourceMimeType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  const encoded = await encodeCanvasWithin(canvas, 2 * 1024 * 1024, "IMAGE_TOO_LARGE");
  const output = transferableBytes(encoded.bytes);
  return {
    sourceMimeType: metadata.sourceMimeType,
    mimeType: encoded.mimeType,
    width: encoded.canvas.width,
    height: encoded.canvas.height,
    encodedBytes: output.byteLength,
    detail: message.detail,
    fallbackApplied: encoded.fallbackApplied || scale < 1,
    bytes: output,
  };
}

const KNOWN_CODES = new Set([
  "INVALID_INPUT", "DOCUMENT_UNSUPPORTED", "DOCUMENT_NO_TEXT", "DOCUMENT_RENDER_FAILED",
  "DOCUMENT_RENDER_TOO_LARGE", "IMAGE_UNSUPPORTED", "IMAGE_TOO_LARGE",
]);

parentPort?.once("message", async (message) => {
  try {
    let value;
    if (message.operation === "render") value = await renderPdf(message);
    else if (message.operation === "image") value = await readImage(message);
    else value = await readPdf(message);
    const transfer = [];
    if (message.operation === "render") {
      for (const page of value.pages) transfer.push(page.bytes.buffer);
    } else if (message.operation === "image") {
      transfer.push(value.bytes.buffer);
    }
    parentPort?.postMessage({ type: "result", ok: true, value }, transfer);
  } catch (error) {
    const code = typeof error?.code === "string" && KNOWN_CODES.has(error.code)
      ? error.code
      : message.operation === "render" ? "DOCUMENT_RENDER_FAILED"
        : message.operation === "image" ? "IMAGE_UNSUPPORTED" : "DOCUMENT_UNSUPPORTED";
    fail(code);
  }
});
