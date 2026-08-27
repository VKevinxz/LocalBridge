# Solución de problemas

## El instalador no coincide con el checksum

No lo ejecutes. Descarga nuevamente el instalador y `SHA256SUMS.txt` desde la misma release.
No mezcles archivos de versiones diferentes.

## Windows no muestra una firma válida

No continúes con una release pública. Verifica que el archivo provenga de Releases y que
la firma tenga timestamp. Un build local de desarrollo puede estar sin firmar, pero no es
un artefacto de distribución.

## El túnel no conecta

1. Confirma el perfil y tunnel ID.
2. Introduce una clave nueva si fue revocada.
3. Ejecuta **Diagnosticar** y atiende el primer check fallido.
4. Comprueba que firewall o proxy permitan HTTPS saliente.

LocalBridge no requiere desactivar antivirus, firewall o controles corporativos.

## Solo aparecen algunos proyectos o servicios

El asistente de aplicaciones muestra únicamente servicios con perfil aprobado. Revisa la
estructura del proyecto y vuelve a detectar perfiles. Una carpeta padre puede agrupar
frontend, backend y repositorios hijos sin autorizar cada uno de nuevo.

## Un servicio no inicia

- comprueba que el perfil sigue coincidiendo con el script del manifiesto;
- revisa si el puerto ya está ocupado;
- consulta el log del proceso en Actividad;
- inicia manualmente el mismo script fuera de LocalBridge para comparar;
- vuelve a guardar el perfil si el manifiesto cambió.

No amplíes permisos ni expongas el servicio a la LAN solo para superar la detección.

## El frontend no llega a la API

Confirma que ambos servicios pertenecen al mismo proyecto o aplicación, que sus listeners
están verificados y que el origen permitido coincide con la configuración real del proyecto.
LocalBridge no modifica CORS, `.env` ni URLs del frontend.

## Vite no conecta HMR

La conexión WebSocket debe usar el mismo listener verificado. Revisa consola y red. No
añadas orígenes de Internet ni desactives la política del navegador para corregirlo.

## El navegador se ve lento en el visor

El visor ligero usa capturas periódicas y no pretende reproducir video a FPS completo. Usa
la vista en vivo para observar animaciones fluidas. La vista en vivo es solo lectura bajo
control del agente y se oculta antes de entregar control humano.

## Necesito login o seleccionar un archivo

Usa **Tomar control** en la sesión abierta. El agente queda excluido hasta que devuelvas la
sesión. Emplea cuentas y archivos de prueba porque la aplicación puede procesar lo que
introduzcas.

## Git indica éxito, pero el proveedor no cambió

Comprueba el hash local, `ahead/behind` y la referencia remota. Para push, confirma también
el estado en el proveedor. Una afirmación del cliente no sustituye la verificación remota.

## La clave funciona en una PC y no en otra

Es esperado. El cifrado DPAPI pertenece a la cuenta Windows original. Importa la
configuración e introduce una clave nueva.

## ¿Cerrar la ventana detiene LocalBridge?

Puede quedar en la bandeja. Usa **Salir** para desconectar y terminar.

## Qué adjuntar a una incidencia

Usa **Actividad → Copiar diagnóstico**, revisa el texto y elimina datos privados. Nunca
adjuntes `.env`, claves, proyectos, `workspaces.json`, settings o `audit.db`.
