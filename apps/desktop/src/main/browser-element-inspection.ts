import type { WebContents } from 'electron';

import { BROWSER_INSPECTABLE_CSS_PROPERTIES, DevelopmentBrokerError } from '@localbridge/development';

const ALLOWED_COMPUTED_PROPERTIES = new Set<string>(BROWSER_INSPECTABLE_CSS_PROPERTIES);
const BOUNDED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
let keyboardProbeSequence = 0;

/**
 * Sends a real CDP key event and supplies one fixed DOM fallback only when
 * Chromium did not deliver keydown to a hidden WebContentsView. The probe is
 * removed immediately and prevents duplicate page handlers in normal windows.
 */
export async function dispatchBoundedBrowserKey(webContents: WebContents, key: string): Promise<void> {
  if (!BOUNDED_KEYS.has(key)) fail('INVALID_INPUT', 'La tecla no pertenece a la lista permitida.');
  const active = await webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false }) as {
    result?: { objectId?: string };
  };
  const objectId = active.result?.objectId;
  if (objectId === undefined) fail('ELEMENT_NOT_INTERACTABLE', 'No existe un elemento activo para recibir la tecla.');
  const property = `__localBridgeKeyProbe_${Date.now()}_${keyboardProbeSequence++}`;
  try {
    await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (property, expectedKey) {
        const record = { seen: false, listener: null };
        record.listener = (event) => { if (event.key === expectedKey) record.seen = true; };
        Object.defineProperty(this, property, { value: record, configurable: true });
        EventTarget.prototype.addEventListener.call(this, 'keydown', record.listener, { capture: true });
      }`,
      arguments: [{ value: property }, { value: key }],
    });
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
    await webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
    await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (property, expectedKey) {
        const record = this[property];
        const seen = record?.seen === true;
        if (record?.listener) EventTarget.prototype.removeEventListener.call(this, 'keydown', record.listener, { capture: true });
        try { delete this[property]; } catch {}
        if (!seen && this.isConnected) {
          EventTarget.prototype.dispatchEvent.call(this, new KeyboardEvent('keydown', { key: expectedKey, code: expectedKey, bubbles: true, cancelable: true, composed: true }));
          EventTarget.prototype.dispatchEvent.call(this, new KeyboardEvent('keyup', { key: expectedKey, code: expectedKey, bubbles: true, cancelable: true, composed: true }));
        }
      }`,
      arguments: [{ value: property }, { value: key }],
      userGesture: true,
    });
  } finally {
    await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (property) { const record=this[property]; if(record?.listener) EventTarget.prototype.removeEventListener.call(this,'keydown',record.listener,{capture:true}); try{delete this[property]}catch{} }`,
      arguments: [{ value: property }],
    }).catch(() => undefined);
    await webContents.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}
export interface BrowserElementInspection {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly styles: Readonly<Record<string, string>>;
  readonly variables: Readonly<Record<string, string>>;
  readonly state: {
    readonly attached: boolean;
    readonly visible: boolean;
    readonly enabled: boolean;
    readonly focusable: boolean;
    readonly active: boolean;
    readonly role: string;
    readonly name: string;
  };
}

export interface BrowserElementVisualSample {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly color: string;
  readonly backgroundColor: string;
  readonly opacity: string;
  readonly transform: string;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontsStatus: string;
}

export interface BrowserKeyboardTargetState {
  readonly connected: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly identity: string;
  readonly role: string;
}

/** Reads only the fixed, bounded attributes needed to stop a keyboard sequence safely. */
export async function inspectActiveBrowserKeyboardTarget(webContents: WebContents): Promise<BrowserKeyboardTargetState> {
  const response = await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: `(() => {
      const element = document.activeElement;
      if (!(element instanceof Element)) return { connected: false, visible: false, enabled: false, identity: '', role: '' };
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      const inputType = element instanceof HTMLInputElement ? element.type : undefined;
      const autocomplete = element.getAttribute('autocomplete') ?? undefined;
      const identity = [element.getAttribute('name'), element.id, element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' ').slice(0, 512);
      return {
        connected: element.isConnected,
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        enabled: !(('disabled' in element && Boolean(element.disabled)) || element.getAttribute('aria-disabled') === 'true'),
        inputType, autocomplete, identity,
        role: (element.getAttribute('role') || element.tagName.toLowerCase()).slice(0, 64),
      };
    })()`,
    returnByValue: true,
  }) as { result?: { value?: BrowserKeyboardTargetState } };
  return response.result?.value ?? { connected: false, visible: false, enabled: false, identity: '', role: '' };
}

function fail(code: string, message: string): never {
  throw new DevelopmentBrokerError(code, message);
}

export function validateInspectionRequest(cssProperties: readonly string[], cssVariables: readonly string[]): void {
  if (cssProperties.some((property) => !ALLOWED_COMPUTED_PROPERTIES.has(property))) {
    fail('INVALID_INPUT', 'La propiedad CSS solicitada no pertenece a la lista de inspección permitida.');
  }
  if (cssVariables.some((variable) => !/^--[A-Za-z0-9_-]{1,126}$/.test(variable))) {
    fail('INVALID_INPUT', 'El nombre de variable CSS no es válido.');
  }
}

export async function inspectResolvedBrowserElement(
  webContents: WebContents,
  objectId: string,
  cssProperties: readonly string[],
  cssVariables: readonly string[],
): Promise<BrowserElementInspection> {
  validateInspectionRequest(cssProperties, cssVariables);
  const inspected = await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (properties, variables) {
      const element = this;
      const clean = (value, max = 512) => {
        const text = String(value ?? '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').slice(0, max);
        return /url\\s*\\(/i.test(text) ? '[url-redacted]' : text;
      };
      if (!(element instanceof Element) || !element.isConnected) return { attached: false };
      const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
      const autocomplete = clean(element.getAttribute('autocomplete'), 128).toLowerCase();
      const identity = [element.getAttribute('name'), element.id, element.getAttribute('aria-label'), element.getAttribute('placeholder')]
        .filter(Boolean).join(' ').toLowerCase();
      const sensitiveTokens = /(?:^|[\\s_.-])(password|passwd|passcode|secret|token|otp|one[-_ ]?time|credit|card|cvv|cvc|pin)(?:$|[\\s_.-])/;
      if (type === 'password' || sensitiveTokens.test(autocomplete) || sensitiveTokens.test(identity)) return { attached: true, sensitive: true };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const styles = {};
      const custom = {};
      for (const property of properties) styles[property] = clean(style.getPropertyValue(property));
      for (const variable of variables) custom[variable] = clean(style.getPropertyValue(variable));
      const disabled = ('disabled' in element && Boolean(element.disabled)) || element.getAttribute('aria-disabled') === 'true';
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      const focusableSelector = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]';
      const role = clean(element.getAttribute('role') || ({A:'link',BUTTON:'button',INPUT:'textbox',SELECT:'combobox',TEXTAREA:'textbox'}[element.tagName] || 'generic'), 64);
      const name = clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '', 256).trim();
      return {
        attached: true,
        sensitive: false,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles,
        variables: custom,
        state: { attached: true, visible, enabled: !disabled, focusable: !disabled && element.matches(focusableSelector), active: document.activeElement === element, role, name }
      };
    }`,
    arguments: [{ value: [...cssProperties] }, { value: [...cssVariables] }],
    returnByValue: true,
  }) as { result?: { value?: Partial<BrowserElementInspection> & { attached?: boolean; sensitive?: boolean } } };
  const value = inspected.result?.value;
  if (value?.attached !== true) fail('STALE_SNAPSHOT', 'El elemento ya no existe en el documento actual.');
  if (value.sensitive === true) fail('SENSITIVE_INPUT_BLOCKED', 'No se inspeccionan campos sensibles.');
  if (value.rect === undefined || value.styles === undefined || value.variables === undefined || value.state === undefined) {
    fail('ELEMENT_NOT_INTERACTABLE', 'El elemento no pudo inspeccionarse.');
  }
  return value as BrowserElementInspection;
}

export async function sampleResolvedBrowserElement(webContents: WebContents, objectId: string): Promise<BrowserElementVisualSample> {
  const sampled = await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      if (!(this instanceof Element) || !this.isConnected) return null;
      const style = getComputedStyle(this);
      const rect = this.getBoundingClientRect();
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        color: String(style.color).slice(0, 128),
        backgroundColor: String(style.backgroundColor).slice(0, 128),
        opacity: String(style.opacity).slice(0, 64),
        transform: String(style.transform).slice(0, 256),
        fontFamily: String(style.fontFamily).slice(0, 256),
        fontSize: String(style.fontSize).slice(0, 64),
        fontsStatus: document.fonts ? String(document.fonts.status).slice(0, 32) : 'unknown'
      };
    }`,
    returnByValue: true,
  }) as { result?: { value?: BrowserElementVisualSample | null } };
  const value = sampled.result?.value;
  if (value === null || value === undefined) fail('STALE_SNAPSHOT', 'El elemento ya no existe en el documento actual.');
  return value;
}

export function visualSamplesEqual(left: BrowserElementVisualSample, right: BrowserElementVisualSample, tolerancePx = 0.5): boolean {
  const rectEqual = Math.abs(left.rect.x - right.rect.x) <= tolerancePx &&
    Math.abs(left.rect.y - right.rect.y) <= tolerancePx &&
    Math.abs(left.rect.width - right.rect.width) <= tolerancePx &&
    Math.abs(left.rect.height - right.rect.height) <= tolerancePx;
  return rectEqual && left.color === right.color && left.backgroundColor === right.backgroundColor &&
    left.opacity === right.opacity && left.transform === right.transform && left.fontFamily === right.fontFamily &&
    left.fontSize === right.fontSize && left.fontsStatus === right.fontsStatus;
}

export async function waitForResolvedBrowserElementStability(
  webContents: WebContents,
  objectId: string,
  options: {
    readonly intervalMs: number;
    readonly tolerancePx: number;
    readonly timeoutMs: number;
    readonly validate: () => void | Promise<void>;
  },
): Promise<{ readonly stable: boolean; readonly waitedMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  let previous: BrowserElementVisualSample | undefined;
  let stableSince = startedAt;
  do {
    await options.validate();
    const current = await sampleResolvedBrowserElement(webContents, objectId);
    const now = Date.now();
    if (previous === undefined || !visualSamplesEqual(previous, current, options.tolerancePx)) stableSince = now;
    else if (now - stableSince >= options.intervalMs) return { stable: true, waitedMs: now - startedAt };
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return { stable: false, waitedMs: Date.now() - startedAt };
}
