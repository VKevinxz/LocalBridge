import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSetupToolchain, revalidateSetupToolchain } from "@localbridge/desktop-core";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function writeFakeNpmRoot(root: string) {
  const packageRoot = path.join(root, "node_modules", "npm");
  const executable = path.join(packageRoot, "bin", "npm-cli.js");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "10.9.0" }));
  await writeFile(executable, "console.log('fake npm');\n");
  return { root, executable };
}

async function fakeNpmRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "localbridge-toolchain-"));
  roots.push(root);
  return writeFakeNpmRoot(root);
}

describe.runIf(process.platform === "win32")("toolchains canónicos", () => {
  it("fija ruta, versión y hash; un cambio posterior invalida la evidencia", async () => {
    const { root, executable } = await fakeNpmRoot();
    const resolved = await resolveSetupToolchain("npm", [root]);
    expect(resolved.executablePath.toLocaleLowerCase()).toBe(executable.toLocaleLowerCase());
    expect(resolved.version).toBe("10.9.0");
    expect(await revalidateSetupToolchain(resolved)).toBe(true);
    await writeFile(executable, "console.log('changed');\n");
    expect(await revalidateSetupToolchain(resolved)).toBe(false);
  });

  it("no explora un shim fuera de las raíces canónicas aprobadas", async () => {
    const { root } = await fakeNpmRoot();
    const approvedEmptyRoot = path.join(root, "approved-empty");
    await expect(resolveSetupToolchain("npm", [approvedEmptyRoot])).rejects.toThrow("SETUP_TOOLCHAIN_MISSING:npm");
  });

  it("tolera que un padre del temporal sea un junction, pero conserva la raíz física", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "localbridge-toolchain-junction-"));
    roots.push(container);
    const physicalParent = path.join(container, "physical");
    const aliasParent = path.join(container, "alias");
    const physicalRoot = path.join(physicalParent, "toolchain");
    await mkdir(physicalRoot, { recursive: true });
    const { executable } = await writeFakeNpmRoot(physicalRoot);
    await symlink(physicalParent, aliasParent, "junction");

    const resolved = await resolveSetupToolchain("npm", [path.join(aliasParent, "toolchain")]);

    expect(resolved.executablePath.toLocaleLowerCase()).toBe((await realpath(executable)).toLocaleLowerCase());
    expect(resolved.version).toBe("10.9.0");
  });

  it("rechaza una raíz que sea directamente un junction", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "localbridge-toolchain-root-link-"));
    roots.push(container);
    const physicalRoot = path.join(container, "physical");
    const linkedRoot = path.join(container, "linked");
    await mkdir(physicalRoot, { recursive: true });
    await writeFakeNpmRoot(physicalRoot);
    await symlink(physicalRoot, linkedRoot, "junction");

    await expect(resolveSetupToolchain("npm", [linkedRoot])).rejects.toThrow("SETUP_TOOLCHAIN_MISSING:npm");
  });
});
