# Descargas y verificación

## Preview disponible

- [Preview v1.2.1.2 sin firma](https://github.com/VKevinxz/LocalBridge/releases/tag/preview-v1.2.1.2)
- [Repositorio oficial](https://github.com/VKevinxz/LocalBridge)
- [Instalador Windows x64 v1.2.1 — sin firma](https://github.com/VKevinxz/LocalBridge/releases/download/preview-v1.2.1.2/LocalBridge.MCP.Setup.1.2.1.exe)
- [Checksums de la preview](https://github.com/VKevinxz/LocalBridge/releases/download/preview-v1.2.1.2/SHA256SUMS.txt)

No descargues instaladores desde issues, adjuntos, mirrors o repositorios de terceros.

Esta descarga es un **prerelease de evaluación sin firma Authenticode**, no una versión
estable. Windows puede mostrar `Editor desconocido` o bloquearla. Mantén las protecciones
del sistema activas y consulta [Instalación segura en Windows](WINDOWS_INSTALLATION.md).

## Verificar integridad

```powershell
Get-FileHash -Algorithm SHA256 '.\LocalBridge MCP Setup 1.2.1.exe'
```

Compara el resultado completo con `SHA256SUMS.txt`. La preview publicada se verifica además
con SBOM y atestación de GitHub, pero aparecerá como `NotSigned`: esas evidencias no
sustituyen una firma Authenticode. Una release **estable** de LocalBridge sigue fallando
cerrada si no dispone de firma válida con timestamp, checksum, SBOM y procedencia.

## Compatibilidad

| Componente | Soporte actual |
|---|---|
| Windows 11 x64 | Soportado |
| Windows 10 x64 | Preview; requiere prueba por release |
| ARM64, macOS y Linux | No soportados actualmente |
| Instalación sin Node.js | Soportada; el runtime viene incluido |

## Versiones anteriores

Consulta [todas las releases](https://github.com/VKevinxz/LocalBridge/releases). Las versiones anteriores se mantienen
solo cuando su nota de release lo indica. No combines archivos de releases diferentes al
verificar hashes o reinstalar.
