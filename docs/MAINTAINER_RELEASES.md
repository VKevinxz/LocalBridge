# Publicar una release

Este documento describe el flujo para mantenedores. Los instaladores nunca se agregan al
historial Git.

## Requisitos

- versión coherente en todos los manifests y `SERVER_VERSION`;
- nota pública `docs/releases/vMAJOR.MINOR.PATCH.md`;
- postura `UNLICENSED`, aviso de copyright y editor `VKevinXZ` coherentes;
- `main` protegido y CI verde;
- environment `release` con aprobación;
- `WIN_CSC_LINK` y `WIN_CSC_KEY_PASSWORD` configurados como secrets;
- aceptación en Windows limpio.

## Gate local

```powershell
pnpm install --frozen-lockfile
pnpm build:native:test
pnpm lint
pnpm typecheck
pnpm test
pnpm test:sec
pnpm audit --audit-level moderate
pnpm --filter @localbridge/desktop build
```

Genera además un snapshot público y audítalo antes del primer push:

```powershell
./scripts/export-public-source.ps1 -Destination ./dist/public-source
```

## GitHub

El workflow de release se activa únicamente con tags `vMAJOR.MINOR.PATCH` contenidos en
`main`. Compila, firma, valida timestamp, genera SBOM SPDX y checksums, crea atestación y
publica la release estable. No crees el tag si algún gate está incompleto.

## Prerelease de evaluación sin firma

El workflow separado `preview-release.yml` admite únicamente tags
`preview-vMAJOR.MINOR.PATCH.SEQUENCE`. No utiliza credenciales de firma y exige que el
instalador resulte exactamente `NotSigned`; cualquier otro estado falla cerrado.

Antes de crear el tag:

- fusiona el cambio en `main` mediante PR con CI verde;
- añade `docs/releases/<tag>.md` con un aviso visible de binario sin firma;
- conserva la versión base de los manifests igual a `MAJOR.MINOR.PATCH`;
- confirma que el tag apunta a un commit contenido en `main`.

El workflow vuelve a ejecutar las validaciones, genera checksum y SBOM, crea una atestación
de GitHub y publica con `--prerelease`. Nunca cambies `release.yml` para omitir firma o
timestamp: cuando exista certificado, la release estable seguirá usando exclusivamente
`vMAJOR.MINOR.PATCH`.

Después del primer push aplica los rulesets y el environment con
`scripts/configure-github-repository.ps1`, usando un token fine-grained solo como variable
de entorno del proceso.
