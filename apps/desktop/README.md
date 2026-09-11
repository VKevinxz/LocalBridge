# Aplicación de escritorio

Electron aloja la configuración local, el onboarding, la supervisión del túnel, proyectos,
procesos, los navegadores local y externo, perfiles web y auditoría de LocalBridge.

La lógica reutilizable vive en `@localbridge/desktop-core`. El proceso principal mantiene
la autoridad local; preload expone una API tipada mediante `contextBridge`; el renderer no
recibe Node, filesystem o `ipcRenderer` crudos.

## Desarrollo

```powershell
pnpm --filter @localbridge/desktop dev
```

## Verificación

```powershell
pnpm --filter @localbridge/desktop typecheck
pnpm test
pnpm test:sec
```

## Build y paquete

```powershell
pnpm --filter @localbridge/desktop build
pnpm --filter @localbridge/desktop package:win
pnpm --filter @localbridge/desktop package:win:signed
```

El paquete oficial incluye el servidor MCP, el worker limitado de documentos y el runtime
de PDF.js, Node.js privado, tunnel-client y el helper de procesos. `package:win:signed`
exige credenciales de firma válidas. `out/`, `release/` y `vendor/` son artefactos locales
y no se versionan.

El navegador de Internet usa un controlador y un proxy HTTPS propios. No comparte cookies,
IDs, permisos ni presupuestos con `browser.*`, y no reutiliza el navegador personal.
Su vista en vivo reutiliza la misma pestaña remota dentro de una banda local confiable,
rechaza foco y ratón y comparte con desarrollo una única ventana pasiva visible.
La sección **Actividad** reúne ambos navegadores. Una reserva global permite tomar el
control humano de una sola sesión, recorrer sus pestañas de forma privada y devolver una
navegación pública bajo una concesión efímera al hostname HTTPS exacto.

El render administrado inicia en 1920×1080 para investigación y navegadores derivados de
listeners, pero acepta otros viewports solicitados. La ventana pasiva se ajusta al monitor;
la emulación lógica se restaura al devolver control. Las capturas pueden guardarse como PNG
en workspaces autorizados y compararse mediante un diff reproducible.

La ventana puede cerrarse a bandeja. **Salir** desconecta y termina procesos administrados.
Consulta [la guía de usuario](../../docs/USER_GUIDE.md) y
[privacidad](../../docs/PRIVACY_AND_TRUST.md).
