import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AuditEvent } from "./types.js";

/** Campos que el llamante conoce; `id`, `timestamp` y `requestId` se generan aquí. */
export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp" | "requestId">;

/**
 * Punto único de construcción de `AuditEvent`: aquí se hace cumplir el
 * invariante que declara `types.ts` ("nunca una ruta absoluta"), en vez de
 * confiar en que cada tool sanee `resource` antes de llamar. Varias tools
 * (`file.read`, `file.create`, ...) construyen `resource` a partir del `path`
 * tal como lo mandó el cliente, *antes* de que el sandbox lo valide — un
 * cliente que manda una ruta absoluta y recibe `ABSOLUTE_PATH_FORBIDDEN` no
 * debe dejarla, aun así, escrita en el registro de auditoría.
 */
export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  const { resource, ...rest } = input;
  const safeResource = resource !== undefined && !path.isAbsolute(resource) ? resource : undefined;

  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    ...rest,
    ...(safeResource === undefined ? {} : { resource: safeResource }),
  };
}
