import pino from 'pino';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startWorkerLoop } from './worker-loop.js';

/** Processo dedicado à fila de jobs (use com RUN_WORKER_IN_PROCESS=false na API) */
const log = pino({ level: config.LOG_LEVEL });

async function main() {
  await migrate((m) => log.info(m));
  const stop = startWorkerLoop(log);
  const shutdown = async () => {
    await stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'falha no worker');
  process.exit(1);
});
