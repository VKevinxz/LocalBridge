import { describe, expect, it } from "vitest";

import { identityTokens, isSensitiveInput } from "@localbridge/desktop-core";

describe("clasificación de campos sensibles", () => {
  it("parte identidades por separadores, camelCase y acrónimos", () => {
    expect(identityTokens("userPassword")).toEqual(["user", "password"]);
    expect(identityTokens("input_password")).toEqual(["input", "password"]);
    expect(identityTokens("CVVCode")).toEqual(["cvv", "code"]);
    expect(identityTokens("numero-tarjeta")).toEqual(["numero", "tarjeta"]);
    expect(identityTokens("txtPassword1")).toEqual(["txt", "password", "1"]);
    expect(identityTokens("  ")).toEqual([]);
  });

  it("bloquea por tipo de campo con independencia del nombre", () => {
    for (const inputType of ["password", "file", "hidden"]) {
      expect(isSensitiveInput({ inputType, identity: "campo cualquiera" })).toBe(true);
    }
  });

  it("bloquea por autocomplete estándar", () => {
    for (const autocomplete of ["current-password", "new-password", "one-time-code", "cc-number", "webauthn"]) {
      expect(isSensitiveInput({ inputType: "text", autocomplete })).toBe(true);
    }
  });

  it("bloquea credenciales por nombre, en inglés y en español", () => {
    for (const identity of [
      "password", "userPassword", "input_password", "txtPwd", "passphrase",
      "apiKey", "api_key", "accessToken", "privateKey",
      "cardNumber", "numeroTarjeta", "CVVCode", "cvc", "otpCode", "totp",
      "contrasena", "contraseña", "claveAcceso", "secreto", "codigoSeguridad",
    ]) {
      expect(isSensitiveInput({ inputType: "text", identity }), identity).toBe(true);
    }
  });

  it("no bloquea campos inocentes que antes coincidían por subcadena", () => {
    for (const identity of [
      "secretaria", "secretarioResponsable", "nombreSecretaria",
      "wizardPaso", "stepWizard", "descartarMotivo",
      "compassIndex", "cardiologia", "passengerName",
      "expedienteCodigo", "fechaCreacion", "montoRecuperado",
    ]) {
      expect(isSensitiveInput({ inputType: "text", identity }), identity).toBe(false);
    }
  });

  it("distingue «palabra clave» de una clave real", () => {
    expect(isSensitiveInput({ inputType: "text", identity: "palabraClave" })).toBe(false);
    expect(isSensitiveInput({ inputType: "text", identity: "buscar por palabras clave" })).toBe(false);
    expect(isSensitiveInput({ inputType: "text", identity: "clave" })).toBe(true);
    expect(isSensitiveInput({ inputType: "text", identity: "claveAcceso" })).toBe(true);
  });

  it("usa también el placeholder, habitual en formularios en español", () => {
    expect(isSensitiveInput({ inputType: "text", identity: "campo1 Contraseña" })).toBe(true);
    expect(isSensitiveInput({ inputType: "text", identity: "campo1 Buscar expediente" })).toBe(false);
  });

  it("un campo sin atributos no se considera sensible", () => {
    expect(isSensitiveInput({})).toBe(false);
  });
});
