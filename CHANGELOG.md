# Changelog

Los cambios relevantes de LocalBridge MCP se documentan aquí. El proyecto sigue
[Semantic Versioning](https://semver.org/lang/es/) y publica artefactos mediante GitHub
Releases.

## [1.2.1] — 2026-08-28

### Mejorado

- el límite de terminales concurrentes pasa de 4 a 8 por proyecto y de 12 a 16 en total.

### Corregido

- una terminal cerrada dejaba de liberarse nunca y retenía su salida completa hasta cerrar la
  aplicación; ahora se conserva 30 minutos o hasta 24 sesiones cerradas.

### Seguridad y distribución

- se fijan versiones corregidas de dependencias transitivas del empaquetador para evitar
  vulnerabilidades conocidas en el pipeline de distribución;
- las preparaciones, limpiezas y pruebas de integración que operan repositorios Git reales
  disponen de un margen explícito de 30 segundos en Windows, sin ampliar el timeout global
  ni relajar aserciones de seguridad.

## [1.2.0] — 2026-08-28

### Añadido

- `browser.viewport`: emula un tamaño de vista para comprobar diseño responsive y puntos de
  ruptura, con emulación táctil opcional;
- las capturas informan el tamaño realmente renderizado.

### Seguridad

- el tamaño se emula sin redimensionar ventanas del usuario y se restablece cuando la persona
  toma el control local;
- la tool acepta solo dimensiones enteras acotadas y una bandera táctil: ni URL, ni puerto, ni
  selector, ni agente de usuario, ni escala de dispositivo.

## [1.1.2] — 2026-08-28

### Corregido

- la detección de campos de credenciales del navegador compara palabras completas y deja de
  bloquear campos inocentes como `secretaria` o `wizard`;
- se reconocen términos en español (`contraseña`, `clave de acceso`, `tarjeta`, `código de
  seguridad`) que antes no se detectaban;
- se distingue «palabra clave» de una clave real y se tiene en cuenta el texto de ayuda del
  campo.

## [1.1.1] — 2026-08-28

### Corregido

- un escaneo de estructura incompleto ya no degrada el estado de un proyecto ni revoca
  capacidades concedidas: la cobertura pasa a ser un metadato informado, no un estado;
- `project.list` informa estado y cobertura para que el cliente pueda explicar una
  estructura parcial;
- leer, consultar y cerrar una terminal existente dejan de bloquearse cuando el proyecto
  requiere revisión; iniciar y escribir conservan la revisión;
- un proyecto que quedó en revisión vuelve a evaluarse solo, incluso al arrancar;
- el presupuesto del escaneo respeta la denylist y omite directorios de datos y cachés.

## [1.1.0] — 2026-08-27

### Añadido

- onboarding project-first de seis pasos;
- detección read-only de carpeta vacía, repositorio, monorepo y multirepo;
- selección de confianza y presets Guiados antes de registrar el proyecto;
- estado de onboarding reanudable y compatible con downgrade.

### Mejorado

- comprobación automática del runtime incluido;
- finalización transaccional con rollback e idempotencia;
- interfaz compacta y recuperación orientada a acciones.

### Seguridad

- selector nativo representado mediante token efímero ligado a la ventana;
- `Agente en proyecto` continúa cerrado sin sandbox demostrado;
- no cambió el catálogo MCP ni el protocolo `2026-07-28`.

## [1.0.0] — 2026-08-26

- proyectos como unidad principal de producto;
- terminal interactiva opcional bajo confianza local explícita;
- listeners verificados y navegador multiservicio derivado de procesos administrados;
- intervención humana temporal y vista en vivo no interactiva.

## [0.9.0] — 2026-08-25

- creación y adopción asistida de proyectos;
- detección de topología y preparación mediante acciones cerradas;
- compatibilidad aditiva con configuraciones existentes.

## [0.3.0] — 2026-08-23

- runtime de desarrollo controlado;
- procesos aprobados, logs, puertos verificados y navegador local aislado.

## [0.2.0] — 2026-08-22

- operaciones Git de escritura con aprobación humana;
- aplicación de escritorio autocontenida y administración de conexión.

## [0.1.0] — 2026-08-21

- baseline funcional de filesystem, Git de lectura, validaciones, auditoría y Secure MCP
  Tunnel.

[1.2.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.2.1
[1.2.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.2.0
[1.1.2]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.2
[1.1.1]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.1
[1.1.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.1.0
[1.0.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v1.0.0
[0.9.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.9.0
[0.3.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.3.0
[0.2.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/VKevinxz/LocalBridge/releases/tag/v0.1.0
