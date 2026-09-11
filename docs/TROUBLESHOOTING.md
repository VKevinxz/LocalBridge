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

## Windows solicita permitir LocalBridge en redes privadas o públicas

La navegación web aislada usa un proxy temporal que escucha únicamente en
`127.0.0.1`. No necesita aceptar conexiones entrantes desde la LAN ni desde una red
pública. Puedes denegar la solicitud del Firewall de Windows y seguir usando la salida
HTTPS de LocalBridge. No desactives el firewall ni crees una regla entrante amplia para
resolver problemas de navegación.

Si ya concediste acceso, eso no demuestra por sí solo que LocalBridge esté expuesto: revisa
que sus listeners estén vinculados a `127.0.0.1`. La aplicación no modifica ni elimina
reglas del firewall automáticamente.

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

## El visor 1920×1080 se ve recortado o más pequeño

Revisa las métricas de la sesión en **Actividad**. **Render** es el viewport que usa
ChatGPT y **visible** es el área física disponible. En **Encajar**, ambos pueden tener
dimensiones distintas y una escala menor de 100 %, pero deben verse los cuatro bordes sin
deformación. En **1:1** la escala es 100 % y el recorte es intencional; usa las flechas para
desplazar la vista local. Ese pan no desplaza la página ni cambia screenshots.

Si Encajar corta un borde, copia el diagnóstico indicando monitor, escala DPI, Render,
visible y porcentaje. Cambiar la resolución con los presets modifica el viewport de prueba;
no lo uses para corregir un problema de presentación.

## Una captura de movimiento se detuvo

Navegar, cerrar, revocar acceso, pulsar **Tomar control** o **Cancelar captura** invalida la
traza. Si ya había comenzado el scroll, LocalBridge informa efecto incierto y no repite el
mismo `operationId`. Inspecciona la pestaña, decide si debes recargar o volver al inicio y
crea una operación nueva. Un destino `.lbmotion` parcial no debe quedar publicado; el
staging se limpia durante el fallo y también al reiniciar tras un cierre abrupto.

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
