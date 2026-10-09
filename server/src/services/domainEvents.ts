import { pool, Queryable } from '../db/pool.js';
import { enqueue } from '../lib/jobs.js';

/**
 * Eventos de negócio. São gravados como jobs na mesma transação da alteração,
 * garantindo que automações e webhooks de saída sejam executados mesmo após falhas temporárias.
 */
export type DomainEventType =
  | 'lead.created'
  | 'lead.updated'
  | 'lead.status_changed'
  | 'lead.owner_changed'
  | 'opportunity.created'
  | 'opportunity.stage_changed'
  | 'opportunity.won'
  | 'opportunity.lost'
  | 'conversation.closed'
  | 'message.received'
  | 'task.completed';

export interface DomainEvent {
  type: DomainEventType;
  leadId?: number | null;
  opportunityId?: number | null;
  conversationId?: number | null;
  taskId?: number | null;
  userId?: number | null;
  data?: Record<string, unknown>;
  /** evita que automações disparem automações em cascata infinita */
  depth?: number;
}

export async function emitDomainEvent(event: DomainEvent, db: Queryable = pool) {
  await enqueue('domain.event', { ...event, at: new Date().toISOString() }, { maxAttempts: 5 }, db);
}
