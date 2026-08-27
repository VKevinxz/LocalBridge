import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveSafePath, type AuthorizedWorkspace, type ProcessProfile } from "@localbridge/workspace";

export type ProcessProfileVerificationCode =
  | "READY"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_REVIEW_REQUIRED"
  | "PROFILE_SOURCE_MISSING"
  | "PROFILE_SOURCE_INVALID"
  | "PROFILE_STALE";

export interface ProcessProfileVerification {
  readonly ok: boolean;
  readonly code: ProcessProfileVerificationCode;
  readonly profile?: ProcessProfile;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameDigest(value: string, expectedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = digest(value);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/**
 * Revalida la definición declarada inmediatamente antes de arrancar un perfil.
 * El manifiesto se resuelve siempre mediante el sandbox de workspace; nunca se
 * concatena una ruta aportada por MCP.
 */
export async function verifyProcessProfile(
  workspace: AuthorizedWorkspace,
  profileName: string,
): Promise<ProcessProfileVerification> {
  const profile = workspace.processProfiles?.[profileName];
  if (profile === undefined) return { ok: false, code: "PROFILE_NOT_FOUND" };
  if (workspace.automationReviewRequired === true) return { ok: false, code: "PROFILE_REVIEW_REQUIRED" };

  const sourcePath = await resolveSafePath(workspace.rootPath, profile.source.manifestPath);
  if (!sourcePath.exists) return { ok: false, code: "PROFILE_SOURCE_MISSING" };

  let raw: string;
  try {
    raw = await readFile(sourcePath.realPath, "utf8");
  } catch {
    return { ok: false, code: "PROFILE_SOURCE_INVALID" };
  }

  let definition: string;
  if (profile.source.kind === "make-target") {
    definition = raw;
  } else {
    try {
      const manifest = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      const value = manifest.scripts?.[profile.source.script];
      if (value === undefined) return { ok: false, code: "PROFILE_STALE" };
      definition = JSON.stringify(value);
    } catch {
      return { ok: false, code: "PROFILE_SOURCE_INVALID" };
    }
  }

  return sameDigest(definition, profile.source.definitionSha256)
    ? { ok: true, code: "READY", profile }
    : { ok: false, code: "PROFILE_STALE" };
}
