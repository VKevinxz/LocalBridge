# Política de seguridad

## Versiones soportadas

| Versión | Estado |
|---|---|
| `1.1.x` | Preview actual; recibe correcciones |
| `1.0.x` | Compatibilidad y correcciones críticas según viabilidad |
| `< 1.0` | Sin soporte regular |

## Reportar una vulnerabilidad

Usa **Security → Report a vulnerability** en el
[repositorio oficial](https://github.com/VKevinxz/LocalBridge/security/advisories/new).
No abras una incidencia pública y no adjuntes claves, tokens, rutas personales, contenido
de proyectos, bases de auditoría ni configuraciones locales.

Incluye, cuando sea seguro:

- versión y sistema operativo;
- impacto y precondiciones;
- pasos mínimos con fixtures ficticios;
- mitigación temporal conocida;
- componentes afectados, sin payloads o credenciales reales.

El objetivo es confirmar recepción en tres días hábiles y comunicar una primera evaluación
en siete. No constituye un SLA. La divulgación se coordina después de contar con una
corrección o mitigación razonable.

## Alcance prioritario

- escape de workspace o acceso a rutas no autorizadas;
- bypass de permisos, hashes, aprobación o consentimiento local;
- exposición de claves, variables de entorno o contenido;
- ejecución de comandos no autorizados;
- confianza indebida en IPC, listeners, procesos o navegador;
- migraciones que amplíen autoridad;
- artefactos de release sin integridad o procedencia.

El diseño general se resume en [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md). El contrato
técnico completo, incluidas las cuotas web y el staging por chunks de v1.6.1, está en
[docs/SECURITY.md](docs/SECURITY.md).
