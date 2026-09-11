import { describe, expect, it } from 'vitest';

import { fitViewerPresentation, resolveViewerPresentation } from '../../apps/desktop/src/main/live-viewer-presentation.js';

describe('presentación del viewport lógico en el visor', () => {
  it('muestra 1920x1080 a escala 1 cuando el monitor tiene espacio', () => {
    expect(fitViewerPresentation(
      { width: 1920, height: 1080 },
      104,
      { x: 0, y: 0, width: 2452, height: 1310 },
    )).toEqual({
      bounds: { x: 266, y: 63, width: 1920, height: 1184 },
      contentWidth: 1920,
      contentHeight: 1080,
      scale: 1,
    });
  });

  it('encaja la imagen completa en una pantalla menor sin deformarla', () => {
    const result = fitViewerPresentation(
      { width: 1920, height: 1080 },
      104,
      { x: 100, y: 50, width: 1600, height: 1000 },
      { width: 16, height: 39 },
    );
    expect(result.bounds).toEqual({ x: 130, y: 50, width: 1539, height: 1000 });
    expect(result.contentWidth / result.contentHeight).toBeCloseTo(16 / 9, 2);
    expect(result.scale).toBeCloseTo(857 / 1080, 6);
  });

  it('falla ante un área que no puede contener ni la barra', () => {
    expect(() => fitViewerPresentation(
      { width: 1920, height: 1080 }, 104, { x: 0, y: 0, width: 800, height: 104 },
    )).toThrow('área de pantalla');
  });
});

describe('presentación 1:1 del visor', () => {
  it('recorta solo la superficie local y acota el pan sin cambiar el render', () => {
    const actual = resolveViewerPresentation(
      { width: 1920, height: 1080 }, 104,
      { x: 0, y: 0, width: 1366, height: 768 },
      { width: 16, height: 39 }, 'actual', { x: 9_999, y: 9_999 },
    );
    expect(actual).toMatchObject({
      mode: 'actual', scale: 1, contentWidth: 1920, contentHeight: 1080,
      visibleContentWidth: 1350, visibleContentHeight: 625,
      panX: 570, panY: 455,
      contentBounds: { x: -570, y: -455, width: 1920, height: 1080 },
    });
  });

  it('rechaza pan fraccionario, negativo o no finito', () => {
    const args = [{ width: 1920, height: 1080 }, 104, { x: 0, y: 0, width: 1366, height: 768 }] as const;
    expect(() => resolveViewerPresentation(...args, undefined, 'actual', { x: -1, y: 0 })).toThrow();
    expect(() => resolveViewerPresentation(...args, undefined, 'actual', { x: 0.5, y: 0 })).toThrow();
  });
});
