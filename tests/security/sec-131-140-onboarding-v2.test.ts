import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("SEC-131..140 — onboarding project-first", () => {
  it("mantiene el estado v2 fuera del settings estricto compatible con v1.0.3", async () => {
    const settings = await source("packages/desktop-core/src/app-settings.ts");
    const state = await source("packages/desktop-core/src/onboarding-store.ts");

    expect(state).toContain("onboarding-state.json");
    expect(settings).not.toContain("schemaVersion: z.literal(2)");
    expect(state).not.toContain("rootPath:");
    expect(state).not.toContain("apiKey:");
  });

  it("la selección de carpeta es nativa, opaca, temporal y ligada a la ventana", async () => {
    const coordinator = await source("packages/desktop-core/src/onboarding-coordinator.ts");
    const main = await source("apps/desktop/src/main/index.ts");

    expect(coordinator).toContain("FolderSelectionVault");
    expect(coordinator).toContain("folder_${randomBytes(16)");
    expect(coordinator).toContain("selection.ownerId !== ownerId");
    expect(coordinator).toContain("expiresAt <= current");
    expect(main).toContain('properties: ["openDirectory", "createDirectory"]');
    expect(main).toContain("await realpath(rootPath)");
  });

  it("inspecciona con lectura mínima antes de registrar y no añade tools MCP", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    const catalog = await source("docs/TOOL_CATALOG.md");

    expect(main).toContain('permissions: onboardingPermissionPreset("guided", "review")');
    expect(main).toContain("detectProjectTopology(temporary)");
    expect(catalog).not.toMatch(/onboarding\.(?:pick|complete|advance)/i);
  });

  it("deniega project-agent y exige confirmación nativa para full-host", async () => {
    const main = await source("apps/desktop/src/main/index.ts");
    const renderer = await source("apps/desktop/src/renderer/src/onboarding.ts");

    expect(main).toContain('parsed.trustMode === "project-agent"');
    expect(main).toContain("await confirmFullHost(record.displayName)");
    expect(renderer).toContain("Agente en proyecto — no disponible");
    expect(renderer).toContain("Control total del equipo — avanzado");
  });

  it("revierte todos los almacenes si la finalización falla", async () => {
    const main = await source("apps/desktop/src/main/index.ts");

    expect(main).toContain("replaceRegistry(registryPath, previousRegistry)");
    expect(main).toContain("replaceDevelopmentProjects(projectStorePath(), previousProjects)");
    expect(main).toContain("replaceProjectCatalog(projectCatalogPath(), previousCatalog.projects)");
    expect(main).toContain("replaceProjectTrust(projectTrustPath(), previousTrust.decisions)");
    expect(main).toContain("writeDesktopSettings(settingsPath, previousSettings)");
  });

  it("el renderer no recibe fs, ipcRenderer ni una ruta de la selección", async () => {
    const preload = await source("apps/desktop/src/preload/index.ts");
    const onboarding = await source("apps/desktop/src/renderer/src/onboarding.ts");

    expect(onboarding).not.toMatch(/rootPath|selectedRoot|absolutePath/);
    expect(preload).not.toContain("ipcRenderer: ipcRenderer");
    expect(preload).not.toContain("require(");
  });
});
