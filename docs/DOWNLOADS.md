# Descargas y verificación

## Versión recomendada

- [Última release publicada](https://github.com/VKevinxz/LocalBridge/releases/latest)
- [Repositorio oficial](https://github.com/VKevinxz/LocalBridge)
- [Release v1.1.0](https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.0)
- [Instalador Windows x64 v1.1.0](https://github.com/VKevinxz/LocalBridge/releases/download/v1.1.0/LocalBridge%20MCP%20Setup%201.1.0.exe)
- [Checksums v1.1.0](https://github.com/VKevinxz/LocalBridge/releases/download/v1.1.0/SHA256SUMS.txt)

Los enlaces estarán disponibles cuando el mantenedor publique la release correspondiente.
No descargues instaladores desde issues, adjuntos, mirrors o repositorios de terceros.

Las releases estables exigen firma digital. Un candidato local o artefacto de evaluación
sin firma no debe presentarse como release oficial. Consulta
[Instalación segura en Windows](WINDOWS_INSTALLATION.md) antes de probarlo.

## Verificar integridad

```powershell
Get-FileHash -Algorithm SHA256 '.\LocalBridge MCP Setup 1.1.0.exe'
```

Compara el resultado completo con `SHA256SUMS.txt`. Después verifica en las propiedades del
archivo que la firma Authenticode sea válida y tenga timestamp. Una release pública de
LocalBridge falla cerrada si no dispone de firma, checksum, SBOM y procedencia.

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
