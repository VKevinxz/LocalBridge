# Instalar LocalBridge en cinco minutos

LocalBridge `v1.1.0` se distribuye como preview para Windows x64. Usa únicamente archivos
publicados en la sección oficial de Releases del repositorio.

## 1. Descargar y verificar

1. Abre [la página oficial de Releases](https://github.com/VKevinxz/LocalBridge/releases)
   y selecciona la preview indicada en [Descargas](DOWNLOADS.md).
2. Descarga `LocalBridge MCP Setup <versión>.exe` y `SHA256SUMS.txt`.
3. Calcula el hash:

```powershell
Get-FileHash -Algorithm SHA256 '.\LocalBridge MCP Setup 1.1.0.exe'
```

4. Comprueba que coincide exactamente con `SHA256SUMS.txt`.
5. Si es una release estable, verifica su firma válida con timestamp. Si la nota la marca
   como preview sin firma, comprueba el checksum y la atestación y evalúala solo en un
   entorno no crítico.

Si el hash no coincide, o una release estable carece de la firma prometida, no ejecutes el
instalador y repórtalo mediante el canal de seguridad.

Un candidato no firmado puede mostrar advertencias o ser bloqueado por Windows. No
desactives protecciones del sistema para instalarlo; sigue
[Instalación segura en Windows](WINDOWS_INSTALLATION.md).

## 2. Completar la configuración inicial

El asistente contiene seis pasos:

1. **Bienvenida:** revisa qué puede hacer LocalBridge.
2. **Sistema:** espera la comprobación automática del servidor y componentes incluidos.
3. **Conexión:** introduce el tunnel ID y una clave de runtime válida.
4. **Proyecto:** elige una carpeta raíz con el selector de Windows.
5. **Acceso:** conserva **Guiado** para empezar y selecciona las capacidades necesarias.
6. **Revisión:** confirma el resumen y termina la configuración local.

Elegir la carpeta no instala paquetes ni inicia servidores. Si contiene frontend, backend
o varios repositorios, LocalBridge los mantiene agrupados bajo el mismo proyecto.

## 3. Registrar el conector en ChatGPT

La aplicación abre los destinos oficiales necesarios para crear o seleccionar el túnel.
En ChatGPT, registra el conector MCP usando el túnel indicado por LocalBridge. Nunca pegues
la clave de runtime en una conversación.

Comprueba la conexión con una solicitud sencilla:

> Valida la conexión de LocalBridge y enumera los proyectos disponibles sin modificar nada.

La respuesta debe indicar `ready`, versión `1.1.0` y protocolo `2026-07-28`.

## 4. Primera prueba segura

Autoriza una carpeta de demostración y solicita:

> Revisa la estructura del proyecto y el estado de Git sin modificar archivos ni iniciar
> servicios.

Después prueba una validación o servidor previamente aprobado. Revisa siempre el resumen
antes de permitir un commit, push o Control total.

## 5. Siguiente paso

- Uso diario: [USER_GUIDE.md](USER_GUIDE.md).
- Privacidad y revocación: [PRIVACY_AND_TRUST.md](PRIVACY_AND_TRUST.md).
- Problemas frecuentes: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- Actualización y desinstalación: [OPERATIONS.md](OPERATIONS.md).
- Firma, SmartScreen y candidatos no firmados: [WINDOWS_INSTALLATION.md](WINDOWS_INSTALLATION.md).
