export interface LogicalViewport {
  readonly width: number;
  readonly height: number;
}

export interface ViewerWorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewerPresentation {
  readonly bounds: ViewerWorkArea;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly scale: number;
}

export type ViewerPresentationMode = 'fit' | 'actual';

export interface ResolvedViewerPresentation extends ViewerPresentation {
  readonly mode: ViewerPresentationMode;
  readonly contentBounds: ViewerWorkArea;
  readonly visibleContentWidth: number;
  readonly visibleContentHeight: number;
  readonly panX: number;
  readonly panY: number;
}

/** Encaja el viewport lógico completo sin ampliarlo ni cambiar su relación de aspecto. */
export function fitViewerPresentation(
  viewport: LogicalViewport,
  toolbarHeight: number,
  workArea: ViewerWorkArea,
  frame: { readonly width: number; readonly height: number } = { width: 0, height: 0 },
): ViewerPresentation {
  const values = [viewport.width, viewport.height, toolbarHeight, workArea.x, workArea.y, workArea.width, workArea.height, frame.width, frame.height];
  if (!values.every(Number.isSafeInteger) || viewport.width < 1 || viewport.height < 1 || toolbarHeight < 0 ||
      frame.width < 0 || frame.height < 0 || workArea.width <= frame.width || workArea.height <= toolbarHeight + frame.height) {
    throw new Error('El viewport lógico o el área de pantalla no son válidos.');
  }
  const maximumContentWidth = workArea.width - frame.width;
  const maximumContentHeight = workArea.height - frame.height - toolbarHeight;
  const scale = Math.min(1, maximumContentWidth / viewport.width, maximumContentHeight / viewport.height);
  const contentWidth = Math.max(1, Math.floor(viewport.width * scale));
  const contentHeight = Math.max(1, Math.floor(viewport.height * scale));
  const width = contentWidth + frame.width;
  const height = contentHeight + toolbarHeight + frame.height;
  return {
    bounds: {
      x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
      y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
      width,
      height,
    },
    contentWidth,
    contentHeight,
    scale,
  };
}

/** Resuelve la geometría física del visor sin modificar el viewport lógico de Chromium. */
export function resolveViewerPresentation(
  viewport: LogicalViewport,
  toolbarHeight: number,
  workArea: ViewerWorkArea,
  frame: { readonly width: number; readonly height: number } = { width: 0, height: 0 },
  mode: ViewerPresentationMode = 'fit',
  requestedPan: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): ResolvedViewerPresentation {
  if (mode === 'fit') {
    const fitted = fitViewerPresentation(viewport, toolbarHeight, workArea, frame);
    return {
      ...fitted,
      mode,
      contentBounds: { x: 0, y: 0, width: fitted.contentWidth, height: fitted.contentHeight },
      visibleContentWidth: fitted.contentWidth,
      visibleContentHeight: fitted.contentHeight,
      panX: 0,
      panY: 0,
    };
  }
  fitViewerPresentation(viewport, toolbarHeight, workArea, frame);
  if (!Number.isSafeInteger(requestedPan.x) || !Number.isSafeInteger(requestedPan.y) || requestedPan.x < 0 || requestedPan.y < 0) {
    throw new Error('El desplazamiento de presentación no es válido.');
  }
  const visibleContentWidth = workArea.width - frame.width;
  const visibleContentHeight = workArea.height - frame.height - toolbarHeight;
  const panX = Math.min(requestedPan.x, Math.max(0, viewport.width - visibleContentWidth));
  const panY = Math.min(requestedPan.y, Math.max(0, viewport.height - visibleContentHeight));
  return {
    mode,
    bounds: { ...workArea },
    contentWidth: viewport.width,
    contentHeight: viewport.height,
    contentBounds: { x: -panX, y: -panY, width: viewport.width, height: viewport.height },
    visibleContentWidth,
    visibleContentHeight,
    scale: 1,
    panX,
    panY,
  };
}
