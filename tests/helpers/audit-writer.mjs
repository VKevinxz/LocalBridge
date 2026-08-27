// Escribe un único evento de auditoría y sale. Se invoca como proceso Node
// aparte (no en el mismo proceso que el test) porque el bug de concurrencia
// que este fixture reproduce solo aparece entre procesos del SO distintos
// compitiendo por el mismo fichero SQLite — la concurrencia dentro de un
// mismo proceso Node no lo dispara (ver STATUS.md, Fase 6).
import { recordAuditEvent, buildAuditEvent } from '../../packages/audit/src/index.ts';

const [, , dbPath, action] = process.argv;

try {
  recordAuditEvent(
    dbPath,
    buildAuditEvent({ action, riskLevel: 'R1', decision: 'allow', outcome: 'success', durationMs: 1 }),
  );
  process.exit(0);
} catch (error) {
  process.stderr.write(String(error?.message ?? error));
  process.exit(1);
}
