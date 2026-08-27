import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const css = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/style.css'), 'utf8');
const renderer = readFileSync(resolve(root, 'apps/desktop/src/renderer/src/main.ts'), 'utf8');
const mainProcess = readFileSync(resolve(root, 'apps/desktop/src/main/index.ts'), 'utf8');

describe('renderer desktop — contratos responsive y accesibles', () => {
  it('no usa variables CSS sin definición', () => {
    const definitions = new Set([...css.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]));
    const uses = [...css.matchAll(/var\(--([a-zA-Z0-9-]+)/g)].map((match) => match[1]);
    expect(uses.filter((name) => name !== undefined && !definitions.has(name))).toEqual([]);
  });

  it('define drawer y apilado para ventanas estrechas y poca altura', () => {
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (max-width: 520px)');
    expect(css).toContain('@media (max-height: 700px)');
    expect(css).toMatch(/\.sidebar\.sidebar-open\s*{[^}]*transform:\s*none/s);
    expect(css).toMatch(/\.runtime-actions\s*{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/button\s*{[^}]*min-height:\s*44px/s);
    expect(mainProcess).toMatch(/minWidth:\s*480/);
    expect(mainProcess).toMatch(/minHeight:\s*480/);
  });

  it('conserva navegación y visor como superficies accesibles por teclado', () => {
    expect(renderer).toContain('aria-expanded="${sidebarOpen}"');
    expect(renderer).toContain('role="dialog" aria-modal="true"');
    expect(renderer).toContain("keyboard.key === 'Escape'");
    expect(renderer).toContain("keyboard.key !== 'Tab'");
    expect(renderer).toContain('aria-current="page"');
  });

  it('presenta terminales agrupadas sin convertir IDs en títulos', () => {
    expect(renderer).toContain('terminalGroups');
    expect(renderer).toContain('runtime-project-heading');
    expect(renderer).toContain('Detalles técnicos');
    expect(renderer).toContain('Servicio HTTP · puerto');
    expect(renderer).toContain('fuera del control de ChatGPT');
  });

  it('mantiene el onboarding contenido en ventanas estrechas y usa el bundle MCP real en desarrollo', () => {
    expect(css).toMatch(/\.onboarding-card\s*{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.onboarding-card\s*{[^}]*overflow-x:\s*hidden/s);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.onboarding-card\s*{[^}]*width:\s*100%/s);
    expect(mainProcess).toMatch(/serverBundlePath:\s*join\(app\.getAppPath\(\),\s*"out",\s*"server",\s*"index\.cjs"\)/);
    expect(renderer).toContain('queueMicrotask(() => void runOnboardingRuntimeCheck())');
  });
});
