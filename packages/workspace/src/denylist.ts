/**
 * Denylist de secretos (SECURITY.md §5, Amenaza E). Capa adicional dentro de un
 * root ya autorizado: el usuario autorizó el workspace, no todos sus secretos.
 *
 * Soporta patrones con un único comodín `*` por segmento:
 *   ".env"            -> coincide con el nombre base en cualquier profundidad
 *   "*.pem"            -> comodín en el nombre base
 *   ".git/config"      -> ruta relativa exacta (con comodines si los lleva)
 *   "secrets/"         -> prefijo de directorio: también deniega todo lo de dentro
 */

export function isPathDenied(relativePath: string, denyPatterns: readonly string[]): boolean {
  const normalized = relativePath.split("\\").join("/");
  const basename = normalized.split("/").pop() ?? normalized;

  return denyPatterns.some((pattern) => matchesPattern(pattern, normalized, basename));
}

function matchesPattern(pattern: string, relativePath: string, basename: string): boolean {
  if (pattern.endsWith("/")) {
    const prefix = pattern.slice(0, -1);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }

  if (pattern.includes("/")) {
    return globToRegExp(pattern).test(relativePath);
  }

  return globToRegExp(pattern).test(basename);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
