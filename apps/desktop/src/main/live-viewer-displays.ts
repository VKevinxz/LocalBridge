export interface DisplayGeometry {
  readonly id: number;
  readonly label: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly workArea: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface LiveViewerDisplaySummary {
  readonly id: string;
  readonly ordinal: number;
  readonly label: string;
  readonly isPrimary: boolean;
}

export function sortDisplays<T extends DisplayGeometry>(displays: readonly T[]): T[] {
  return displays.toSorted((left, right) =>
    left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y || left.id - right.id);
}

export function summarizeDisplays(displays: readonly DisplayGeometry[], primaryDisplayId: number): LiveViewerDisplaySummary[] {
  return sortDisplays(displays).map((display, index) => ({
    id: String(display.id),
    ordinal: index + 1,
    label: display.label.trim() || `Monitor ${index + 1}`,
    isPrimary: display.id === primaryDisplayId,
  }));
}

export function resolveDisplay<T extends DisplayGeometry>(
  displays: readonly T[],
  requestedDisplayId: string | undefined,
  recommendedDisplayId: number,
  primaryDisplayId: number,
): T {
  const sorted = sortDisplays(displays);
  const resolved = sorted.find((display) => String(display.id) === requestedDisplayId) ??
    sorted.find((display) => display.id === recommendedDisplayId) ??
    sorted.find((display) => display.id === primaryDisplayId) ??
    sorted[0];
  if (resolved === undefined) throw new Error('No hay pantallas disponibles.');
  return resolved;
}
