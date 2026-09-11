import { DevelopmentBrokerError } from "@localbridge/development";

function blocked(message: string, code = "WEB_MEDIA_TYPE_MISMATCH"): never {
  throw new DevelopmentBrokerError(code, message);
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0")) blocked(`El ${label} descargado contiene bytes nulos.`);
    return value;
  } catch {
    blocked(`El ${label} descargado no es UTF-8 válido.`);
  }
}

function normalizedMimeType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

const MIME_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  avif: ["image/avif"],
  mp4: ["video/mp4"],
  mov: ["video/quicktime"],
  webm: ["video/webm"],
  css: ["text/css"],
  woff: ["font/woff", "application/font-woff"],
  woff2: ["font/woff2"],
  ttf: ["font/ttf", "application/x-font-ttf", "application/font-sfnt"],
  otf: ["font/otf", "application/x-font-opentype", "application/font-sfnt"],
};

const CANONICAL_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "application/pdf": "pdf", "application/json": "json", "text/csv": "csv", "application/csv": "csv",
  "text/plain": "txt", "text/markdown": "md", "image/png": "png", "image/jpeg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "video/mp4": "mp4",
  "video/quicktime": "mov", "video/webm": "webm", "text/css": "css", "font/woff": "woff",
  "application/font-woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf",
  "application/x-font-ttf": "ttf", "application/font-sfnt": "ttf", "font/otf": "otf",
  "application/x-font-opentype": "otf",
};
const GENERIC_BINARY_MIMES = new Set(["application/octet-stream", "binary/octet-stream"]);
const STRONG_SIGNATURE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "mov", "webm", "woff", "woff2", "ttf", "otf",
]);

function extensionOf(pathValue: string): string | undefined {
  return /\.([A-Za-z0-9]+)$/.exec(pathValue)?.[1]?.toLowerCase();
}

/** Completa o corrige únicamente el nombre final; nunca cambia de carpeta. */
export function resolveDownloadedResourceDestination(pathValue: string, mimeType: string): string {
  const normalizedMime = normalizedMimeType(mimeType);
  const canonical = normalizedMime.endsWith("+json") ? "json" : CANONICAL_EXTENSION_BY_MIME[normalizedMime];
  const extension = extensionOf(pathValue);
  if (canonical === undefined) {
    if (GENERIC_BINARY_MIMES.has(normalizedMime) && extension !== undefined && STRONG_SIGNATURE_EXTENSIONS.has(extension)) return pathValue;
    blocked("El MIME del recurso no corresponde a un formato pasivo admitido.", "WEB_MEDIA_TYPE_UNSUPPORTED");
  }
  const documentExtensionAccepted =
    (extension === "pdf" && normalizedMime === "application/pdf") ||
    (extension === "json" && (normalizedMime === "application/json" || normalizedMime.endsWith("+json"))) ||
    (extension === "csv" && ["text/csv", "application/csv"].includes(normalizedMime)) ||
    ((extension === "txt" || extension === "md") && ["text/plain", "text/markdown"].includes(normalizedMime));
  if (extension !== undefined && (MIME_BY_EXTENSION[extension]?.includes(normalizedMime) === true || documentExtensionAccepted)) {
    return pathValue;
  }
  const separator = Math.max(pathValue.lastIndexOf("/"), pathValue.lastIndexOf("\\"));
  const parent = pathValue.slice(0, separator + 1);
  const filename = pathValue.slice(separator + 1);
  const stem = extension === undefined ? filename : filename.slice(0, -(extension.length + 1));
  if (stem.length === 0) blocked("El destino no contiene un nombre de archivo válido.", "WEB_MEDIA_TYPE_UNSUPPORTED");
  return `${parent}${stem}.${canonical}`;
}

function isoBmffHasBrand(bytes: Uint8Array, accepted: ReadonlySet<string>): boolean {
  if (new TextDecoder("ascii").decode(bytes.subarray(4, 8)) !== "ftyp") return false;
  const decoder = new TextDecoder("ascii");
  if (accepted.has(decoder.decode(bytes.subarray(8, 12)))) return true;
  for (let offset = 16; offset + 4 <= bytes.byteLength; offset += 4) {
    if (accepted.has(decoder.decode(bytes.subarray(offset, offset + 4)))) return true;
  }
  return false;
}

export interface DownloadedResourceStreamValidator {
  readonly mimeType: string;
  write(chunk: Uint8Array): void;
  finish(): void;
}

const MAX_STREAMED_JSON_BYTES = 10 * 1024 * 1024;

/** Valida tipo y firma incrementalmente para no retener assets binarios completos. */
export function createDownloadedResourceStreamValidator(
  pathValue: string,
  mimeType: string,
): DownloadedResourceStreamValidator {
  const extension = extensionOf(pathValue);
  const normalizedMime = normalizedMimeType(mimeType);
  if (extension === undefined) blocked("La descarga necesita una extensión permitida.", "WEB_MEDIA_TYPE_UNSUPPORTED");
  const documentMimes: Readonly<Record<string, readonly string[]>> = {
    pdf: ["application/pdf"],
    json: ["application/json"],
    csv: ["text/csv", "application/csv"],
    txt: ["text/plain", "text/markdown"],
    md: ["text/plain", "text/markdown"],
  };
  const accepted = documentMimes[extension] ?? MIME_BY_EXTENSION[extension];
  const genericAccepted = GENERIC_BINARY_MIMES.has(normalizedMime) && STRONG_SIGNATURE_EXTENSIONS.has(extension);
  const mimeAccepted = extension === 'json'
    ? normalizedMime === 'application/json' || normalizedMime.endsWith('+json')
    : accepted?.includes(normalizedMime) === true || genericAccepted;
  if (!mimeAccepted || extension === 'svg') {
    blocked("La extensión y el MIME del asset no coinciden o no están permitidos.", accepted === undefined ? "WEB_MEDIA_TYPE_UNSUPPORTED" : "WEB_MEDIA_TYPE_MISMATCH");
  }

  const textLike = ['json', 'csv', 'txt', 'md', 'css'].includes(extension);
  const decoder = textLike ? new TextDecoder('utf-8', { fatal: true }) : undefined;
  const jsonChunks: Uint8Array[] = [];
  let jsonSize = 0;
  let prefix = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let size = 0;
  let invalidText = false;
  return {
    get mimeType() {
      return GENERIC_BINARY_MIMES.has(normalizedMime)
        ? (MIME_BY_EXTENSION[extension]?.[0] ?? normalizedMime)
        : normalizedMime;
    },
    write(chunkInput) {
      const chunk = Buffer.from(chunkInput);
      if (chunk.byteLength === 0) return;
      size += chunk.byteLength;
      if (prefix.byteLength < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.byteLength)]);
      tail = Buffer.concat([tail, chunk]).subarray(-2);
      if (decoder !== undefined) {
        try {
          if (decoder.decode(chunk, { stream: true }).includes('\0')) invalidText = true;
        } catch {
          invalidText = true;
        }
      }
      if (extension === 'json') {
        jsonSize += chunk.byteLength;
        if (jsonSize > MAX_STREAMED_JSON_BYTES) blocked('El JSON supera el límite de validación de 10 MiB.');
        jsonChunks.push(chunk);
      }
    },
    finish() {
      if (size === 0) blocked('La descarga no contiene bytes.', 'WEB_DOWNLOAD_EMPTY');
      if (decoder !== undefined) {
        try { if (decoder.decode().includes('\0')) invalidText = true; } catch { invalidText = true; }
        if (invalidText) blocked('El recurso de texto descargado no es UTF-8 válido.');
      }
      switch (extension) {
        case 'pdf':
          if (new TextDecoder('ascii').decode(prefix.subarray(0, 5)) !== '%PDF-') blocked('El recurso no coincide con un PDF permitido.');
          break;
        case 'json':
          try { JSON.parse(Buffer.concat(jsonChunks).toString('utf8')); } catch { blocked('El JSON descargado no es válido.'); }
          break;
        case 'png':
          if (!startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) blocked('El asset no contiene una firma PNG válida.');
          break;
        case 'jpg':
        case 'jpeg':
          if (!startsWith(prefix, [0xff, 0xd8, 0xff]) || tail[0] !== 0xff || tail[1] !== 0xd9) blocked('El asset no contiene una firma JPEG válida.');
          break;
        case 'gif': {
          const signature = new TextDecoder('ascii').decode(prefix.subarray(0, 6));
          if (signature !== 'GIF87a' && signature !== 'GIF89a') blocked('El asset no contiene una firma GIF válida.');
          break;
        }
        case 'webp':
          if (!startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) || new TextDecoder('ascii').decode(prefix.subarray(8, 12)) !== 'WEBP') blocked('El asset no contiene una firma WebP válida.');
          break;
        case 'avif':
          if (!isoBmffHasBrand(prefix, new Set(['avif', 'avis']))) blocked('El asset no contiene una firma AVIF válida.');
          break;
        case 'mp4':
          if (new TextDecoder('ascii').decode(prefix.subarray(4, 8)) !== 'ftyp') blocked('El asset no contiene una firma MP4 válida.');
          break;
        case 'mov':
          if (!isoBmffHasBrand(prefix, new Set(['qt  ']))) blocked('El asset no contiene una firma QuickTime válida.');
          break;
        case 'webm':
          if (!startsWith(prefix, [0x1a, 0x45, 0xdf, 0xa3])) blocked('El asset no contiene una firma WebM válida.');
          break;
        case 'woff':
          if (new TextDecoder('ascii').decode(prefix.subarray(0, 4)) !== 'wOFF') blocked('El asset no contiene una firma WOFF válida.');
          break;
        case 'woff2':
          if (new TextDecoder('ascii').decode(prefix.subarray(0, 4)) !== 'wOF2') blocked('El asset no contiene una firma WOFF2 válida.');
          break;
        case 'ttf':
          if (!startsWith(prefix, [0x00, 0x01, 0x00, 0x00]) && new TextDecoder('ascii').decode(prefix.subarray(0, 4)) !== 'true') blocked('El asset no contiene una firma TTF válida.');
          break;
        case 'otf':
          if (new TextDecoder('ascii').decode(prefix.subarray(0, 4)) !== 'OTTO') blocked('El asset no contiene una firma OTF válida.');
          break;
      }
    },
  };
}

/** Permite únicamente documentos pasivos cuyo tipo declarado coincide con el destino. */
export function validateDownloadedDocument(pathValue: string, mimeType: string, bytes: Uint8Array): void {
  const extension = /\.([A-Za-z0-9]+)$/.exec(pathValue)?.[1]?.toLowerCase();
  const normalizedMime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  if (extension === "pdf") {
    if (normalizedMime !== "application/pdf" || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
      blocked("El recurso no coincide con un PDF permitido.");
    }
    return;
  }
  if (extension === "json") {
    if (!(normalizedMime === "application/json" || normalizedMime.endsWith("+json"))) blocked("El recurso no coincide con JSON permitido.");
    try { JSON.parse(textDecoder.decode(bytes)); } catch { blocked("El JSON descargado no es válido."); }
    return;
  }
  if (extension === "csv") {
    if (!["text/csv", "application/csv"].includes(normalizedMime)) blocked("El recurso no coincide con CSV permitido.");
    try { if (textDecoder.decode(bytes).includes("\0")) throw new Error(); } catch { blocked("El CSV descargado no es texto UTF-8 válido."); }
    return;
  }
  if (extension === "txt" || extension === "md") {
    if (!["text/plain", "text/markdown"].includes(normalizedMime)) blocked("El recurso no coincide con texto permitido.");
    try { if (textDecoder.decode(bytes).includes("\0")) throw new Error(); } catch { blocked("El texto descargado no es UTF-8 válido."); }
    return;
  }
  blocked("La extensión de descarga no está permitida.", "WEB_MEDIA_TYPE_UNSUPPORTED");
}

/**
 * Valida assets pasivos observados por el navegador. La extensión, el MIME y la
 * firma deben coincidir. SVG se deniega porque es un documento activo y no puede
 * validarse con seguridad mediante inspección superficial.
 * Devuelve el MIME canónico que puede exponerse en el recibo.
 */
export function validateDownloadedResource(pathValue: string, mimeType: string, bytes: Uint8Array): string {
  const extension = extensionOf(pathValue);
  const normalizedMime = normalizedMimeType(mimeType);
  if (extension === undefined) blocked("La descarga necesita una extensión permitida.", "WEB_MEDIA_TYPE_UNSUPPORTED");
  if (["pdf", "json", "csv", "txt", "md"].includes(extension)) {
    validateDownloadedDocument(pathValue, normalizedMime, bytes);
    return normalizedMime;
  }
  const allowedMimes = MIME_BY_EXTENSION[extension];
  const genericAccepted = GENERIC_BINARY_MIMES.has(normalizedMime) && STRONG_SIGNATURE_EXTENSIONS.has(extension);
  if (allowedMimes === undefined || (!allowedMimes.includes(normalizedMime) && !genericAccepted)) {
    blocked("La extensión y el MIME del asset no coinciden o no están permitidos.", allowedMimes === undefined ? "WEB_MEDIA_TYPE_UNSUPPORTED" : "WEB_MEDIA_TYPE_MISMATCH");
  }
  switch (extension) {
    case "png":
      if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) blocked("El asset no contiene una firma PNG válida.");
      break;
    case "jpg":
    case "jpeg":
      if (!startsWith(bytes, [0xff, 0xd8, 0xff]) || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) blocked("El asset no contiene una firma JPEG válida.");
      break;
    case "gif": {
      const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 6));
      if (signature !== "GIF87a" && signature !== "GIF89a") blocked("El asset no contiene una firma GIF válida.");
      break;
    }
    case "webp":
      if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) || new TextDecoder("ascii").decode(bytes.subarray(8, 12)) !== "WEBP") blocked("El asset no contiene una firma WebP válida.");
      break;
    case "avif":
      if (!isoBmffHasBrand(bytes.subarray(0, 64), new Set(["avif", "avis"]))) blocked("El asset no contiene una firma AVIF válida.");
      break;
    case "mp4":
      if (new TextDecoder("ascii").decode(bytes.subarray(4, 8)) !== "ftyp") blocked("El asset no contiene una firma MP4 válida.");
      break;
    case "mov":
      if (!isoBmffHasBrand(bytes.subarray(0, 64), new Set(["qt  "]))) blocked("El asset no contiene una firma QuickTime válida.");
      break;
    case "webm":
      if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) blocked("El asset no contiene una firma WebM válida.");
      break;
    case "css":
      decodeUtf8(bytes, "CSS");
      break;
    case "woff":
      if (new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "wOFF") blocked("El asset no contiene una firma WOFF válida.");
      break;
    case "woff2":
      if (new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "wOF2") blocked("El asset no contiene una firma WOFF2 válida.");
      break;
    case "ttf":
      if (!startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) && new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "true") blocked("El asset no contiene una firma TTF válida.");
      break;
    case "otf":
      if (new TextDecoder("ascii").decode(bytes.subarray(0, 4)) !== "OTTO") blocked("El asset no contiene una firma OTF válida.");
      break;
  }
  return genericAccepted ? (allowedMimes[0] ?? normalizedMime) : normalizedMime;
}
