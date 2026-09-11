import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { LocalBridgeError, type ErrorCode } from "@localbridge/shared";

const DOCUMENT_READ_TIMEOUT_MS = 15_000;
const DOCUMENT_RENDER_TIMEOUT_MS = 30_000;
const IMAGE_READ_TIMEOUT_MS = 20_000;
const INITIAL_RANGE_BYTES = 64 * 1024;
const FULL_RENDER_SOURCE_BYTES = 64 * 1024 * 1024;
const FULL_RENDER_RANGE_BYTES = 4 * 1024 * 1024;

export type DocumentPageClassification = "text" | "mixed" | "visual" | "empty";
export type VisualDetail = "standard" | "high";

export interface DocumentPageSummary {
  readonly page: number;
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly textCharacters: number;
  readonly hasRasterImages: boolean;
  readonly hasVectorDrawing: boolean;
  readonly classification: DocumentPageClassification;
}

export interface DocumentReadOptions {
  readonly startPage?: number;
  readonly endPage?: number;
  readonly maxChars: number;
  readonly workerPath?: string;
  readonly signal?: AbortSignal;
}

export interface ParsedDocument {
  readonly pageCount: number;
  readonly startPage: number;
  readonly endPage: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly warnings: readonly ("active-content-ignored" | "attachments-ignored")[];
  readonly pageSummaries: readonly DocumentPageSummary[];
  readonly recommendedMode: "text" | "mixed" | "visual";
  readonly hasMorePages: boolean;
  readonly nextPage?: number;
}

export interface DocumentRangeSource {
  readonly size: number;
  readonly hasActivePdfSyntax?: boolean;
  readRange(offset: number, length: number): Promise<Uint8Array>;
}

export interface DocumentRenderOptions {
  readonly pages: readonly number[];
  readonly detail: VisualDetail;
  readonly workerPath?: string;
  readonly signal?: AbortSignal;
}

export interface RenderedDocumentPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly encodedBytes: number;
  readonly detail: VisualDetail;
  readonly renderer: "pdfium" | "pdfjs";
  readonly fallbackApplied: boolean;
  readonly bytes: Uint8Array;
}

export interface RenderedDocument {
  readonly pageCount: number;
  readonly warnings: readonly ("active-content-ignored" | "attachments-ignored" | "pdfium-render-fallback")[];
  readonly pages: readonly RenderedDocumentPage[];
}

export interface RasterReadOptions {
  readonly detail: VisualDetail;
  readonly workerPath?: string;
}

export interface ReadRasterImage {
  readonly sourceMimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly encodedBytes: number;
  readonly detail: VisualDetail;
  readonly fallbackApplied: boolean;
  readonly bytes: Uint8Array;
}

type WorkerOperation = "read" | "render" | "image";

const MAX_RENDER_WAITERS = 8;
let renderActive = false;
const renderWaiters: Array<() => void> = [];

async function acquireRenderSlot(): Promise<() => void> {
  if (renderActive) {
    if (renderWaiters.length >= MAX_RENDER_WAITERS) throw new LocalBridgeError("RATE_LIMITED");
    await new Promise<void>((resolve) => renderWaiters.push(resolve));
  }
  renderActive = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = renderWaiters.shift();
    if (next === undefined) renderActive = false;
    else next();
  };
}

function defaultWorkerPath(): string {
  return fileURLToPath(new URL("./document-worker.mjs", import.meta.url));
}

function isRangeSource(source: Uint8Array | DocumentRangeSource): source is DocumentRangeSource {
  return !(source instanceof Uint8Array) && typeof source.readRange === "function";
}

async function materializeRangeSource(source: DocumentRangeSource): Promise<Uint8Array> {
  const bytes = new Uint8Array(source.size);
  for (let offset = 0; offset < source.size; offset += FULL_RENDER_RANGE_BYTES) {
    const length = Math.min(FULL_RENDER_RANGE_BYTES, source.size - offset);
    const range = await source.readRange(offset, length);
    if (range.byteLength !== length) throw new LocalBridgeError("DOCUMENT_UNSUPPORTED");
    bytes.set(range, offset);
  }
  return bytes;
}

async function workerSource(operation: WorkerOperation, source: Uint8Array | DocumentRangeSource): Promise<{
  readonly payload: Record<string, unknown>;
  readonly transfer: ArrayBuffer[];
}> {
  if (!isRangeSource(source)) {
    const bytes = Uint8Array.from(source);
    return { payload: { bytes: bytes.buffer }, transfer: [bytes.buffer] };
  }
  if (!Number.isSafeInteger(source.size) || source.size < 5) throw new LocalBridgeError("DOCUMENT_UNSUPPORTED");
  if (operation === "render" && source.size <= FULL_RENDER_SOURCE_BYTES) {
    const bytes = await materializeRangeSource(source);
    const buffer = bytes.buffer as ArrayBuffer;
    return { payload: { bytes: buffer }, transfer: [buffer] };
  }
  const initial = Uint8Array.from(await source.readRange(0, Math.min(INITIAL_RANGE_BYTES, source.size)));
  return {
    payload: {
      source: {
        kind: "range",
        length: source.size,
        initialData: initial.buffer,
        hasActivePdfSyntax: source.hasActivePdfSyntax === true,
      },
    },
    transfer: [initial.buffer],
  };
}

async function runWorker<T>(
  operation: WorkerOperation,
  source: Uint8Array | DocumentRangeSource,
  request: Record<string, unknown>,
  workerPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  assertAnalysisNotCancelled(signal);
  const prepared = await workerSource(operation, source);
  assertAnalysisNotCancelled(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath ?? defaultWorkerPath(), {
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (effect: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      effect();
    };
    const abort = (): void => finish(() => reject(new LocalBridgeError('ANALYSIS_CANCELLED')));
    const timer = setTimeout(() => finish(() => reject(new LocalBridgeError("TIMEOUT"))), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once("error", () => finish(() => reject(new LocalBridgeError(
      operation === "render" ? "DOCUMENT_RENDER_FAILED" : operation === "image" ? "IMAGE_UNSUPPORTED" : "DOCUMENT_UNSUPPORTED",
    ))));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(new LocalBridgeError(
        operation === "render" ? "DOCUMENT_RENDER_FAILED" : operation === "image" ? "IMAGE_UNSUPPORTED" : "DOCUMENT_UNSUPPORTED",
      )));
    });
    worker.on("message", (message: unknown) => {
      const result = message as {
        type?: string;
        requestId?: number;
        begin?: number;
        end?: number;
        ok?: boolean;
        code?: ErrorCode;
        value?: T;
      };
      if (result.type === "range-request") {
        if (!isRangeSource(source) || result.requestId === undefined || result.begin === undefined || result.end === undefined) {
          finish(() => reject(new LocalBridgeError("DOCUMENT_UNSUPPORTED")));
          return;
        }
        const length = result.end - result.begin;
        void source.readRange(result.begin, length).then((range) => {
          if (settled) return;
          const bytes = Uint8Array.from(range);
          worker.postMessage({
            type: "range-response",
            requestId: result.requestId,
            begin: result.begin,
            ok: true,
            bytes: bytes.buffer,
          }, [bytes.buffer]);
        }).catch((error: unknown) => finish(() => reject(error)));
        return;
      }
      if (result.type !== "result") return;
      if (result.ok === true && result.value !== undefined) finish(() => resolve(result.value as T));
      else finish(() => reject(new LocalBridgeError(result.code ?? (
        operation === "render" ? "DOCUMENT_RENDER_FAILED" : operation === "image" ? "IMAGE_UNSUPPORTED" : "DOCUMENT_UNSUPPORTED"
      ))));
    });
    worker.postMessage({ operation, ...prepared.payload, ...request }, prepared.transfer);
  });
}

function assertAnalysisNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new LocalBridgeError('ANALYSIS_CANCELLED');
}

export function parsePdfDocument(
  source: Uint8Array | DocumentRangeSource,
  options: DocumentReadOptions,
): Promise<ParsedDocument> {
  return runWorker<ParsedDocument>("read", source, {
    maxChars: options.maxChars,
    ...(options.startPage === undefined ? {} : { startPage: options.startPage }),
    ...(options.endPage === undefined ? {} : { endPage: options.endPage }),
  }, options.workerPath, DOCUMENT_READ_TIMEOUT_MS, options.signal);
}

export function renderPdfDocument(
  source: Uint8Array | DocumentRangeSource,
  options: DocumentRenderOptions,
): Promise<RenderedDocument> {
  return acquireRenderSlot().then(async (release) => {
    try {
      return await runWorker<RenderedDocument>("render", source, {
        pages: [...options.pages],
        detail: options.detail,
      }, options.workerPath, DOCUMENT_RENDER_TIMEOUT_MS, options.signal);
    } finally {
      release();
    }
  });
}

export function readRasterImage(bytes: Uint8Array, options: RasterReadOptions): Promise<ReadRasterImage> {
  return runWorker<ReadRasterImage>("image", bytes, { detail: options.detail }, options.workerPath, IMAGE_READ_TIMEOUT_MS);
}
