import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isSensitiveInput } from "@localbridge/desktop-core";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("SEC-153..156 — clasificación de campos sensibles (ADR-0041)", () => {
  it("SEC-153: el controlador no reimplementa la clasificación por subcadenas", async () => {
    const controller = await source("apps/desktop/src/main/browser-controller.ts");
    expect(controller).toContain("isSensitiveInput({");
    expect(controller).not.toContain("/pass(word|wd)?|secret|token|api.?key|credit|card|cvc|cvv|otp/");
    // El rechazo sigue produciendo el mismo error cerrado.
    expect(controller).toContain("SENSITIVE_INPUT_BLOCKED");
  });

  it("SEC-154: ninguna credencial conocida deja de bloquearse tras el cambio", () => {
    for (const identity of [
      "password", "userPassword", "input_password", "PASSWORD", "txtPassword1",
      "passwd", "pwd", "passphrase", "passcode",
      "apiKey", "api_key", "apikey", "accessToken", "refresh_token", "privateKey",
      "creditCard", "cardNumber", "numeroTarjeta", "cvv", "CVVCode", "cvc", "csc",
      "otp", "totp", "mfaCode", "pinSeguridad", "seedPhrase", "mnemonic", "ssn",
      "contrasena", "contraseña", "clave", "claveAcceso", "secreto", "secret",
    ]) {
      expect(isSensitiveInput({ inputType: "text", identity }), identity).toBe(true);
    }
  });

  it("SEC-155: el tipo y el autocomplete mandan sobre cualquier nombre inocente", () => {
    expect(isSensitiveInput({ inputType: "password", identity: "buscarExpediente" })).toBe(true);
    expect(isSensitiveInput({ inputType: "file", identity: "adjuntarDocumento" })).toBe(true);
    expect(isSensitiveInput({ inputType: "hidden", identity: "csrf" })).toBe(true);
    expect(isSensitiveInput({ inputType: "text", autocomplete: "current-password", identity: "x" })).toBe(true);
  });

  it("SEC-156: un campo inocente no queda bloqueado por coincidencia parcial", () => {
    for (const identity of ["secretaria", "wizardPaso", "compass", "descartar", "cardiologia"]) {
      expect(isSensitiveInput({ inputType: "text", identity }), identity).toBe(false);
    }
  });
});
