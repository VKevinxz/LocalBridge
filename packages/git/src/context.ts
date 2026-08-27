/**
 * Contexto Git de un workspace.
 *
 * Resuelve dos problemas que solo aparecen cuando el workspace autorizado es un
 * **subdirectorio** de un repositorio mayor — un caso perfectamente normal:
 *
 * 1. **Fuga de rutas externas.** Sin acotar, `git status` desde un subdirectorio
 *    lista también los cambios del resto del repositorio (`../otro/secreto.txt`),
 *    revelando nombres de archivo fuera del root autorizado. Por eso todas las
 *    operaciones basadas en rutas se acotan con el pathspec `-- .`.
 * 2. **Espacio de rutas inconsistente.** Git emite rutas relativas a la raíz del
 *    *repositorio*, mientras que `file.read` y compañía las esperan relativas al
 *    *workspace*. Se traduce con el prefijo, de modo que el agente ve un único
 *    espacio de rutas coherente en todas las tools.
 */

import { LocalBridgeError } from "@localbridge/shared";
import type { AuthorizedWorkspace } from "@localbridge/workspace";

import { runGit } from "./runner.js";

export interface GitContext {
  cwd: string;
  /** Ruta del workspace relativa a la raíz del repo, con `/` final, o `""` si coinciden. */
  prefix: string;
}

export async function resolveGitContext(workspace: AuthorizedWorkspace): Promise<GitContext> {
  const result = await runGit(["rev-parse", "--show-prefix"], { cwd: workspace.rootPath });

  if (result.exitCode !== 0) {
    // Cualquier fallo aquí significa "no utilizable como repositorio": ni repo,
    // ni propiedad dudosa, ni Git ausente. Un único código, sin detalle.
    throw new LocalBridgeError("GIT_NOT_REPOSITORY");
  }

  return { cwd: workspace.rootPath, prefix: result.stdout.trim() };
}

/**
 * Traduce una ruta emitida por Git (relativa al repo) a ruta de workspace.
 *
 * Devuelve `undefined` si cae fuera del workspace. El pathspec `-- .` ya debería
 * impedirlo; esto es defensa en profundidad — ante una ruta inesperada se
 * descarta la entrada en vez de exponerla.
 */
export function toWorkspacePath(repoRelativePath: string, prefix: string): string | undefined {
  const normalized = repoRelativePath.split("\\").join("/");

  if (prefix === "") return normalized;
  if (!normalized.startsWith(prefix)) return undefined;

  return normalized.slice(prefix.length);
}

/**
 * Traduce una ruta de workspace a pathspec de Git, anclado al directorio actual.
 *
 * `:(literal)` desactiva la interpretación de comodines y magia de pathspec:
 * un archivo llamado `*.ts` es exactamente ese archivo, no un patrón. Combinado
 * con el `--` que separa opciones de rutas, cierra la vía de que un valor
 * controlado por el modelo se interprete como algo que no es una ruta.
 */
export function toGitPathspec(workspaceRelativePath: string): string {
  return `:(literal)${workspaceRelativePath}`;
}
