# Modelo público de seguridad

## Objetivo

LocalBridge permite trabajo remoto sobre recursos elegidos sin presentar todo el equipo
como autorizado por defecto. El sistema asume que el modelo, el proyecto abierto, los
manifiestos y la red pueden contener entradas hostiles.

## Fronteras principales

1. **Selección local:** la raíz se elige mediante UI nativa, no desde MCP.
2. **Permisos:** toda capacidad comienza denegada y se comprueba antes de operar.
3. **Rutas:** MCP usa IDs y rutas relativas; se rechazan escapes y enlaces inseguros.
4. **Concurrencia:** reemplazos exigen el hash observado por el cliente.
5. **Ejecución:** Guiado usa acciones cerradas; Control total requiere consentimiento
   reforzado y no promete sandbox.
6. **Procesos:** listeners y árboles se validan mediante autoridad local del sistema.
7. **Navegador:** orígenes locales quedan ligados a listeners vigentes y particiones
   efímeras.
8. **Auditoría:** acciones sensibles dejan metadatos sin contenido de archivos.

## Amenazas consideradas

- traversal y escape por symlink/junction;
- lectura o escritura fuera del workspace;
- sustitución concurrente de archivos;
- inyección mediante argumentos Git o comandos;
- scripts maliciosos declarados por un proyecto;
- puertos ajenos o reutilizados;
- mensajes IPC falsificados;
- fuga de claves, rutas, entorno o contenido;
- migraciones que activen permisos por accidente;
- reintentos que dupliquen commits, procesos o mutaciones.

## Límites explícitos

- Control total ejecuta con la autoridad de la cuenta Windows.
- La exclusión del agente durante una intervención no vuelve confiable a la página abierta.
- Git y los servicios pueden usar credenciales administradas fuera de LocalBridge.
- La auditoría local ayuda a investigar, pero no sustituye respaldos o controles del
  proveedor Git.
- Ningún software elimina el riesgo de aprobar una operación sin revisar su alcance.

## Reporte

No publiques exploits ni datos reales en una incidencia. Usa el procedimiento de
[SECURITY.md](../SECURITY.md).
