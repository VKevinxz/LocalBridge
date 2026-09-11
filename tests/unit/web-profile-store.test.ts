import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_PROFILE_STORE_SCHEMA_VERSION,
  WebProfileStoreError,
  buildPublicResearchProfile,
  buildSiteAccountProfile,
  enablePublicInternetAccess,
  rememberExactSiteAccess,
  readWebProfileStore,
  requireCurrentWebProfileAuthority,
  replaceWebProfileStore,
  webProfileSchema,
  webProfileStoreSchema,
  webProfileRevision,
  withAuthorizedWebProfileEffect,
} from "@localbridge/desktop-core";

const roots: string[] = [];

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-web-profile-"));
  roots.push(root);
  return path.join(root, "web-profiles.json");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("registro de perfiles web", () => {
  it("mantiene web deshabilitada cuando el registro no existe", async () => {
    const snapshot = await readWebProfileStore(await fixturePath());
    expect(snapshot).toEqual({
      state: "missing",
      sha256: null,
      document: { schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION, profiles: [] },
    });
  });

  it("crea un borrador público deshabilitado y sin autoridad de cuentas", () => {
    const profile = buildPublicResearchProfile(new Date("2026-09-05T12:00:00.000Z"));
    expect(profile).toMatchObject({
      kind: "public-research",
      enabled: false,
      destinations: [],
      supportHosts: [],
      permissions: { read: true, interact: true, download: false, humanControl: false },
      limits: { maxDownloadBytes: 1024 * 1024 * 1024, maxTotalDownloadBytes: 10 * 1024 * 1024 * 1024, transferPolicy: { mode: 'fixed' } },
    });
  });

  it('migra perfiles 1.6.3 sin política de transferencia al modo fixed', async () => {
    const storePath = await fixturePath();
    const profile = buildPublicResearchProfile();
    const { transferPolicy: _legacyMissing, ...legacyLimits } = profile.limits;
    await writeFile(storePath, JSON.stringify({
      schemaVersion: 1,
      profiles: [{ ...profile, limits: legacyLimits }],
    }), 'utf8');
    const loaded = await readWebProfileStore(storePath);
    expect(loaded.state).toBe('ready');
    expect(loaded.document.profiles[0]?.limits.transferPolicy).toEqual({ mode: 'fixed' });
  });

  it('separa la revisión de autoridad de los cambios de consumo', () => {
    const profile = { ...buildPublicResearchProfile(), enabled: true };
    const authorityRevision = webProfileRevision(profile);
    expect(webProfileRevision({
      ...profile,
      name: 'Nombre visible nuevo',
      limits: { ...profile.limits, transferPolicy: { mode: 'adaptive' } },
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    })).toBe(authorityRevision);
    expect(webProfileRevision({
      ...profile,
      permissions: { ...profile.permissions, download: true },
    })).not.toBe(authorityRevision);
  });

  it('revalida autoridad viva sin confundir un cambio de cuota con una revocación', async () => {
    const storePath = await fixturePath();
    const enabled = {
      ...buildPublicResearchProfile(), enabled: true,
      permissions: { read: true, interact: true, download: true, humanControl: false },
    };
    const first = await replaceWebProfileStore(storePath, { schemaVersion: 1, profiles: [enabled] }, null);
    const revision = webProfileRevision(enabled);
    const newLimits = {
      ...enabled.limits,
      maxDownloadBytes: 512 * 1024 * 1024,
      transferPolicy: { mode: 'adaptive' as const },
    };
    const changedConsumption = { ...enabled, limits: newLimits, updatedAt: new Date().toISOString() };
    const second = await replaceWebProfileStore(storePath, { schemaVersion: 1, profiles: [changedConsumption] }, first.sha256);
    await expect(requireCurrentWebProfileAuthority(storePath, enabled.id, revision, 'download'))
      .resolves.toMatchObject({ limits: newLimits });

    const revoked = { ...changedConsumption, permissions: { ...changedConsumption.permissions, download: false } };
    await replaceWebProfileStore(storePath, { schemaVersion: 1, profiles: [revoked] }, second.sha256);
    await expect(requireCurrentWebProfileAuthority(storePath, enabled.id, revision, 'download'))
      .rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' });
  });

  it("mantiene una cuota web separada y exige que el total cubra un asset", () => {
    const profile = buildPublicResearchProfile();
    expect(profile.limits.maxDownloadBytes).toBe(1024 * 1024 * 1024);
    expect(profile.limits.maxTotalDownloadBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(webProfileSchema.safeParse({
      ...profile,
      limits: { ...profile.limits, maxDownloadBytes: 100 * 1024 * 1024, maxTotalDownloadBytes: 50 * 1024 * 1024 },
    }).success).toBe(false);
    expect(webProfileSchema.safeParse({
      ...profile,
      limits: { ...profile.limits, maxDownloadBytes: 1024 * 1024 * 1024, maxTotalDownloadBytes: 2 * 1024 * 1024 * 1024 },
    }).success).toBe(true);
    expect(webProfileSchema.safeParse({
      ...profile,
      limits: { ...profile.limits, maxDownloadBytes: 1024 * 1024 * 1024 + 1 },
    }).success).toBe(false);
  });

  it("habilita Internet y cierra una revisión heredada con capacidades exactas", () => {
    const inherited = {
      ...buildPublicResearchProfile(new Date("2026-09-06T09:00:00.000Z")),
      reviewRequired: true,
      permissions: { read: false, interact: false, download: false, humanControl: false },
    };
    const enabled = enablePublicInternetAccess({ schemaVersion: 1, profiles: [inherited] }, true,
      new Date("2026-09-06T10:00:00.000Z"));
    expect(enabled.profiles).toHaveLength(1);
    expect(enabled.profiles[0]).toMatchObject({
      id: inherited.id,
      enabled: true,
      reviewRequired: false,
      permissions: { read: true, interact: true, download: true, humanControl: false },
    });
  });

  it("rechaza perfiles con cuenta sin destinos y dependencias de permisos inválidas", () => {
    const base = buildPublicResearchProfile();
    expect(webProfileSchema.safeParse({ ...base, kind: "site-account" }).success).toBe(false);
    expect(webProfileSchema.safeParse({
      ...base,
      permissions: { read: false, interact: true, download: false, humanControl: false },
    }).success).toBe(false);
  });

  it("recuerda un hostname exacto y deduplica incluso un acceso deshabilitado", () => {
    const disabled = buildSiteAccountProfile({
      name: "Cuenta existente",
      destinations: ["account.example"],
      includeSubdomains: false,
    }, new Date("2026-09-06T10:00:00.000Z"));
    const first = rememberExactSiteAccess({ schemaVersion: 1, profiles: [disabled] }, "ACCOUNT.EXAMPLE",
      new Date("2026-09-06T11:00:00.000Z"));
    expect(first.profiles).toHaveLength(1);
    expect(first.profiles[0]).toMatchObject({
      id: disabled.id,
      enabled: true,
      reviewRequired: false,
      destinations: [{ hostname: "account.example", includeSubdomains: false }],
      supportHosts: [],
      permissions: { read: true, interact: true, humanControl: true },
    });
    const repeated = rememberExactSiteAccess(first, "account.example");
    expect(repeated).toBe(first);
  });

  it("rechaza recordar un sitio nuevo cuando el registro alcanzó su límite", () => {
    const profiles = Array.from({ length: 20 }, (_value, index) => ({
      ...buildPublicResearchProfile(new Date("2026-09-06T10:00:00.000Z"), `Público ${index}`),
      id: `webprofile_${index.toString(16).padStart(24, "0")}`,
    }));
    expect(() => rememberExactSiteAccess({ schemaVersion: 1, profiles }, "account.example"))
      .toThrow("Se alcanzó el límite de 20 accesos web guardados.");
  });

  it("rechaza IPs, hosts locales y reglas duplicadas", () => {
    const base = buildPublicResearchProfile();
    for (const hostname of ["127.0.0.1", "localhost", "example.com.", "EXAMPLE.COM"]) {
      expect(webProfileSchema.safeParse({
        ...base,
        kind: "site-account",
        destinations: [{ hostname, includeSubdomains: true }],
      }).success).toBe(false);
    }
    expect(webProfileSchema.safeParse({
      ...base,
      kind: "site-account",
      destinations: [{ hostname: "example.com", includeSubdomains: true }],
      supportHosts: [{ hostname: "example.com", includeSubdomains: true }],
    }).success).toBe(false);
  });

  it("exige el hash observado inmediatamente antes de reemplazar", async () => {
    const storePath = await fixturePath();
    const profile = buildPublicResearchProfile();
    const first = await replaceWebProfileStore(storePath, {
      schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION,
      profiles: [profile],
    }, null);
    expect(first.state).toBe("ready");

    await expect(replaceWebProfileStore(storePath, {
      schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION,
      profiles: [],
    }, null)).rejects.toMatchObject({ code: "WEB_PROFILE_CONFLICT" });

    const second = await replaceWebProfileStore(storePath, {
      schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION,
      profiles: [{ ...profile, enabled: true, updatedAt: new Date().toISOString() }],
    }, first.sha256);
    expect(second.document.profiles[0]?.enabled).toBe(true);
    expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual(second.document);
  });

  it("falla cerrado ante corrupción y requiere su hash exacto para recuperarse", async () => {
    const storePath = await fixturePath();
    await writeFile(storePath, "{broken", "utf8");
    const corrupt = await readWebProfileStore(storePath);
    expect(corrupt.state).toBe("corrupt");
    expect(corrupt.document.profiles).toEqual([]);
    await expect(replaceWebProfileStore(storePath, {
      schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION,
      profiles: [],
    }, null)).rejects.toBeInstanceOf(WebProfileStoreError);
    const repaired = await replaceWebProfileStore(storePath, {
      schemaVersion: WEB_PROFILE_STORE_SCHEMA_VERSION,
      profiles: [],
    }, corrupt.sha256);
    expect(webProfileStoreSchema.parse(repaired.document).profiles).toEqual([]);
  });

  it("revalida perfil y capacidad dentro del mismo bloqueo que el efecto", async () => {
    const storePath = await fixturePath();
    const enabled = {
      ...buildPublicResearchProfile(), enabled: true,
      permissions: { read: true, interact: true, download: true, humanControl: false },
    };
    const first = await replaceWebProfileStore(storePath, { schemaVersion: 1, profiles: [enabled] }, null);
    let effects = 0;
    await expect(withAuthorizedWebProfileEffect(storePath, enabled.id, webProfileRevision(enabled), "download", async () => {
      effects += 1;
      return "saved";
    })).resolves.toBe("saved");

    const revoked = { ...enabled, enabled: false, updatedAt: new Date().toISOString() };
    await replaceWebProfileStore(storePath, { schemaVersion: 1, profiles: [revoked] }, first.sha256);
    await expect(withAuthorizedWebProfileEffect(storePath, enabled.id, webProfileRevision(enabled), "download", async () => {
      effects += 1;
    })).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect(effects).toBe(1);
  });
});
