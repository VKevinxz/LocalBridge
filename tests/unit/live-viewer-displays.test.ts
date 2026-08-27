import { describe, expect, it } from 'vitest';

import { resolveDisplay, sortDisplays, summarizeDisplays } from '../../apps/desktop/src/main/live-viewer-displays.js';

function display(id: number, x: number, y: number, label = '') {
  return { id, label, bounds: { x, y, width: 1920, height: 1080 }, workArea: { x, y, width: 1920, height: 1040 } };
}

describe('pantallas de la ventana en vivo', () => {
  const left = display(30, -1920, 0, 'Left');
  const primary = display(10, 0, 0, 'Primary');
  const upperRight = display(20, 1920, -200, '');

  it('ordena de izquierda a derecha y etiqueta 1, 2 y 3 de forma estable', () => {
    expect(sortDisplays([upperRight, primary, left]).map((entry) => entry.id)).toEqual([30, 10, 20]);
    expect(summarizeDisplays([upperRight, primary, left], 10)).toEqual([
      { id: '30', ordinal: 1, label: 'Left', isPrimary: false },
      { id: '10', ordinal: 2, label: 'Primary', isPrimary: true },
      { id: '20', ordinal: 3, label: 'Monitor 3', isPrimary: false },
    ]);
  });

  it('respeta una selección vigente', () => {
    expect(resolveDisplay([primary, upperRight], '20', 10, 10).id).toBe(20);
  });

  it('un ID retirado cae al monitor de LocalBridge y luego al principal', () => {
    expect(resolveDisplay([primary, upperRight], '30', 20, 10).id).toBe(20);
    expect(resolveDisplay([primary, upperRight], '30', 999, 10).id).toBe(10);
  });

  it('falla cerrado si Electron no informa ninguna pantalla', () => {
    expect(() => resolveDisplay([], undefined, 10, 10)).toThrow('No hay pantallas disponibles');
  });
});
