# Principios de diseño

Este documento resume las decisiones que una persona usuaria, colaboradora o auditora
necesita conocer. El historial detallado de deliberaciones, planes de trabajo y notas
internas de desarrollo no forma parte de la distribución pública.

## Autoridad local

- Solo la aplicación de escritorio puede autorizar carpetas, elegir el nivel de confianza
  o ampliar capacidades.
- Ninguna tool MCP acepta una raíz, una ruta absoluta ni un nivel de confianza enviado por
  el modelo.
- Quitar o deshabilitar un proyecto invalida su autoridad sin depender de reiniciar ChatGPT.

## Acceso a archivos

- Toda ruta se interpreta dentro del workspace autorizado y se vuelve a validar antes de
  una mutación.
- Crear y reemplazar son permisos distintos. Reemplazar exige el hash SHA-256 observado
  inmediatamente antes de escribir.
- Los enlaces simbólicos y los escapes de ruta se rechazan con fallo cerrado.

## Git

- Las operaciones disponibles tienen parámetros cerrados; no existe una cadena Git libre.
- `commit` y `push` conservan aprobación humana y no ofrecen variantes forzadas.
- Los identificadores de operación evitan duplicar mutaciones durante reintentos.

## Procesos, terminal y navegador

- Los perfiles guiados ejecutan comandos declarados localmente; el modelo selecciona un
  nombre aprobado, no un comando arbitrario.
- La terminal general depende del nivel de confianza elegido en el equipo. El modo Guiado
  la deniega, el modo Agente exige aislamiento demostrable y Control total requiere una
  confirmación local explícita.
- El navegador solo abre listeners verificados de procesos administrados. La intervención
  humana suspende el control del agente y usa la misma sesión, sin compartir credenciales
  mediante el canal MCP.

## Auditoría y privacidad

- La auditoría registra la operación, decisión y recurso relativo, no contenido de
  archivos, contraseñas, tokens ni variables de entorno secretas.
- Las capturas del visor son efímeras y permanecen en memoria.
- Si LocalBridge no puede demostrar que una operación cumple su política, la deniega.

Consulta también [Arquitectura](ARCHITECTURE.md),
[Modelo de seguridad](SECURITY_MODEL.md) y
[Privacidad y confianza](PRIVACY_AND_TRUST.md).
