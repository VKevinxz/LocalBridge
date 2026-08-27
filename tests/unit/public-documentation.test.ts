import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PublicSnapshotManifest = {
  rootFiles: string[];
  sourceDirectories: string[];
  publicDocs: string[];
};

const markdownLink = /!?\[[^\]]*\]\(([^)]+)\)/g;
const internalReference = /(?:MASTER_SPEC|STATUS\.md|docs[\\/]adr|ADR-\d{4}|V\d+\.\d+\.\d+_(?:PLAN|ANALYSIS|AUDIT))/i;
const relativeGitHubRelease = /\]\((?:\.\.\/){2,3}releases(?:\/|\))/i;

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
    await Promise.all((await publicMarkdownFiles()).map(async (file) => {
      const content = await readFile(file, "utf8");
      const checks = [...content.matchAll(markdownLink)].map(async (match) => {
        const rawTarget = match[1]?.trim().replace(/^<|>$/g, "");
        if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) return;
        const targetWithoutFragment = decodeURIComponent(rawTarget.split("#", 1)[0] ?? "");
        if (!targetWithoutFragment) return;
        const absoluteTarget = path.resolve(path.dirname(file), targetWithoutFragment);
        await expect(access(absoluteTarget), `${file} -> ${rawTarget}`).resolves.toBeUndefined();
      });
      await Promise.all(checks);
    }));
  });
});
