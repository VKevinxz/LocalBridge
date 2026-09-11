# Instalar LocalBridge en cinco minutos

El árbol local de LocalBridge corresponde al candidato `v1.7.0` para Windows x64. La última
preview publicada sigue siendo `v1.2.1.2`; usa únicamente artefactos de Releases o un
`win-unpacked` generado y verificado desde este mismo árbol.

## 1. Descargar y verificar

1. Abre [la página oficial de Releases](https://github.com/VKevinxz/LocalBridge/releases)
   y selecciona la preview indicada en [Descargas](DOWNLOADS.md).
2. Descarga `LocalBridge MCP Setup <versión>.exe` y `SHA256SUMS.txt`.
3. Calcula el hash:

```powershell
Get-FileHash -Algorithm SHA256 '.\LocalBridge MCP Setup <versión>.exe'
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

La respuesta debe indicar `ready`, versión `1.7.0` para el candidato local y protocolo
`2026-07-28`.

## 4. Primera prueba segura

Autoriza una carpeta de demostración y solicita:

> Revisa la estructura del proyecto y el estado de Git sin modificar archivos ni iniciar
> servicios.

Después prueba una validación o servidor previamente aprobado. Revisa siempre el resumen
antes de permitir un commit, push o Control total.

## 5. Activar el navegador de Internet

1. Abre **Acceso a Internet** dentro de Configuración.
2. Revisa el alcance y pulsa **Habilitar navegación por Internet**. La descarga de
   documentos es opcional y no concede escritura en carpetas.
3. Usa las opciones avanzadas solo si necesitas limitar un sitio o revisar perfiles.
4. Inicia una conversación nueva o actualiza el conector para que el host descubra las 89
   tools del candidato.
5. Pide: «Investiga este tema en dos fuentes públicas, compáralas y cita los enlaces».
6. Mientras la sesión siga activa, abre **Actividad**, elige una pantalla y pulsa
   **Ver y seguir**. La ventana es de solo lectura; ciérrala u ocúltala sin detener la tarea.

No hace falta autorizar una carpeta para investigar. Para guardar una descarga o informe,
autoriza después una carpeta y habilita creación de archivos; el perfil web no concede
escritura por sí solo.

Puedes fijar una pestaña para mantenerla visible aunque ChatGPT trabaje en otra. Pulsa
**Tomar control** para un login o cualquier paso manual: la vista pasiva se cierra antes de
habilitar entrada. Al devolver una sesión pública, confirma el hostname exacto que ChatGPT
podrá continuar durante un máximo de 15 minutos.

## 6. Siguiente paso

- Uso diario: [USER_GUIDE.md](USER_GUIDE.md).
- Privacidad y revocación: [PRIVACY_AND_TRUST.md](PRIVACY_AND_TRUST.md).
- Problemas frecuentes: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- Actualización y desinstalación: [OPERATIONS.md](OPERATIONS.md).
- Firma, SmartScreen y candidatos no firmados: [WINDOWS_INSTALLATION.md](WINDOWS_INSTALLATION.md).
