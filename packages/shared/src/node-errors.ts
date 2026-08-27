/** Distingue "no existe" de otros fallos de fs (permisos, disco, etc.) sin acoplarse al mensaje. */
export function isEnoent(error: unknown): boolean {
  return isNodeErrnoException(error) && error.code === "ENOENT";
}

export function nodeErrorCode(error: unknown): string | undefined {
  return isNodeErrnoException(error) ? error.code : undefined;
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
