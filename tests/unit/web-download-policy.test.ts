import { describe, expect, it } from "vitest";

import { DevelopmentBrokerError } from "@localbridge/development";
import {
  createDownloadedResourceStreamValidator,
  resolveDownloadedResourceDestination,
  validateDownloadedResource,
} from "../../apps/desktop/src/main/web-download-policy.js";

function expectBlocked(run: () => unknown, code = "WEB_MEDIA_TYPE_MISMATCH"): void {
  try {
    run();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DevelopmentBrokerError);
    expect(error).toMatchObject({ code });
  }
}

describe("política de descargas web observadas", () => {
  it("acepta imágenes cuando extensión, MIME y firma coinciden", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
    expect(validateDownloadedResource("assets/hero.png", "image/png", png)).toBe("image/png");
    expect(validateDownloadedResource("assets/photo.jpg", "image/jpg", jpeg)).toBe("image/jpeg");
  });

  it("rechaza discordancias entre extensión, MIME o firma", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expectBlocked(() => validateDownloadedResource("assets/hero.jpg", "image/png", png));
    expectBlocked(() => validateDownloadedResource("assets/hero.png", "image/png", Uint8Array.from([1, 2, 3])));
    expectBlocked(() => validateDownloadedResource("assets/run.exe", "application/octet-stream", Uint8Array.from([1, 2, 3])), "WEB_MEDIA_TYPE_UNSUPPORTED");
  });

  it("deniega SVG aunque parezca estático porque puede contener carga activa indirecta", () => {
    const apparentlyStatic = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const encodedScript = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)">x</a></svg>');
    expectBlocked(() => validateDownloadedResource("assets/icon.svg", "image/svg+xml", apparentlyStatic), "WEB_MEDIA_TYPE_UNSUPPORTED");
    expectBlocked(() => validateDownloadedResource("assets/icon.svg", "image/svg+xml", encodedScript), "WEB_MEDIA_TYPE_UNSUPPORTED");
  });

  it("conserva el contrato documental existente", () => {
    const json = new TextEncoder().encode('{"ok":true}');
    expect(validateDownloadedResource("reports/result.json", "application/json; charset=utf-8", json)).toBe("application/json");
    expectBlocked(() => validateDownloadedResource("reports/result.json", "application/json", new TextEncoder().encode("not-json")));
  });

  it("valida firma y cola JPEG aunque lleguen en chunks separados", () => {
    const validator = createDownloadedResourceStreamValidator("assets/photo.jpg", "image/jpeg");
    validator.write(Uint8Array.from([0xff, 0xd8]));
    validator.write(Uint8Array.from([0xff, 0x00, 0x01]));
    validator.write(Uint8Array.from([0xff, 0xd9]));
    expect(() => validator.finish()).not.toThrow();

    const incomplete = createDownloadedResourceStreamValidator("assets/photo.jpg", "image/jpeg");
    incomplete.write(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
    expectBlocked(() => incomplete.finish());
  });

  it("valida UTF-8 incremental y JSON antes de publicar", () => {
    const valid = createDownloadedResourceStreamValidator("reports/data.json", "application/json");
    valid.write(new TextEncoder().encode('{"texto":"á'));
    valid.write(new TextEncoder().encode('"}'));
    expect(() => valid.finish()).not.toThrow();
    const invalid = createDownloadedResourceStreamValidator("assets/site.css", "text/css");
    invalid.write(Uint8Array.from([0xff, 0x00]));
    expectBlocked(() => invalid.finish());
  });

  it("acepta AVIF y MOV por marca ISO-BMFF, incluso con MIME binario genérico", () => {
    const avif = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66]);
    const mov = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0, 0x71, 0x74, 0x20, 0x20]);
    expect(validateDownloadedResource("assets/hero.avif", "image/avif", avif)).toBe("image/avif");
    expect(validateDownloadedResource("assets/hero.avif", "application/octet-stream", avif)).toBe("image/avif");
    expect(validateDownloadedResource("assets/intro.mov", "video/quicktime", mov)).toBe("video/quicktime");
  });

  it("normaliza solo la extensión final a partir del MIME declarado", () => {
    expect(resolveDownloadedResourceDestination("assets/hero.png", "image/avif")).toBe("assets/hero.avif");
    expect(resolveDownloadedResourceDestination("assets/hero", "image/webp")).toBe("assets/hero.webp");
    expect(resolveDownloadedResourceDestination("assets/font.woff2", "application/octet-stream")).toBe("assets/font.woff2");
    expectBlocked(() => resolveDownloadedResourceDestination("assets/run.exe", "application/octet-stream"), "WEB_MEDIA_TYPE_UNSUPPORTED");
  });
});
