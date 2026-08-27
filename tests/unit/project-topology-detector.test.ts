import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectProjectTopology, verifyProcessProfile } from "@localbridge/desktop-core";
import { buildWorkspace } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((temporaryRoot) => rm(temporaryRoot, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "localbridge-topology-"));
  roots.push(value);
  return value;
}

describe("project topology detector", () => {
  it("detecta un proyecto Node único y clasifica servidor/validaciones", async () => {
    const rootPath = await root();
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build", custom: "node x.js" } }));
    await writeFile(path.join(rootPath, "package-lock.json"), "{}");

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));

    expect(result.topology).toBe("single");
    expect(result.lockfiles).toContainEqual(expect.objectContaining({ manager: "npm", path: "package-lock.json" }));
    expect(result.commands).toContainEqual(expect.objectContaining({ name: "dev", role: "server" }));
    expect(result.commands).toContainEqual(expect.objectContaining({ name: "build", role: "validation" }));
    expect(result.commands).toContainEqual(expect.objectContaining({ name: "custom", role: "unknown" }));
  });

  it("detecta monorepo y genera cwd/manifests relativos verificables", async () => {
    const rootPath = await root();
    await mkdir(path.join(rootPath, "apps", "web"), { recursive: true });
    await mkdir(path.join(rootPath, "apps", "api"), { recursive: true });
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ packageManager: "pnpm@9.12.0", workspaces: ["apps/*"] }));
    await writeFile(path.join(rootPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(rootPath, "apps", "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(rootPath, "apps", "api", "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));

    const workspace = buildWorkspace({ rootPath });
    const result = await detectProjectTopology(workspace);
    const web = result.commands.find((command) => command.processProfile.cwd === "apps/web");

    expect(result.topology).toBe("monorepo");
    expect(web?.processProfile).toMatchObject({
      command: ["pnpm", "run", "dev"],
      cwd: "apps/web",
      source: { manifestPath: "apps/web/package.json" },
    });
    expect(await verifyProcessProfile({ ...workspace, processProfiles: { dev: web!.processProfile } }, "dev"))
      .toMatchObject({ ok: true, code: "READY" });
  });

  it("detecta Yarn en la raíz y lo aplica a scripts de workspaces declarados", async () => {
    const rootPath = await root();
    await mkdir(path.join(rootPath, "packages", "web"), { recursive: true });
    await writeFile(path.join(rootPath, "package.json"), JSON.stringify({ packageManager: "yarn@4.6.0", workspaces: ["packages/*"] }));
    await writeFile(path.join(rootPath, "yarn.lock"), "# yarn lockfile v1\n");
    await writeFile(path.join(rootPath, "packages", "web", "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }));

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));
    const commands = result.commands.filter((command) => command.processProfile.cwd === "packages/web");

    expect(result.topology).toBe("monorepo");
    expect(result.lockfiles).toContainEqual(expect.objectContaining({ manager: "yarn", path: "yarn.lock" }));
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "dev", processProfile: expect.objectContaining({ command: ["yarn", "run", "dev"] }) }),
      expect.objectContaining({ name: "test", processProfile: expect.objectContaining({ command: ["yarn", "run", "test"] }) }),
    ]));
  });

  it("conserva la detección cerrada de scripts Composer y targets Make", async () => {
    const rootPath = await root();
    await mkdir(path.join(rootPath, "api"), { recursive: true });
    await mkdir(path.join(rootPath, "ops"), { recursive: true });
    await writeFile(path.join(rootPath, "api", "composer.json"), JSON.stringify({
      scripts: { serve: "php -S 127.0.0.1:8000", test: "phpunit" },
      require: { "php": "^8.3" },
      "require-dev": { "phpunit/phpunit": "^11" },
    }));
    await writeFile(path.join(rootPath, "ops", "Makefile"), ".PHONY: build\nbuild:\n\t@echo build\nserve:\n\t@echo serve\n");

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));

    expect(result.manifests).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "composer", path: "api/composer.json" }),
      expect.objectContaining({ kind: "make", path: "ops/Makefile" }),
    ]));
    expect(result.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "serve", source: "api/composer.json", processProfile: expect.objectContaining({ command: ["composer", "run", "serve"], cwd: "api" }) }),
      expect.objectContaining({ name: "test", processProfile: expect.objectContaining({ command: ["composer", "run", "test"] }) }),
      expect.objectContaining({ name: "build", source: "ops/Makefile", processProfile: expect.objectContaining({ command: ["make", "build"], cwd: "ops" }) }),
      expect.objectContaining({ name: "serve", source: "ops/Makefile", processProfile: expect.objectContaining({ command: ["make", "serve"], cwd: "ops" }) }),
    ]));
    expect(result.directDependencyCount).toBe(1);
    expect(result.directDevDependencyCount).toBe(1);
  });

  it("detecta múltiples repositorios hijos sin leer .git", async () => {
    const rootPath = await root();
    await mkdir(path.join(rootPath, "front", ".git"), { recursive: true });
    await mkdir(path.join(rootPath, "api", ".git"), { recursive: true });
    await writeFile(path.join(rootPath, "front", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    await writeFile(path.join(rootPath, "api", "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    await writeFile(path.join(rootPath, "front", ".git", "config"), "secret marker");

    const result = await detectProjectTopology(buildWorkspace({ rootPath }));

    expect(result.topology).toBe("multi-repo");
    expect(result.gitRoots).toEqual(["api", "front"]);
    expect(result.manifests.map((manifest) => manifest.path).toSorted()).toEqual(["api/package.json", "front/package.json"]);
  });

  it("respeta límites y marca truncamiento", async () => {
    const rootPath = await root();
    for (let index = 0; index < 8; index += 1) {
      await mkdir(path.join(rootPath, `p${index}`), { recursive: true });
      await writeFile(path.join(rootPath, `p${index}`, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    }

    const result = await detectProjectTopology(buildWorkspace({ rootPath }), { maxEntries: 4, maxDepth: 2, maxManifests: 2 });

    expect(result.truncated).toBe(true);
    expect(result.scannedEntries).toBeGreaterThanOrEqual(4);
  });
});
