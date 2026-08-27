# Actualizar, respaldar, revocar y desinstalar

## Actualizar

1. Exporta la configuración desde **Ajustes**.
2. Usa **Salir** para cerrar túnel, terminales, procesos y navegadores.
3. Descarga instalador y checksums desde la misma GitHub Release.
4. Verifica SHA-256, firma digital y timestamp.
5. Instala sobre la versión existente.
6. Abre LocalBridge y comprueba conexión y proyectos.

`v1.1.0` migra el estado de onboarding sin ampliar permisos. Una instalación ya completada
no debería volver a mostrar el asistente automáticamente.

## Respaldo portable

La exportación conserva configuración no secreta y referencias portables. No contiene:

- claves ni blobs cifrados;
- rutas absolutas;
- logs o auditoría;
- credenciales Git;
- contenido de proyectos.

En otra PC debes remapear carpetas con el selector nativo e introducir una clave de runtime
nueva. DPAPI vincula cada blob a la cuenta Windows que lo creó.

## Revocar

1. Pausa o elimina el proyecto en LocalBridge.
2. Revoca Control total si estaba activo.
3. Olvida la clave cifrada del perfil.
4. Revoca o elimina el túnel en su proveedor.
5. Revoca por separado cualquier credencial Git.

Eliminar una ficha no borra la carpeta del proyecto.

## Desinstalar

1. Sal explícitamente desde la bandeja.
2. Desinstala **LocalBridge MCP** desde Configuración de Windows → Aplicaciones.

Los datos del usuario pueden permanecer para permitir reinstalación. Antes de eliminarlos,
respalda y verifica exactamente:

- `%USERPROFILE%\.localbridge-mcp\`;
- el directorio de datos de LocalBridge bajo `%APPDATA%`.

Eliminar esos datos es independiente de desinstalar y no puede deshacerse desde la app.

## Recuperación

Si una actualización falla, reinstala el último artefacto firmado conocido y restaura la
configuración portable. No copies `tunnel-key.enc` entre cuentas ni restaures `audit.db`
como configuración.
