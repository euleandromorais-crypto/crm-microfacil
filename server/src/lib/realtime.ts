import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from '../config.js';
import { pool, Queryable } from '../db/pool.js';

/**
 * Barramento de eventos em tempo real.
 * Eventos são "sinais de atualização" (sem dados sensíveis) — o navegador recebe o aviso via SSE
 * e busca os dados pela API, que aplica as permissões. Atravessa processos via LISTEN/NOTIFY.
 */
export interface RealtimeEvent {
  type: string;                 // ex.: conversation.updated, message.created, notification.created
  id?: number;
  conversationId?: number;
  leadId?: number;
  /** usuários destinatários; ausente = todos os usuários com acesso ao módulo */
  users?: number[];
  /** se true, gestores e administradores também recebem mesmo quando users é informado */
  managers?: boolean;
}

const CHANNEL = 'crm_events';
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export async function publish(event: RealtimeEvent, db: Queryable = pool) {
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(event)]);
}

let listener: pg.Client | null = null;
let stopping = false;

export async function startRealtimeListener(log: { error: (...a: any[]) => void; info: (...a: any[]) => void }) {
  stopping = false;
  const connect = async () => {
    try {
      const client = new pg.Client({ connectionString: config.DATABASE_URL });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          bus.emit('event', JSON.parse(msg.payload));
        } catch {
          /* ignora payload inválido */
        }
      });
      client.on('error', (err) => {
        log.error({ err }, 'realtime: conexão LISTEN perdida, reconectando');
        client.end().catch(() => {});
        listener = null;
        if (!stopping) setTimeout(connect, 2000);
      });
      listener = client;
    } catch (err) {
      log.error({ err }, 'realtime: falha ao conectar LISTEN, nova tentativa em 5s');
      if (!stopping) setTimeout(connect, 5000);
    }
  };
  await connect();
}

export async function stopRealtimeListener() {
  stopping = true;
  if (listener) await listener.end().catch(() => {});
  listener = null;
}
