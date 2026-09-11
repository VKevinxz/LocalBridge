import { createHash, createHmac, randomBytes } from 'node:crypto';

import {
  openWorkspaceArtifactSource,
  type WorkspaceArtifactSource,
} from '@localbridge/filesystem';
import { parsePdfDocument, renderPdfDocument } from '@localbridge/mcp-server';
import { requireAuthorizedWorkspace } from '@localbridge/permissions';
import { LocalBridgeError, type Logger } from '@localbridge/shared';
import type {
  AnalysisJobExecutionContext,
  AnalysisJobExecutionResult,
  AnalysisJobRequest,
  AnalysisResultItem,
} from '@localbridge/development';
import type { AuthorizedWorkspace } from '@localbridge/workspace';

const MANAGED_STANDARD_BYTES = 1024 * 1024 * 1024;
const PDF_STANDARD_BYTES = 250 * 1024 * 1024;
const INSPECTION_SAMPLE_BYTES = 64 * 1024;

interface ArtifactAnalysisRuntimeOptions {
  readonly workspaceConfigPath: string;
  readonly logger: Logger;
  readonly documentWorkerPath?: string;
  /** Clave local estable; no concede autoridad y solo evita cursores alterados. */
  readonly cursorSigningKey?: Uint8Array;
  readonly webDownload?: (
    sessionId: string,
    tabId: string,
    resourceRef: string,
    workspaceId: string,
    path: string,
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

interface TextCursorPayload {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly fileIdentity: string;
  readonly offset: number;
  readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LocalBridgeError('INVALID_INPUT');
  return value as Record<string, unknown>;
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalBridgeError('ANALYSIS_CANCELLED');
}

function detectArtifact(sample: Buffer, path: string): {
  readonly detectedType: string;
  readonly signatures: readonly string[];
  readonly recommendedTool?: string;
} {
  const signatures: string[] = [];
  let detectedType = 'application/octet-stream';
  let recommendedTool: string | undefined = 'binary.inspect';
  if (sample.subarray(0, 4).toString('ascii') === '%PDF') {
    detectedType = 'application/pdf';
    signatures.push('PDF');
    recommendedTool = 'document.process';
  } else if (sample.length >= 64 && sample[0] === 0x4d && sample[1] === 0x5a) {
    detectedType = 'application/vnd.microsoft.portable-executable';
    signatures.push('MZ');
    recommendedTool = 'binary.inspect';
  } else if (sample.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    detectedType = 'application/x-elf';
    signatures.push('ELF');
  } else if (sample.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    detectedType = 'application/zip';
    signatures.push('ZIP');
  } else if (sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    detectedType = 'image/png';
    signatures.push('PNG');
    recommendedTool = 'image.read';
  } else if (sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    detectedType = 'image/jpeg';
    signatures.push('JPEG');
    recommendedTool = 'image.read';
  } else if (sample.subarray(0, 4).toString('ascii') === 'RIFF' && sample.subarray(8, 12).toString('ascii') === 'WEBP') {
    detectedType = 'image/webp';
    signatures.push('RIFF/WEBP');
    recommendedTool = 'image.read';
  } else if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) {
    detectedType = 'text/plain';
    signatures.push(sample[0] === 0xff ? 'UTF-16LE-BOM' : 'UTF-16BE-BOM');
    recommendedTool = 'artifact.text.read';
  } else if (!sample.includes(0)) {
    detectedType = path.toLowerCase().endsWith('.json') ? 'application/json' : 'text/plain';
    signatures.push(sample.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'UTF-8-BOM' : 'text-no-nul');
    recommendedTool = 'artifact.text.read';
  }
  return { detectedType, signatures, ...(recommendedTool === undefined ? {} : { recommendedTool }) };
}

function entropyFromCounts(counts: Uint32Array, total: number): number {
  if (total === 0) return 0;
  let result = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / total;
    result -= probability * Math.log2(probability);
  }
  return Number(result.toFixed(4));
}

function peArchitecture(machine: number): string {
  return ({ 0x014c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c4: 'arm-thumb2' } as Record<number, string>)[machine] ?? `unknown-0x${machine.toString(16)}`;
}

async function readCString(source: WorkspaceArtifactSource, offset: number, maximum = 4096): Promise<string> {
  if (offset < 0 || offset >= source.identity.size) return '';
  const length = Math.min(maximum, source.identity.size - offset);
  const bytes = await source.readRange(offset, length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8').replaceAll(/[^\x20-\x7e]/g, '');
}

interface PeSection {
  readonly name: string;
  readonly virtualSize: number;
  readonly virtualAddress: number;
  readonly rawSize: number;
  readonly rawOffset: number;
  readonly characteristics: number;
}

function rvaToOffset(rva: number, sections: readonly PeSection[]): number | undefined {
  const section = sections.find((candidate) =>
    rva >= candidate.virtualAddress && rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize));
  if (section === undefined) return rva < 4096 ? rva : undefined;
  const delta = rva - section.virtualAddress;
  return delta < section.rawSize ? section.rawOffset + delta : undefined;
}

async function hashSource(source: WorkspaceArtifactSource, context: AnalysisJobExecutionContext, stage = 'hashing'): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of source.readSequential({ signal: context.signal })) {
    abortIfRequested(context.signal);
    hash.update(chunk);
    const counters = source.counters();
    context.progress({ stage, completed: counters.bytesRead, total: source.identity.size, unit: 'bytes', coverage: counters });
  }
  await source.assertStable();
  return hash.digest('hex');
}

async function inspectPe(source: WorkspaceArtifactSource, depth: 'quick' | 'standard' | 'deep', context: AnalysisJobExecutionContext): Promise<Record<string, unknown>> {
  const dos = await source.readRange(0, Math.min(64, source.identity.size));
  if (dos.length < 64 || dos[0] !== 0x4d || dos[1] !== 0x5a) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > source.identity.size) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const fixedHeader = await source.readRange(peOffset, 24);
  if (fixedHeader.subarray(0, 4).toString('binary') !== 'PE\0\0') throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const machine = fixedHeader.readUInt16LE(4);
  const numberOfSections = fixedHeader.readUInt16LE(6);
  if (numberOfSections < 1 || numberOfSections > 96) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const timestamp = fixedHeader.readUInt32LE(8);
  const optionalSize = fixedHeader.readUInt16LE(20);
  const characteristics = fixedHeader.readUInt16LE(22);
  const headerLength = 24 + optionalSize + numberOfSections * 40;
  if (optionalSize < 96 || peOffset + headerLength > source.identity.size) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const header = await source.readRange(peOffset, headerLength);
  const optional = header.subarray(24, 24 + optionalSize);
  const magic = optional.readUInt16LE(0);
  const pe32Plus = magic === 0x20b;
  if (!pe32Plus && magic !== 0x10b) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
  const entryPoint = optional.readUInt32LE(16);
  const imageBase = pe32Plus ? optional.readBigUInt64LE(24).toString() : String(optional.readUInt32LE(28));
  const dllCharacteristics = optional.readUInt16LE(pe32Plus ? 70 : 66);
  const directoryOffset = pe32Plus ? 112 : 96;
  const dataDirectory = (index: number) => optionalSize >= directoryOffset + (index + 1) * 8
    ? { rva: optional.readUInt32LE(directoryOffset + index * 8), size: optional.readUInt32LE(directoryOffset + index * 8 + 4) }
    : { rva: 0, size: 0 };
  const sections: PeSection[] = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const start = 24 + optionalSize + index * 40;
    const item = header.subarray(start, start + 40);
    const nul = item.subarray(0, 8).indexOf(0);
    sections.push({
      name: item.subarray(0, nul === -1 ? 8 : nul).toString('ascii'),
      virtualSize: item.readUInt32LE(8),
      virtualAddress: item.readUInt32LE(12),
      rawSize: item.readUInt32LE(16),
      rawOffset: item.readUInt32LE(20),
      characteristics: item.readUInt32LE(36),
    });
  }
  const sectionResults: Array<Record<string, unknown>> = [];
  const printableStrings: string[] = [];
  const maximumStrings = depth === 'deep' ? 512 : 256;
  let stringsTruncated = false;
  for (const section of sections) {
    const validSize = section.rawOffset < source.identity.size ? Math.min(section.rawSize, source.identity.size - section.rawOffset) : 0;
    let sectionHash: string | undefined;
    let sectionEntropy: number | undefined;
    if (depth !== 'quick' && validSize > 0) {
      const hash = createHash('sha256');
      const counts = new Uint32Array(256);
      let sampled = 0;
      let printable = '';
      for (let offset = 0; offset < validSize; offset += 1024 * 1024) {
        abortIfRequested(context.signal);
        const bytes = await source.readRange(section.rawOffset + offset, Math.min(1024 * 1024, validSize - offset));
        hash.update(bytes);
        for (const byte of bytes) {
          counts[byte] = (counts[byte] ?? 0) + 1;
          if (byte >= 0x20 && byte <= 0x7e) {
            if (printable.length < 512) printable += String.fromCharCode(byte);
            else stringsTruncated = true;
          } else {
            if (printable.length >= 6) {
              if (printableStrings.length < maximumStrings) printableStrings.push(printable);
              else stringsTruncated = true;
            }
            printable = '';
          }
        }
        sampled += bytes.length;
      }
      if (printable.length >= 6) {
        if (printableStrings.length < maximumStrings) printableStrings.push(printable);
        else stringsTruncated = true;
      }
      sectionHash = hash.digest('hex');
      sectionEntropy = entropyFromCounts(counts, sampled);
    }
    sectionResults.push({ ...section, ...(sectionHash === undefined ? {} : { sha256: sectionHash }), ...(sectionEntropy === undefined ? {} : { entropy: sectionEntropy }) });
  }
  const importDirectory = dataDirectory(1);
  const imports: Array<Record<string, unknown>> = [];
  const maximumFunctions = depth === 'deep' ? 4096 : 1024;
  let deliveredFunctions = 0;
  let importsTruncated = false;
  const importOffset = rvaToOffset(importDirectory.rva, sections);
  if (importOffset !== undefined && importOffset < source.identity.size && importDirectory.size >= 20) {
    const tableLength = Math.min(importDirectory.size, (depth === 'deep' ? 256 : 128) * 20, source.identity.size - importOffset);
    if (tableLength < 20) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
    const descriptors = await source.readRange(importOffset, tableLength);
    for (let offset = 0; offset + 20 <= descriptors.length; offset += 20) {
      const originalThunk = descriptors.readUInt32LE(offset);
      const nameRva = descriptors.readUInt32LE(offset + 12);
      const firstThunk = descriptors.readUInt32LE(offset + 16);
      if (originalThunk === 0 && nameRva === 0 && firstThunk === 0) break;
      const nameOffset = rvaToOffset(nameRva, sections);
      const moduleName = nameOffset === undefined ? '' : await readCString(source, nameOffset, 256);
      const functions: string[] = [];
      if (depth !== 'quick') {
        const thunkOffset = rvaToOffset(originalThunk || firstThunk, sections);
        if (thunkOffset !== undefined) {
          const pointerSize = pe32Plus ? 8 : 4;
          const maximumEntries = maximumFunctions - deliveredFunctions;
          if (maximumEntries < 1) {
            importsTruncated = true;
            imports.push({ module: moduleName || `rva-0x${nameRva.toString(16)}`, functions });
            break;
          }
          const bytes = await source.readRange(thunkOffset, Math.min(maximumEntries * pointerSize, source.identity.size - thunkOffset));
          for (let index = 0; index + pointerSize <= bytes.length; index += pointerSize) {
            const value = pe32Plus ? bytes.readBigUInt64LE(index) : BigInt(bytes.readUInt32LE(index));
            if (value === 0n) break;
            const ordinalFlag = pe32Plus ? 0x8000000000000000n : 0x80000000n;
            if ((value & ordinalFlag) !== 0n) functions.push(`#${Number(value & 0xffffn)}`);
            else {
              const hintNameOffset = rvaToOffset(Number(value), sections);
              if (hintNameOffset !== undefined && hintNameOffset + 2 < source.identity.size) functions.push(await readCString(source, hintNameOffset + 2, 256));
            }
            deliveredFunctions += 1;
          }
        }
      }
      imports.push({ module: moduleName || `rva-0x${nameRva.toString(16)}`, functions });
    }
  }
  const exportDirectory = dataDirectory(0);
  const exports: string[] = [];
  const exportOffset = rvaToOffset(exportDirectory.rva, sections);
  if (exportOffset !== undefined && exportDirectory.size >= 40) {
    const directory = await source.readRange(exportOffset, Math.min(40, source.identity.size - exportOffset));
    if (directory.length === 40) {
      const declaredNameCount = directory.readUInt32LE(24);
      const nameCount = Math.min(declaredNameCount, 2048);
      const namesOffset = rvaToOffset(directory.readUInt32LE(32), sections);
      if (namesOffset !== undefined && nameCount > 0) {
        const names = await source.readRange(namesOffset, Math.min(nameCount * 4, source.identity.size - namesOffset));
        for (let offset = 0; offset + 4 <= names.length; offset += 4) {
          const nameOffset = rvaToOffset(names.readUInt32LE(offset), sections);
          if (nameOffset !== undefined) exports.push(await readCString(source, nameOffset, 256));
        }
      }
    }
  }
  const securityDirectory = dataDirectory(4);
  const resourceDirectory = dataDirectory(2);
  let resources: Record<string, unknown> = { present: false };
  const resourceOffset = rvaToOffset(resourceDirectory.rva, sections);
  if (resourceOffset !== undefined && resourceDirectory.size >= 16 && resourceOffset + 16 <= source.identity.size) {
    const root = await source.readRange(resourceOffset, Math.min(resourceDirectory.size, 16 + 256 * 8, source.identity.size - resourceOffset));
    const namedEntries = root.readUInt16LE(12);
    const idEntries = root.readUInt16LE(14);
    const deliveredEntries = Math.min(namedEntries + idEntries, Math.floor((root.length - 16) / 8));
    const typeIds: number[] = [];
    for (let index = 0; index < deliveredEntries; index += 1) {
      const identifier = root.readUInt32LE(16 + index * 8);
      if ((identifier & 0x80000000) === 0) typeIds.push(identifier & 0xffff);
    }
    resources = {
      present: true,
      rva: resourceDirectory.rva,
      size: resourceDirectory.size,
      namedEntries,
      idEntries,
      typeIds,
      versionResourcePresent: typeIds.includes(16),
      truncated: deliveredEntries < namedEntries + idEntries,
    };
  }
  const overlayOffset = sections.reduce((maximum, section) => Math.max(maximum, section.rawOffset + section.rawSize), 0);
  const sha256 = depth === 'quick' ? undefined : await hashSource(source, context, 'hashing-source');
  return {
    format: 'PE', architecture: peArchitecture(machine), pe32Plus, timestamp, characteristics,
    entryPoint, imageBase, dllCharacteristics,
    mitigations: {
      dynamicBase: (dllCharacteristics & 0x40) !== 0,
      nxCompatible: (dllCharacteristics & 0x100) !== 0,
      controlFlowGuard: (dllCharacteristics & 0x4000) !== 0,
    },
    sections: sectionResults,
    imports,
    exports,
    resources,
    printableStrings,
    authenticode: { present: securityDirectory.rva > 0 && securityDirectory.size > 0, offset: securityDirectory.rva, size: securityDirectory.size, chainTrust: 'not-verified' },
    overlay: { offset: Math.min(overlayOffset, source.identity.size), size: Math.max(0, source.identity.size - overlayOffset) },
    ...(sha256 === undefined ? { sha256State: 'not-requested' } : { sha256State: 'complete', sha256 }),
    warnings: [
      'Static structure only; this result does not classify the file as safe or malicious.',
      ...(depth === 'quick' ? ['Quick depth omits function imports, section hashes and full source hash.'] : []),
      ...(importsTruncated ? ['Import functions were truncated to keep the result bounded.'] : []),
      ...(stringsTruncated ? ['Printable strings were truncated to keep the result bounded.'] : []),
    ],
  };
}

export class ArtifactAnalysisRuntime {
  private readonly cursorKey: Uint8Array;

  constructor(private readonly options: ArtifactAnalysisRuntimeOptions) {
    this.cursorKey = options.cursorSigningKey ?? randomBytes(32);
  }

  private cursor(payload: TextCursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorKey).update(body).digest('base64url')}`;
  }

  private parseCursor(value: unknown): TextCursorPayload | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 512) throw new LocalBridgeError('INVALID_INPUT');
    const [body, signature, extra] = value.split('.');
    if (body === undefined || signature === undefined || extra !== undefined ||
      createHmac('sha256', this.cursorKey).update(body).digest('base64url') !== signature) throw new LocalBridgeError('INVALID_INPUT');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new LocalBridgeError('INVALID_INPUT'); }
    const record = asRecord(parsed);
    const encoding = record['encoding'];
    if (typeof record['workspaceId'] !== 'string' || typeof record['relativePath'] !== 'string' ||
      typeof record['fileIdentity'] !== 'string' || !Number.isSafeInteger(record['offset']) || Number(record['offset']) < 0 ||
      (encoding !== 'utf-8' && encoding !== 'utf-16le' && encoding !== 'utf-16be')) throw new LocalBridgeError('INVALID_INPUT');
    return record as unknown as TextCursorPayload;
  }

  private async workspace(request: AnalysisJobRequest): Promise<AuthorizedWorkspace> {
    return requireAuthorizedWorkspace(this.options.workspaceConfigPath, this.options.logger, request.workspaceId, request.operationKind === 'web.download.start' ? 'write' : 'read');
  }

  private authorityCheck(workspace: AuthorizedWorkspace, request: AnalysisJobRequest): () => Promise<void> {
    return async () => {
      const current = await requireAuthorizedWorkspace(this.options.workspaceConfigPath, this.options.logger, request.workspaceId, 'read');
      if (current.rootPath !== workspace.rootPath || JSON.stringify(current.denyPatterns) !== JSON.stringify(workspace.denyPatterns)) {
        throw new LocalBridgeError('CAPABILITY_DISABLED');
      }
    };
  }

  private async source(request: AnalysisJobRequest, context: AnalysisJobExecutionContext, standardLimitBytes: number): Promise<WorkspaceArtifactSource> {
    const workspace = await this.workspace(request);
    return openWorkspaceArtifactSource(workspace, request.sourcePath!, {
      standardLimitBytes,
      signal: context.signal,
      checkAuthority: this.authorityCheck(workspace, request),
    });
  }

  readonly execute = async (request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> => {
    abortIfRequested(context.signal);
    if (request.operationKind === 'web.download.start') return this.download(request, context);
    if (request.operationKind === 'document.process') return this.document(request, context);
    if (request.operationKind === 'artifact.inspect') return this.inspect(request, context);
    if (request.operationKind === 'artifact.hash') return this.hash(request, context);
    if (request.operationKind === 'artifact.text.read') return this.text(request, context);
    return this.binary(request, context);
  };

  private async inspect(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    const source = await this.source(request, context, MANAGED_STANDARD_BYTES);
    try {
      const sample = source.identity.size === 0
        ? Buffer.alloc(0)
        : await source.readRange(0, Math.min(INSPECTION_SAMPLE_BYTES, source.identity.size));
      const detection = detectArtifact(sample, source.identity.relativePath);
      const output = { path: source.identity.relativePath, size: source.identity.size, modifiedAt: source.identity.modifiedAt, ...detection, identityReceipt: source.identity.fileIdentity, sha256State: 'not-requested' };
      const counters = source.counters();
      return { summary: output, coverage: { status: 'partial', ...counters, sourceBytes: source.identity.size, omissions: ['content-not-returned'] }, items: [{ kind: 'json', value: output }] };
    } finally { await source.close(); }
  }

  private async hash(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    const source = await this.source(request, context, MANAGED_STANDARD_BYTES);
    try {
      const sha256 = await hashSource(source, context);
      const counters = source.counters();
      const output = { path: source.identity.relativePath, size: source.identity.size, modifiedAt: source.identity.modifiedAt, identityReceipt: source.identity.fileIdentity, sha256, sha256State: 'complete' };
      return { summary: output, coverage: { status: 'supported', ...counters, sourceBytes: source.identity.size }, items: [{ kind: 'json', value: output }] };
    } finally { await source.close(); }
  }

  private async text(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    const parameters = asRecord(request.parameters);
    const maxChars = Number(parameters['maxChars']);
    const source = await this.source(request, context, (await this.workspace(request)).limits.maxFileBytes);
    try {
      const previous = this.parseCursor(parameters['cursor']);
      if (previous !== undefined && (previous.workspaceId !== request.workspaceId || previous.relativePath !== source.identity.relativePath || previous.fileIdentity !== source.identity.fileIdentity)) {
        throw new LocalBridgeError('HASH_MISMATCH');
      }
      const offset = previous?.offset ?? 0;
      if (offset > source.identity.size) throw new LocalBridgeError('INVALID_INPUT');
      let encoding: TextCursorPayload['encoding'] = previous?.encoding ?? 'utf-8';
      let contentOffset = offset;
      if (previous === undefined && source.identity.size > 0) {
        const prefix = await source.readRange(0, Math.min(3, source.identity.size));
        if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) {
          encoding = 'utf-16le';
          contentOffset = 2;
        } else if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) {
          encoding = 'utf-16be';
          contentOffset = 2;
        } else if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
          contentOffset = 3;
        }
      }
      const requestedBytes = encoding === 'utf-8' ? 4 * maxChars + 3 : 2 * maxChars + 2;
      const bytes = contentOffset === source.identity.size
        ? Buffer.alloc(0)
        : await source.readRange(contentOffset, Math.min(source.identity.size - contentOffset, Math.min(requestedBytes, 4 * 1024 * 1024)));
      if (encoding === 'utf-8' && bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
      let complete = bytes;
      let decoded: string | undefined;
      const trimStep = encoding === 'utf-8' ? 1 : 2;
      const maximumTrim = encoding === 'utf-8' ? Math.min(3, bytes.length) : Math.min(2, bytes.length);
      for (let trim = 0; trim <= maximumTrim; trim += trimStep) {
        try {
          complete = bytes.subarray(0, bytes.length - trim);
          if (encoding !== 'utf-8' && complete.length % 2 !== 0) continue;
          decoded = new TextDecoder(encoding, { fatal: true }).decode(complete);
          break;
        } catch {
          // Un corte de rango puede dividir el último carácter UTF-8. Solo se
          // toleran hasta tres bytes incompletos al final; otro error no es texto UTF-8.
        }
      }
      if (decoded === undefined) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
      let text = decoded.slice(0, maxChars);
      if (/^[\uD800-\uDBFF]$/.test(text.at(-1) ?? '')) text = text.slice(0, -1);
      const consumed = Buffer.byteLength(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
      const nextOffset = Math.min(source.identity.size, contentOffset + consumed);
      const output = {
        path: source.identity.relativePath,
        text,
        encoding,
        startByte: offset,
        endByte: nextOffset,
        truncated: nextOffset < source.identity.size,
        ...(nextOffset < source.identity.size ? { nextCursor: this.cursor({ workspaceId: request.workspaceId, relativePath: source.identity.relativePath, fileIdentity: source.identity.fileIdentity, offset: nextOffset, encoding }) } : {}),
        identityReceipt: source.identity.fileIdentity,
      };
      const counters = source.counters();
      return { summary: { ...output, text: undefined }, coverage: { status: nextOffset < source.identity.size ? 'partial' : 'supported', ...counters, sourceBytes: source.identity.size }, items: [{ kind: 'text', text }, { kind: 'json', value: { ...output, text: undefined } }] };
    } finally { await source.close(); }
  }

  private async binary(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    const source = await this.source(request, context, MANAGED_STANDARD_BYTES);
    try {
      const depthValue = asRecord(request.parameters)['depth'];
      const depth = depthValue === 'quick' || depthValue === 'deep' ? depthValue : 'standard';
      const output = await inspectPe(source, depth, context);
      const counters = source.counters();
      return { summary: { format: output['format'], architecture: output['architecture'], sha256State: output['sha256State'] }, coverage: { status: depth === 'quick' ? 'partial' : 'supported', ...counters, sourceBytes: source.identity.size, ...(depth === 'quick' ? { omissions: ['function-imports', 'section-hashes', 'source-hash'] } : {}) }, items: [{ kind: 'json', value: output }] };
    } finally { await source.close(); }
  }

  private async document(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    if (!request.sourcePath?.toLowerCase().endsWith('.pdf')) throw new LocalBridgeError('DOCUMENT_UNSUPPORTED');
    const source = await this.source(request, context, PDF_STANDARD_BYTES);
    try {
      const parameters = asRecord(request.parameters);
      const adapter = { size: source.identity.size, readRange: (offset: number, length: number) => source.readRange(offset, length) };
      if (parameters['mode'] === 'read') {
        const startPage = typeof parameters['startPage'] === 'number' ? parameters['startPage'] : undefined;
        const endPage = typeof parameters['endPage'] === 'number' ? parameters['endPage'] : undefined;
        const parsed = await parsePdfDocument(adapter, {
          maxChars: Number(parameters['maxChars']),
          ...(startPage === undefined ? {} : { startPage }),
          ...(endPage === undefined ? {} : { endPage }),
          ...(this.options.documentWorkerPath === undefined ? {} : { workerPath: this.options.documentWorkerPath }),
          signal: context.signal,
        });
        const output = { path: source.identity.relativePath, identityReceipt: source.identity.fileIdentity, sha256State: 'not-requested', ...parsed };
        const counters = source.counters();
        const examined = parsed.pageSummaries.map((page) => page.page);
        return { summary: { ...output, text: undefined }, coverage: { status: parsed.hasMorePages ? 'partial' : 'supported', ...counters, sourceBytes: source.identity.size, pagesExamined: examined, pagesDelivered: examined }, items: [{ kind: 'text', text: parsed.text }, { kind: 'json', value: { ...output, text: undefined } }] };
      }
      const pages = parameters['pages'] as number[];
      const rendered = await renderPdfDocument(adapter, {
        pages,
        detail: parameters['detail'] === 'high' ? 'high' : 'standard',
        ...(this.options.documentWorkerPath === undefined ? {} : { workerPath: this.options.documentWorkerPath }),
        signal: context.signal,
      });
      const deliveredPages = rendered.pages.map((page) => page.page);
      const items: AnalysisResultItem[] = rendered.pages.flatMap((page) => [
        { kind: 'image', mimeType: page.mimeType, dataBase64: Buffer.from(page.bytes).toString('base64') },
        { kind: 'json', value: { page: page.page, width: page.width, height: page.height, detail: page.detail, renderer: page.renderer, fallbackApplied: page.fallbackApplied, identityReceipt: source.identity.fileIdentity } },
      ]);
      const counters = source.counters();
      return { summary: { path: source.identity.relativePath, pageCount: rendered.pageCount, pages: deliveredPages, warnings: rendered.warnings, sha256State: 'not-requested' }, coverage: { status: deliveredPages.length === rendered.pageCount ? 'supported' : 'partial', ...counters, sourceBytes: source.identity.size, pagesExamined: deliveredPages, pagesDelivered: deliveredPages }, items };
    } finally { await source.close(); }
  }

  private async download(request: AnalysisJobRequest, context: AnalysisJobExecutionContext): Promise<AnalysisJobExecutionResult> {
    abortIfRequested(context.signal);
    if (this.options.webDownload === undefined) throw new LocalBridgeError('FEATURE_UNAVAILABLE');
    const parameters = asRecord(request.parameters);
    context.effectStarted({
      destinationPath: request.sourcePath,
      sourceKind: 'observed-web-resource',
      publication: 'pending',
    });
    let result: Record<string, unknown>;
    try {
      result = asRecord(await this.options.webDownload(
        String(parameters['sessionId']), String(parameters['tabId']), String(parameters['resourceRef']),
        request.workspaceId, request.sourcePath!, request.operationId, context.signal,
      ));
    } catch (error) {
      const errorCode = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : undefined;
      // El escritor publica mediante rename atómico y solo devuelve después de
      // hacerlo. Un rechazo/abort lanzado antes del retorno no publicó el
      // destino; registrar esto evita un falso estado incierto en ejecución
      // normal. Un crash o WEB_EFFECT_UNCERTAIN conserva `uncertain`: en ambos
      // casos se debe reconciliar el destino antes de cualquier reintento.
      if (errorCode !== 'WEB_EFFECT_UNCERTAIN') {
        context.effectNotApplied({ destinationPath: request.sourcePath, publication: 'not-applied' });
      }
      if (context.signal.aborted) throw new LocalBridgeError('ANALYSIS_CANCELLED');
      throw error;
    }
    context.effectApplied({ ...result, publication: 'applied' });
    return { summary: result, coverage: { status: 'supported', bytesRead: Number(result['size'] ?? 0), uniqueBytesRead: Number(result['size'] ?? 0), sourceBytes: Number(result['size'] ?? 0) }, items: [{ kind: 'json', value: result }], effectState: 'applied' };
  }
}
