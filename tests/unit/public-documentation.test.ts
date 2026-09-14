import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PublicSnapshotManifest = {
  rootFiles: string[];
  sourceDirectories: string[];
  publicDocs: string[];
  excludedDirectoryNames: string[];
  excludedExtensions: string[];
};

const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
const internalReference = /(?:MASTER_SPEC|STATUS\.md|docs[\\/]adr|ADR-\d{4}|V\d+\.\d+\.\d+_(?:PLAN|ANALYSIS|AUDIT))/i;
const relativeGitHubRelease = /\]\((?:\.\.\/){2,3}releases(?:\/|\))/i;

function normalizePublicPath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isExportedPath(file: string, manifest: PublicSnapshotManifest): boolean {
  const normalized = normalizePublicPath(file);
  if (!normalized || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(file)) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => manifest.excludedDirectoryNames.includes(segment))) return false;
  if (manifest.excludedExtensions.includes(path.extname(normalized).toLowerCase())) return false;
  if (manifest.rootFiles.map(normalizePublicPath).includes(normalized)) return true;
  if (manifest.publicDocs.map(normalizePublicPath).includes(normalized)) return true;
  return manifest.sourceDirectories.map(normalizePublicPath).some((directory) =>
    normalized === directory || normalized.startsWith(`${directory}/`));
}

async function publicMarkdownFiles(): Promise<string[]> {
  const manifest = JSON.parse(await readFile("public-snapshot.json", "utf8")) as PublicSnapshotManifest;
  return [
    ...manifest.rootFiles.filter((file) => file.toLowerCase().endsWith(".md")),
    ...manifest.publicDocs.filter((file) => file.toLowerCase().endsWith(".md")),
    path.join("apps", "desktop", "README.md"),
  ];
}

describe("public documentation", () => {
  it("does not expose internal planning references or personal Windows paths", async () => {
    await Promise.all((await publicMarkdownFiles()).map(async (file) => {
      const content = await readFile(file, "utf8");
      expect(content, file).not.toMatch(internalReference);
      expect(content, file).not.toMatch(/C:\\Users\\/i);
      expect(content, file).not.toMatch(relativeGitHubRelease);
    }));
  });

  it("keeps every local Markdown link resolvable", async () => {
    const manifest = JSON.parse(await readFile("public-snapshot.json", "utf8")) as PublicSnapshotManifest;
    await Promise.all((await publicMarkdownFiles()).map(async (file) => {
      const content = await readFile(file, "utf8");
      const checks = [...content.matchAll(markdownLink)].map(async (match) => {
        const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
        if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) return;
        const targetWithoutFragment = decodeURIComponent(rawTarget.split("#", 1)[0] ?? "");
        if (!targetWithoutFragment) return;
        const absoluteTarget = path.resolve(path.dirname(file), targetWithoutFragment);
        const repositoryRelativeTarget = path.relative(process.cwd(), absoluteTarget);
        expect(isExportedPath(repositoryRelativeTarget, manifest), `${file} -> ${rawTarget} is absent from the public snapshot`).toBe(true);
        await expect(access(absoluteTarget), `${file} -> ${rawTarget}`).resolves.toBeUndefined();
      });
      await Promise.all(checks);
    }));
  });
});
