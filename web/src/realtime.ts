import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export interface RtEvent {
  type: string;
  id?: number;
  conversationId?: number;
  leadId?: number;
}

type Listener = (e: RtEvent) => void;
const listeners = new Set<Listener>();
export function onRealtime(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Conecta ao SSE e invalida as consultas afetadas (dados são sempre buscados pela API, que aplica permissões).
 * Atualizações agrupadas a cada 400ms para evitar excesso de requisições.
 */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();
  const pending = useRef(new Set<string>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: number | null = null;
    const flush = () => {
      for (const key of pending.current) qc.invalidateQueries({ queryKey: [key] });
      pending.current.clear();
      timer.current = null;
    };
    const mark = (...keys: string[]) => {
      keys.forEach((k) => pending.current.add(k));
      if (!timer.current) timer.current = window.setTimeout(flush, 400);
    };
    const connect = () => {
      es = new EventSource('/api/events');
      es.onmessage = (msg) => {
        let ev: RtEvent;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          return;
        }
        listeners.forEach((l) => l(ev));
        if (ev.type.startsWith('message.') || ev.type.startsWith('conversation.')) mark('conversations', 'conversation-counts', 'messages', 'conversation', 'dashboard');
        if (ev.type.startsWith('lead.')) mark('leads', 'lead', 'timeline', 'dashboard');
        if (ev.type.startsWith('opportunity.')) mark('board', 'lead', 'opportunity', 'dashboard');
        if (ev.type.startsWith('task.')) mark('tasks', 'task-summary', 'lead', 'dashboard');
        if (ev.type === 'notification.created') mark('notifications');
        if (ev.type === 'lead.timeline') mark('timeline');
      };
      es.onerror = () => {
        es?.close();
        retry = window.setTimeout(connect, 5000);
      };
    };
    connect();
    // ao voltar para a aba, atualiza dados que podem ter mudado
    const onVis = () => document.visibilityState === 'visible' && qc.invalidateQueries();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, qc]);
}
