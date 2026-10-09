import pg from 'pg';
import { config } from './config.js';
import { runDueJobs } from './lib/jobs.js';
import { registerAllJobs, schedulerTick } from './services/scheduler.js';

/** Laço do processador de jobs: acorda por NOTIFY ou a cada 5s; agendador a cada 60s */
export function startWorkerLoop(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  registerAllJobs();
  let running = false;
  let stopped = false;
  let pending = false;

  const drain = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        while (!stopped && (await runDueJobs(10, log)) > 0) {
          /* continua enquanto houver jobs prontos */
        }
      } while (pending && !stopped);
    } catch (err) {
      log.error({ err }, 'erro no processador de jobs');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(drain, 5000);
  const sched = setInterval(() => schedulerTick(log).catch((err) => log.error({ err }, 'agendador')), 60_000);
  setTimeout(() => schedulerTick(log).catch(() => {}), 5000);

  let listener: pg.Client | null = null;
  const listen = async () => {
    try {
      listener = new pg.Client({ connectionString: config.DATABASE_URL });
      await listener.connect();
      await listener.query('LISTEN crm_jobs');
      listener.on('notification', () => void drain());
      listener.on('error', () => {
        listener?.end().catch(() => {});
        if (!stopped) setTimeout(listen, 3000);
      });
    } catch {
      if (!stopped) setTimeout(listen, 5000);
    }
  };
  void listen();
  void drain();
  log.info('processador de jobs iniciado');

  return async () => {
    stopped = true;
    clearInterval(interval);
    clearInterval(sched);
    await listener?.end().catch(() => {});
  };
}
