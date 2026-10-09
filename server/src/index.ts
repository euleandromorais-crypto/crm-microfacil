import { buildApp } from './app.js';
import { config } from './config.js';
import { ensureDefaults } from './db/defaults.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startRealtimeListener, stopRealtimeListener } from './lib/realtime.js';
import { startWorkerLoop } from './worker-loop.js';

async function main() {
  const app = await buildApp();
  await migrate((m) => app.log.info(m));
  await ensureDefaults();
  await startRealtimeListener(app.log);
  const stopWorker = config.RUN_WORKER_IN_PROCESS ? startWorkerLoop(app.log) : null;
  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} recebido, encerrando...`);
    await stopWorker?.();
    await app.close();
    await stopRealtimeListener();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
