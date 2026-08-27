# Instalación segura en Windows

LocalBridge controla archivos, procesos, Git y navegador local. Trata el instalador como
software de alta confianza y descárgalo únicamente desde la release oficial del
repositorio.

## Antes de ejecutar

1. Descarga el instalador y `SHA256SUMS.txt` de la misma release.
2. Calcula el hash SHA-256 y comprueba que coincida exactamente.
3. Analiza el archivo con Microsoft Defender actualizado.
4. Abre **Propiedades → Firmas digitales** y confirma una firma válida con timestamp.
5. Revisa las notas de versión y prueba primero con una carpeta sin datos sensibles.

## SmartScreen y Smart App Control

Microsoft Defender SmartScreen usa reputación para advertir sobre aplicaciones poco
conocidas. Smart App Control puede bloquear aplicaciones no confiables y no ofrece una
excepción individual para cada ejecutable.

**No desactives Defender, SmartScreen ni Smart App Control para instalar LocalBridge.**
Desactivar una protección global reduce la seguridad de todo el equipo y no demuestra que
el archivo sea legítimo.

Si Windows muestra una advertencia:

- confirma que el archivo provenga de la release oficial;
- vuelve a comprobar hash, nombre, versión y firma;
- si la ventana ofrece una opción explícita para continuar y aceptas el riesgo, esa es una
  decisión local del usuario, no un requisito de LocalBridge;
- si Smart App Control lo bloquea sin excepción, no cambies su configuración: usa Windows
  Sandbox o una VM desechable, compila el código revisado en un entorno de desarrollo, o
  espera una release firmada.

Consulta la documentación oficial de Microsoft sobre
[App & browser control](https://support.microsoft.com/en-us/windows/security/windows-security-app-browser-control-in-the-windows-security-app) y
[Attachment Manager](https://support.microsoft.com/en-US/Windows/Security/information-about-the-attachment-manager-in-microsoft-windows).

## Candidatos no firmados

`VKevinXZ` es el nombre del editor en los metadatos del paquete. No es una firma digital.
Hasta que un certificado Authenticode válido firme el ejecutable, Windows puede mostrar
**Editor desconocido** o bloquearlo por reputación.

Un candidato no firmado sirve únicamente para evaluación controlada y no debe anunciarse
como release estable. La opción recomendada es una VM o Windows Sandbox sin proyectos ni
credenciales reales. Conserva SmartScreen y Defender activos.

## Después de instalar

- empieza en modo Guiado y con una carpeta de demostración;
- no pegues claves de runtime en chats, issues o capturas;
- revisa cada permiso antes de habilitar Control total;
- desinstala la aplicación y elimina sus datos locales si la prueba no continuará.
