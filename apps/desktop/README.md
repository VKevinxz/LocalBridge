# Aplicación de escritorio

Electron aloja la configuración local, el onboarding, la supervisión del túnel, proyectos,
procesos, navegador y auditoría de LocalBridge.

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

El paquete oficial incluye el servidor MCP, Node.js privado, tunnel-client y el helper de
procesos. `package:win:signed` exige credenciales de firma válidas. `out/`, `release/` y
`vendor/` son artefactos locales y no se versionan.

La ventana puede cerrarse a bandeja. **Salir** desconecta y termina procesos administrados.
Consulta [la guía de usuario](../../docs/USER_GUIDE.md) y
[privacidad](../../docs/PRIVACY_AND_TRUST.md).
