const MAX_ARGUMENTS = 16;
const MAX_DEPTH = 3;
const MAX_PROPERTIES = 32;
const MAX_STRING_CHARS = 2_048;
const MAX_TOTAL_BYTES = 16 * 1024;
const MAX_IDENTITY_COMPARISONS = 64;
const IDENTITY_FUNCTION = 'function(other) { return this === other; }';

interface RemoteObject {
  readonly type?: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly objectId?: string;
}

interface PropertyDescriptor {
  readonly name?: string;
  readonly value?: RemoteObject;
  readonly get?: RemoteObject;
  readonly set?: RemoteObject;
  readonly isOwn?: boolean;
}

export type BrowserConsoleValue =
  | { readonly kind: 'primitive'; readonly type: string; readonly value?: string | number | boolean | null; readonly truncated?: boolean }
  | { readonly kind: 'object'; readonly ref: string; readonly subtype?: string; readonly className?: string; readonly description?: string; readonly properties: readonly BrowserConsoleProperty[]; readonly truncated: boolean }
  | { readonly kind: 'reference'; readonly ref: string }
  | { readonly kind: 'unavailable'; readonly description?: string };

export type BrowserConsoleProperty =
  | { readonly name: string; readonly kind: 'value'; readonly value: BrowserConsoleValue }
  | { readonly name: string; readonly kind: 'accessor' };

export interface BrowserConsoleSerialization {
  readonly arguments: readonly BrowserConsoleValue[];
  readonly truncated: boolean;
}

type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function boundedString(value: unknown): { value: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > MAX_STRING_CHARS
    ? { value: text.slice(0, MAX_STRING_CHARS), truncated: true }
    : { value: text, truncated: false };
}

function primitive(remote: RemoteObject): BrowserConsoleValue | undefined {
  if (remote.subtype === 'null' || remote.value === null) return { kind: 'primitive', type: 'null', value: null };
  if (remote.unserializableValue !== undefined) {
    const text = boundedString(remote.unserializableValue);
    return { kind: 'primitive', type: remote.type ?? 'special', value: text.value, ...(text.truncated ? { truncated: true } : {}) };
  }
  if (remote.type === 'undefined') return { kind: 'primitive', type: 'undefined' };
  if (remote.type === 'string') {
    const text = boundedString(remote.value);
    return { kind: 'primitive', type: 'string', value: text.value, ...(text.truncated ? { truncated: true } : {}) };
  }
  if (remote.type === 'number' && typeof remote.value === 'number') return { kind: 'primitive', type: 'number', value: remote.value };
  if (remote.type === 'boolean' && typeof remote.value === 'boolean') return { kind: 'primitive', type: 'boolean', value: remote.value };
  if (remote.type === 'bigint') {
    const text = boundedString(remote.description ?? remote.value);
    return { kind: 'primitive', type: 'bigint', value: text.value, ...(text.truncated ? { truncated: true } : {}) };
  }
  if (remote.type === 'symbol' || remote.type === 'function') {
    const text = boundedString(remote.description ?? remote.type);
    return { kind: 'primitive', type: remote.type, value: text.value, ...(text.truncated ? { truncated: true } : {}) };
  }
  return undefined;
}

/**
 * Serializa RemoteObjects de CDP sin evaluar expresiones ni leer accessors.
 * Solo usa descriptores propios y libera cada handle observado al terminar.
 */
export async function serializeBrowserConsoleArguments(
  input: readonly Record<string, unknown>[],
  sendCommand: SendCommand,
): Promise<BrowserConsoleSerialization> {
  const seen = new Map<string, string>();
  const handles = new Set<string>();
  let nextRef = 1;
  let totalBytes = 0;
  let identityComparisons = 0;
  let truncated = input.length > MAX_ARGUMENTS;

  const fits = (value: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      truncated = true;
      return false;
    }
    totalBytes += bytes;
    return true;
  };

  const visit = async (remote: RemoteObject, depth: number): Promise<BrowserConsoleValue> => {
    const simple = primitive(remote);
    if (simple !== undefined) return simple;
    const objectId = remote.objectId;
    if (objectId === undefined) {
      const description = boundedString(remote.description ?? remote.type ?? 'unavailable');
      return { kind: 'unavailable', description: description.value };
    }
    handles.add(objectId);
    const known = seen.get(objectId);
    if (known !== undefined) return { kind: 'reference', ref: known };
    for (const [knownObjectId, knownRef] of seen) {
      if (identityComparisons >= MAX_IDENTITY_COMPARISONS) {
        truncated = true;
        break;
      }
      identityComparisons += 1;
      try {
        const comparison = await sendCommand('Runtime.callFunctionOn', {
          objectId: knownObjectId,
          functionDeclaration: IDENTITY_FUNCTION,
          arguments: [{ objectId }],
          returnByValue: true,
          silent: true,
        }) as { result?: { value?: unknown } };
        if (comparison.result?.value === true) {
          seen.set(objectId, knownRef);
          return { kind: 'reference', ref: knownRef };
        }
      } catch {
        // Un handle puede desaparecer por navegación. Continuamos con una
        // representación acotada y nunca evaluamos código suministrado.
      }
    }
    const ref = `object_${nextRef++}`;
    seen.set(objectId, ref);
    const description = boundedString(remote.description ?? '');
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return {
        kind: 'object', ref,
        ...(remote.subtype === undefined ? {} : { subtype: remote.subtype }),
        ...(remote.className === undefined ? {} : { className: remote.className }),
        ...(description.value === '' ? {} : { description: description.value }),
        properties: [], truncated: true,
      };
    }
    let descriptors: readonly PropertyDescriptor[];
    try {
      const response = await sendCommand('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: false,
      }) as { result?: readonly PropertyDescriptor[] };
      descriptors = (response.result ?? []).filter((candidate) => candidate.isOwn !== false);
    } catch {
      return { kind: 'unavailable', ...(description.value === '' ? {} : { description: description.value }) };
    }
    const properties: BrowserConsoleProperty[] = [];
    let objectTruncated = descriptors.length > MAX_PROPERTIES || description.truncated;
    for (const descriptor of descriptors.slice(0, MAX_PROPERTIES)) {
      const name = boundedString(descriptor.name ?? '').value.slice(0, 128);
      if (name === '') continue;
      if (descriptor.value === undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
        const property = { name, kind: 'accessor' as const };
        if (!fits(property)) { objectTruncated = true; break; }
        properties.push(property);
        continue;
      }
      if (descriptor.value === undefined) continue;
      const value = await visit(descriptor.value, depth + 1);
      const property = { name, kind: 'value' as const, value };
      if (!fits(property)) { objectTruncated = true; break; }
      properties.push(property);
    }
    if (objectTruncated) truncated = true;
    return {
      kind: 'object', ref,
      ...(remote.subtype === undefined ? {} : { subtype: remote.subtype }),
      ...(remote.className === undefined ? {} : { className: remote.className }),
      ...(description.value === '' ? {} : { description: description.value }),
      properties,
      truncated: objectTruncated,
    };
  };

  try {
    const values: BrowserConsoleValue[] = [];
    for (const remote of input.slice(0, MAX_ARGUMENTS)) {
      const value = await visit(remote as RemoteObject, 0);
      if (!fits(value)) break;
      values.push(value);
    }
    return { arguments: values, truncated };
  } finally {
    await Promise.allSettled([...handles].map((objectId) => sendCommand('Runtime.releaseObject', { objectId })));
  }
}
