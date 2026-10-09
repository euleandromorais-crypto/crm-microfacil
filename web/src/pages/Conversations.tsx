import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { StatusBadge, TagPicker, TaskFormModal, UserSelect } from '../components/forms';
import { Avatar, Badge, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useDebounced, usePersistentState, useToast } from '../components/ui';
import { fmtDate, fmtPhone, fmtShort, fmtTime, isoToLocal, localDate, money, relative, STATUS_LABELS } from '../format';
import { usePipelines, useQuickReplies, useTags } from '../hooks';
import { onRealtime } from '../realtime';

const FILTERS: [string, string][] = [['mine', 'Minhas'], ['open', 'Abertas'], ['awaiting', 'Sem resposta'], ['unassigned', 'Não atribuídas'], ['pending', 'Pendentes'], ['closed', 'Encerradas'], ['all', 'Todas']];

export default function Conversations() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const activeId = id ? Number(id) : null;
  const { isManager } = useAuth();
  const [st, setSt] = usePersistentState('conv-ui', { filter: isManager ? 'open' : 'mine', side: true });
  useEffect(() => {
    const f = sp.get('f');
    if (f) setSt((s) => ({ ...s, filter: f }));
  }, [sp]); // eslint-disable-line
  return (
    <div className={`chat-app ${activeId ? 'has-active' : ''} ${st.side ? '' : 'no-side'}`}>
      <ConversationList filter={st.filter} setFilter={(f) => setSt({ ...st, filter: f })} activeId={activeId} />
      {activeId ? <ChatPane key={activeId} id={activeId} side={st.side} toggleSide={() => setSt({ ...st, side: !st.side })} /> : (
        <div className="chat-main" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Empty icon="💬" text="Selecione uma conversa para começar o atendimento." />
        </div>
      )}
    </div>
  );
}

function ConversationList({ filter, setFilter, activeId }: { filter: string; setFilter: (f: string) => void; activeId: number | null }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const { data: counts } = useQuery({ queryKey: ['conversation-counts'], queryFn: () => api.get('/api/conversations/counts') });
  const list = useInfiniteQuery({
    queryKey: ['conversations', filter, dq],
    queryFn: ({ pageParam }) => api.get('/api/conversations', { filter, q: dq, before: pageParam || undefined }),
    initialPageParam: '',
    getNextPageParam: (last: any) => (last.hasMore ? last.rows[last.rows.length - 1].last_message_at : undefined),
  });
  const rows = list.data?.pages.flatMap((p: any) => p.rows) ?? [];
  const countFor: Record<string, number | undefined> = { mine: counts?.mine, open: counts?.open, awaiting: counts?.awaiting, unassigned: counts?.unassigned, pending: counts?.pending };
  return (
    <div className="chat-list">
      <div className="chat-list-head">
        <input className="input" placeholder="Buscar por nome, telefone ou mensagem" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chat-filters">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {label}{countFor[k] ? <span className="c">{countFor[k]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="chat-items" onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
      }}>
        {list.isLoading && <Loading />}
        {list.error && <ErrorBox error={list.error} retry={list.refetch} />}
        {!list.isLoading && !rows.length && <Empty icon="📭" text="Nenhuma conversa neste filtro." />}
        {rows.map((c: any) => {
          const name = c.lead_name ?? c.contact_name ?? fmtPhone(c.contact_wa_id);
          return (
            <div key={c.id} className={`chat-item ${c.id === activeId ? 'active' : ''}`} onClick={() => nav(`/conversas/${c.id}`)}>
              <Avatar name={name} />
              <div style={{ minWidth: 0 }}>
                <div className="name ellipsis">{name}</div>
                <div className="preview ellipsis">{c.last_message_preview ?? '—'}</div>
                <div className="row" style={{ gap: 4, marginTop: 2 }}>
                  {c.awaiting_reply && c.status !== 'closed' && <Badge color="amber">aguardando {relative(c.awaiting_since).replace('há ', '')}</Badge>}
                  {!c.assignee_id && c.status !== 'closed' && <Badge color="red">sem responsável</Badge>}
                  {c.status === 'closed' && <Badge>encerrada</Badge>}
                  {c.status === 'pending' && <Badge color="violet">pendente</Badge>}
                  {c.assignee_name && <span className="small muted ellipsis">{c.assignee_name}</span>}
                </div>
              </div>
              <div className="when">
                {c.last_message_at ? (isoToLocal(c.last_message_at).date === localDate() ? fmtTime(c.last_message_at) : fmtDate(c.last_message_at)) : ''}
                {c.unread_count > 0 && <div><span className="unread">{c.unread_count}</span></div>}
              </div>
            </div>
          );
        })}
        {list.isFetchingNextPage && <Loading />}
      </div>
    </div>
  );
}

function Ticks({ status }: { status: string }) {
  if (status === 'queued') return <span title="Enviando">🕓</span>;
  if (status === 'sent') return <span className="ticks" title="Enviada">✓</span>;
  if (status === 'delivered') return <span className="ticks" title="Entregue">✓✓</span>;
  if (status === 'read' || status === 'played') return <span className="ticks read" title="Lida">✓✓</span>;
  if (status === 'failed') return <span title="Falha no envio">⚠️</span>;
  return null;
}

function MessageBubble({ m, onResend }: { m: any; onResend: (id: number) => void }) {
  if (m.type === 'system') return <div className="msg system">{m.body} · {fmtShort(m.sent_at)}</div>;
  const cls = m.direction === 'note' ? 'note' : m.direction;
  const media = `/api/messages/${m.id}/media`;
  let content: ReactNode = null;
  if (m.has_media) {
    if (m.type === 'image' || m.type === 'sticker') content = <a href={media} target="_blank" rel="noreferrer"><img src={media} alt={m.media_filename ?? 'imagem'} loading="lazy" /></a>;
    else if (m.type === 'audio') content = <audio controls preload="none" src={media} />;
    else if (m.type === 'video') content = <video controls preload="metadata" src={media} />;
    else content = <a href={`${media}?download=1`}>📄 {m.media_filename ?? 'documento'}</a>;
  } else if (['image', 'audio', 'video', 'document', 'sticker'].includes(m.type)) {
    content = <span className="muted small">{m.media_status === 'pending' ? '⏳ Baixando mídia...' : m.media_status === 'unavailable' ? '📎 Mídia do histórico (não disponível)' : '⚠️ Mídia indisponível'}</span>;
  }
  return (
    <div className={`msg ${cls} ${m.status === 'failed' ? 'failed' : ''}`}>
      {m.direction === 'note' && <div className="sender">📝 Nota interna · {m.sender_name}</div>}
      {m.direction === 'out' && (m.sender_name || m.origin !== 'crm') && <div className="sender">{m.origin === 'phone_app' ? '📱 Enviada pelo celular' : m.origin === 'automation' ? '⚙️ Automação' : m.origin === 'history' ? '🗂️ Histórico' : m.sender_name}</div>}
      {m.type === 'template' && <div className="small muted">📋 Modelo: {m.template_name}</div>}
      {content}
      {m.body && (m.type !== 'document' || !m.has_media || m.body !== m.media_filename) && <div>{m.body}</div>}
      {m.type === 'reaction' && <div className="small muted">reagiu a uma mensagem</div>}
      <div className="meta">
        {fmtTime(m.sent_at)}
        {m.direction === 'out' && <Ticks status={m.status} />}
      </div>
      {m.status === 'failed' && (
        <div className="small" style={{ color: 'var(--danger)' }}>
          {m.error?.message ?? (Array.isArray(m.error) ? m.error[0]?.title : 'Falha no envio')}
          {m.type !== 'template' && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => onResend(m.id)}>Reenviar</button>}
        </div>
      )}
      {m.status === 'queued' && m.error?.retrying && <div className="small muted">Instabilidade na Meta — nova tentativa automática</div>}
    </div>
  );
}

function ChatPane({ id, side, toggleSide }: { id: number; side: boolean; toggleSide: () => void }) {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: conv, error, refetch } = useQuery({ queryKey: ['conversation', id], queryFn: () => api.get(`/api/conversations/${id}`) });
  const msgs = useInfiniteQuery({
    queryKey: ['messages', id],
    queryFn: ({ pageParam }) => api.get(`/api/conversations/${id}/messages`, { before_id: pageParam || undefined }),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.hasMore ? last.rows[0]?.id : undefined),
  });
  const list = useMemo(() => {
    const pages = msgs.data?.pages ?? [];
    const all = [...pages].reverse().flatMap((p: any) => p.rows);
    const seen = new Set<number>();
    return all.filter((m) => !seen.has(m.id) && seen.add(m.id));
  }, [msgs.data]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const [modal, setModal] = useState<ReactNode>(null);
  const [sideOpen, setSideOpen] = useState(false);

  // marcar como lida ao abrir e ao chegar mensagem nova
  useEffect(() => {
    if (conv?.unread_count > 0) api.post(`/api/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['conversation-counts'] }));
  }, [conv?.unread_count, id, qc]);
  useEffect(() => onRealtime((e) => {
    if (e.conversationId === id && e.type === 'message.created') stick.current = isNearBottom();
  }), [id]);
  const isNearBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 50) el.scrollTop = el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
  }, [list.length]);
  const onScroll = () => {
    const el = scroller.current!;
    stick.current = isNearBottom();
    if (el.scrollTop < 80 && msgs.hasNextPage && !msgs.isFetchingNextPage) {
      prevHeight.current = el.scrollHeight;
      msgs.fetchNextPage();
    }
  };
  const resend = async (mid: number) => {
    try {
      await api.post(`/api/messages/${mid}/resend`);
      qc.invalidateQueries({ queryKey: ['messages', id] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const doAction = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn();
      toast(msg);
      refetch();
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation-counts'] });
      qc.invalidateQueries({ queryKey: ['messages', id] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  if (error) return <div className="chat-main"><ErrorBox error={error} retry={refetch} /></div>;
  if (!conv) return <div className="chat-main"><Loading /></div>;
  const name = conv.lead_name ?? conv.contact_name ?? fmtPhone(conv.contact_wa_id);
  let lastDay = '';
  return (
    <>
      <div className="chat-main">
        <div className="chat-head">
          <button className="btn ghost icon" onClick={() => nav('/conversas')} aria-label="Voltar" style={{ display: window.innerWidth < 760 ? undefined : 'none' }}>‹</button>
          <Avatar name={name} size={36} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="cell-main ellipsis">{conv.lead_id ? <Link to={`/leads/${conv.lead_id}`}>{name}</Link> : name}</div>
            <div className="cell-sub">{fmtPhone(conv.contact_wa_id)} · {conv.account_name}{conv.lead_status && <> · {STATUS_LABELS[conv.lead_status]}</>}</div>
          </div>
          <div className="btn-row">
            {(isManager || !conv.assignee_id || conv.assignee_id === user!.id) && (
              <button className="btn sm" onClick={() => setModal(<TransferModal conv={conv} onClose={() => setModal(null)} onDone={() => doAction(async () => {}, 'Atendimento transferido')} />)}>
                {conv.assignee_name ? `👤 ${conv.assignee_name}` : 'Atribuir'}
              </button>
            )}
            {!conv.assignee_id && <button className="btn sm primary" onClick={() => doAction(() => api.post(`/api/conversations/${id}/assign`, { assignee_id: user!.id, transfer_lead: true }), 'Conversa assumida')}>Assumir</button>}
            {conv.status === 'open' && <button className="btn sm" title="Marcar como pendente (aguardando algo)" onClick={() => doAction(() => api.post(`/api/conversations/${id}/status`, { status: 'pending' }), 'Marcada como pendente')}>⏸ Pendente</button>}
            {conv.status === 'pending' && <button className="btn sm" onClick={() => doAction(() => api.post(`/api/conversations/${id}/status`, { status: 'open' }), 'Reaberta')}>▶ Abrir</button>}
            {conv.status !== 'closed' ? (
              <button className="btn sm" onClick={async () => (await confirm({ title: 'Encerrar atendimento?', text: 'A conversa sai da fila. Se o cliente escrever novamente, ela é reaberta automaticamente.', confirm: 'Encerrar' })) && doAction(() => api.post(`/api/conversations/${id}/close`), 'Atendimento encerrado')}>✔ Encerrar</button>
            ) : (
              <button className="btn sm" onClick={() => doAction(() => api.post(`/api/conversations/${id}/reopen`), 'Atendimento reaberto')}>↺ Reabrir</button>
            )}
            <button className="btn sm" onClick={() => (window.innerWidth < 1280 ? setSideOpen(true) : toggleSide())}>ℹ️</button>
          </div>
        </div>
        <div className="chat-msgs" ref={scroller} onScroll={onScroll}>
          {msgs.isFetchingNextPage && <Loading text="Carregando mensagens anteriores..." />}
          {!msgs.hasNextPage && list.length > 0 && <div className="day-sep">Início da conversa</div>}
          {msgs.isLoading && <Loading />}
          {list.map((m: any) => {
            const day = isoToLocal(m.sent_at).date;
            const sep = day !== lastDay ? <div className="day-sep">{day === localDate() ? 'Hoje' : fmtDate(m.sent_at)}</div> : null;
            lastDay = day;
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {sep}
                <MessageBubble m={m} onResend={resend} />
              </div>
            );
          })}
        </div>
        <Composer conv={conv} onSent={() => { stick.current = true; qc.invalidateQueries({ queryKey: ['messages', id] }); refetch(); }} openTemplates={() => setModal(<TemplateModal conv={conv} onClose={() => setModal(null)} onSent={() => { stick.current = true; qc.invalidateQueries({ queryKey: ['messages', id] }); refetch(); }} />)} />
      </div>
      {(side || sideOpen) && <SidePanel conv={conv} force={sideOpen} onClose={() => setSideOpen(false)} />}
      {modal}
    </>
  );
}

function Composer({ conv, onSent, openTemplates }: { conv: any; onSent: () => void; openTemplates: () => void }) {
  const toast = useToast();
  const { data: replies } = useQuickReplies();
  const [text, setText] = useState(() => sessionStorage.getItem(`draft:${conv.id}`) ?? '');
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hl, setHl] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(`draft:${conv.id}`, text);
    } catch {
      /* indisponível */
    }
  }, [text, conv.id]);
  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
    }
  }, [text]);
  const slash = text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null;
  const matches = slash !== null ? (replies ?? []).filter((r) => r.shortcut.toLowerCase().includes(slash) || r.title.toLowerCase().includes(slash)).slice(0, 8) : [];
  const fill = (body: string) => {
    const first = (conv.lead_name ?? conv.contact_name ?? '').split(' ')[0];
    setText(body.replace(/\{\{\s*nome\s*\}\}/gi, first));
    taRef.current?.focus();
  };
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      if (note) await api.post(`/api/conversations/${conv.id}/notes`, { text: body });
      else await api.post(`/api/conversations/${conv.id}/messages`, { text: body });
      setText('');
      onSent();
    } catch (err: any) {
      toast(err.message, 'error');
      if (err.details?.code === 'window_closed') openTemplates();
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(matches.length - 1, h + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); fill(matches[hl].body); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };
  const upload = async (file: File) => {
    const caption = text.trim();
    const fd = new FormData();
    if (caption) fd.append('caption', caption);
    fd.append('file', file);
    setBusy(true);
    try {
      await api.upload(`/api/conversations/${conv.id}/media`, fd);
      setText('');
      onSent();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const windowClosed = !conv.window_open;
  return (
    <>
      {windowClosed && !note && (
        <div className="window-banner row">
          <span className="spacer">⏱ Janela de 24h fechada{conv.last_inbound_at ? ` (última mensagem do cliente ${relative(conv.last_inbound_at)})` : ' (cliente ainda não enviou mensagem)'}. Pelas regras do WhatsApp, só é possível enviar um <b>modelo aprovado</b>.</span>
          <button className="btn sm primary" onClick={openTemplates}>Enviar modelo</button>
        </div>
      )}
      {!windowClosed && conv.window_expires_at && <div className="small muted" style={{ padding: '2px 14px', background: '#f0f2f5' }}>Janela de atendimento aberta até {fmtShort(conv.window_expires_at)}</div>}
      <div className={`composer ${note ? 'note-mode' : ''}`}>
        {matches.length > 0 && (
          <div className="qr-pop">
            {matches.map((r, i) => (
              <div key={r.id} className={`item ${i === hl ? 'hl' : ''}`} onMouseDown={(e) => { e.preventDefault(); fill(r.body); }}>
                <b>/{r.shortcut}</b> — {r.title} <div className="muted small ellipsis">{r.body}</div>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <button className={`btn sm ${note ? 'primary' : ''}`} title="Nota interna (não é enviada ao cliente)" onClick={() => setNote(!note)}>📝</button>
          <button className="btn sm" title="Anexar arquivo (imagem, áudio, vídeo ou documento)" disabled={note || windowClosed || busy} onClick={() => fileRef.current?.click()}>📎</button>
          <button className="btn sm" title="Modelos aprovados pela Meta" disabled={note} onClick={openTemplates}>📋</button>
          <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,audio/*,video/mp4,video/3gpp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={note ? 'Nota interna (só a equipe vê)' : windowClosed ? 'Janela fechada: use um modelo' : 'Mensagem  •  / respostas rápidas'}
            title="Enter envia · Shift+Enter quebra linha · / abre respostas rápidas"
            onChange={(e) => { setText(e.target.value); setHl(0); }}
            onKeyDown={onKey}
            disabled={!note && windowClosed}
          />
          <button className="btn primary" disabled={busy || !text.trim() || (!note && windowClosed)} onClick={send}>{busy ? '...' : note ? 'Salvar nota' : 'Enviar'}</button>
        </div>
      </div>
    </>
  );
}

function TemplateModal({ conv, onClose, onSent }: { conv: any; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const { data: templates, isLoading } = useQuery({ queryKey: ['wa-templates', conv.wa_account_id], queryFn: () => api.get('/api/wa/templates', { account_id: conv.wa_account_id }) });
  const approved = (templates ?? []).filter((t: any) => t.status === 'APPROVED');
  const [sel, setSel] = useState<any>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const body = sel?.components?.find((c: any) => c.type === 'BODY')?.text ?? '';
  const header = sel?.components?.find((c: any) => c.type === 'HEADER');
  const vars = [...new Set((body.match(/\{\{(\d+)\}\}/g) ?? []) as string[])];
  const hvars = header?.format === 'TEXT' ? [...new Set((header.text?.match(/\{\{(\d+)\}\}/g) ?? []) as string[])] : [];
  const choose = (t: any) => {
    setSel(t);
    const b = t.components?.find((c: any) => c.type === 'BODY')?.text ?? '';
    const n = new Set(b.match(/\{\{(\d+)\}\}/g) ?? []).size;
    const first = (conv.lead_name ?? conv.contact_name ?? '').split(' ')[0];
    setParams(Array.from({ length: n }, (_, i) => (i === 0 ? first : '')));
    const h = t.components?.find((c: any) => c.type === 'HEADER');
    setHeaderParams(h?.format === 'TEXT' ? Array.from({ length: new Set(h.text?.match(/\{\{(\d+)\}\}/g) ?? []).size }, () => '') : []);
  };
  const preview = body.replace(/\{\{(\d+)\}\}/g, (_m: string, n: string) => params[Number(n) - 1] || `{{${n}}}`);
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/api/conversations/${conv.id}/template`, { name: sel.name, language: sel.language, body_params: params, header_params: headerParams });
      toast('Modelo enviado');
      onSent();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const unsupportedHeader = header && header.format && header.format !== 'TEXT';
  return (
    <Modal size="lg" title="Enviar modelo aprovado (template)" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!sel || busy || params.some((p) => !p.trim()) || headerParams.some((p) => !p.trim()) || !!unsupportedHeader} onClick={send}>Enviar</button></>}>
      {isLoading && <Loading />}
      {!isLoading && !approved.length && <div className="alert warn">Nenhum modelo aprovado sincronizado para esta conta. Um administrador deve criar modelos no Gerenciador do WhatsApp (Meta) e sincronizá-los em Integrações.</div>}
      <div className="grid cols-2">
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          {approved.map((t: any) => (
            <div key={t.id} className={`card card-pad ${sel?.id === t.id ? 'selected' : ''}`} style={{ marginBottom: 6, cursor: 'pointer', borderColor: sel?.id === t.id ? 'var(--primary)' : undefined }} onClick={() => choose(t)}>
              <b>{t.name}</b> <span className="muted small">{t.language} · {t.category}</span>
              <div className="small muted ellipsis">{t.components?.find((c: any) => c.type === 'BODY')?.text}</div>
            </div>
          ))}
        </div>
        <div className="stack">
          {sel ? (
            <>
              {unsupportedHeader && <div className="alert warn">Este modelo tem cabeçalho de mídia ({header.format}); envio não suportado nesta tela.</div>}
              {hvars.map((v, i) => <Field key={v} label={`Cabeçalho ${v}`}><input className="input" value={headerParams[i] ?? ''} onChange={(e) => setHeaderParams(headerParams.map((p, j) => (j === i ? e.target.value : p)))} /></Field>)}
              {vars.map((v, i) => <Field key={v} label={`Variável ${v}`}><input className="input" value={params[i] ?? ''} onChange={(e) => setParams(params.map((p, j) => (j === i ? e.target.value : p)))} /></Field>)}
              <div className="msg out" style={{ maxWidth: '100%', alignSelf: 'stretch' }}>{preview}</div>
            </>
          ) : <div className="muted">Selecione um modelo.</div>}
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ conv, onClose, onDone }: { conv: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState<number | null>(conv.assignee_id);
  const [transferLead, setTransferLead] = useState(true);
  const [note, setNote] = useState('');
  const submit = async () => {
    try {
      await api.post(`/api/conversations/${conv.id}/assign`, { assignee_id: to, transfer_lead: transferLead, note: note || null });
      onDone();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Atribuir / transferir atendimento" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Confirmar</button></>}>
      <div className="stack">
        <Field label="Responsável"><UserSelect value={to} onChange={setTo} placeholder="— Devolver para a fila —" /></Field>
        {conv.lead_id && <label className="check"><input type="checkbox" checked={transferLead} onChange={(e) => setTransferLead(e.target.checked)} /> Transferir também a responsabilidade do lead</label>}
        <Field label="Motivo / observação (opcional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function SidePanel({ conv, force, onClose }: { conv: any; force: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: pipelines } = usePipelines();
  const { data: tags } = useTags();
  const [modal, setModal] = useState<ReactNode>(null);
  const { data: lead } = useQuery({ queryKey: ['lead', conv.lead_id], queryFn: () => api.get(`/api/leads/${conv.lead_id}`), enabled: !!conv.lead_id });
  const [convTags, setConvTags] = useState<number[]>(conv.tag_ids ?? []);
  useEffect(() => setConvTags(conv.tag_ids ?? []), [conv.tag_ids]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lead', conv.lead_id] });
    qc.invalidateQueries({ queryKey: ['conversation', conv.id] });
  };
  const moveStage = async (opp: any, stageId: number) => {
    const st = pipelines?.find((p) => p.id === opp.pipeline_id)?.stages.find((s: any) => s.id === stageId);
    if (st?.kind !== 'open') {
      const { WinModal, LoseModal } = await import('../components/forms');
      return setModal(st?.kind === 'won'
        ? <WinModal opp={opp} stageId={stageId} onClose={() => setModal(null)} onDone={refresh} />
        : <LoseModal opp={opp} stageId={stageId} onClose={() => setModal(null)} onDone={refresh} />);
    }
    try {
      await api.post(`/api/opportunities/${opp.id}/move`, { stage_id: stageId });
      toast(`Etapa: ${st.name}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const saveTags = async (ids: number[]) => {
    setConvTags(ids);
    try {
      await api.put(`/api/conversations/${conv.id}/tags`, { tag_ids: ids });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const createLead = async () => {
    try {
      await api.post(`/api/conversations/${conv.id}/lead`, { name: conv.contact_name ?? undefined });
      toast('Lead criado e vinculado');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const updateLead = async (body: any) => {
    try {
      await api.patch(`/api/leads/${conv.lead_id}`, body);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const openOpps = lead?.opportunities?.filter((o: any) => o.status === 'open') ?? [];
  return (
    <aside className={`chat-side ${force ? 'force' : ''}`}>
      {force && <button className="btn sm" onClick={onClose}>Fechar painel</button>}
      {!conv.lead_id ? (
        <div className="stack">
          <h3>Contato</h3>
          <div className="muted small">Esta conversa não está vinculada a um lead.</div>
          <button className="btn primary" onClick={createLead}>Criar lead a partir do contato</button>
        </div>
      ) : !lead ? <Loading /> : (
        <>
          <div>
            <h3>Lead</h3>
            <div className="row"><Link to={`/leads/${lead.id}`} className="cell-main">{lead.name}</Link><StatusBadge status={lead.status} /></div>
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="k">Telefone</span><span>{fmtPhone(lead.phone)}</span>
              <span className="k">E-mail</span><span className="ellipsis">{lead.email ?? '—'}</span>
              <span className="k">Curso</span><span>{lead.course_name ?? '—'}</span>
              <span className="k">Origem</span><span>{lead.source ?? '—'}</span>
              <span className="k">Campanha</span><span>{lead.campaign_name ?? '—'}</span>
              <span className="k">Responsável</span><span>{lead.owner_name ?? '—'}</span>
              <span className="k">Entrada</span><span>{fmtShort(lead.created_at)}</span>
            </div>
            <div style={{ height: 8 }} />
            <Field label="Status">
              <select className="select sm" value={lead.status} onChange={(e) => updateLead({ status: e.target.value })}>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          </div>
          <div>
            <h3>Funil</h3>
            {!openOpps.length && <div className="muted small">Sem oportunidade em aberto.</div>}
            {openOpps.map((o: any) => {
              const stages = pipelines?.find((p) => p.id === o.pipeline_id)?.stages.filter((s: any) => !s.archived) ?? [];
              return (
                <div key={o.id} className="card card-pad" style={{ padding: 10, marginBottom: 6 }}>
                  <div className="small cell-main">{o.title}</div>
                  <div className="small muted">{money(o.value)}</div>
                  <select className="select sm" style={{ marginTop: 6 }} value={o.stage_id} onChange={(e) => moveStage(o, Number(e.target.value))}>
                    {stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.kind === 'won' ? ' ✓' : s.kind === 'lost' ? ' ✕' : ''}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          <div>
            <div className="row"><h3 className="spacer">Atividades</h3><button className="btn sm" onClick={() => setModal(<TaskFormModal defaults={{ lead_id: lead.id, opportunity_id: openOpps[0]?.id, leadName: lead.name, title: `Retornar para ${lead.name}` }} onClose={() => setModal(null)} onSaved={refresh} />)}>+ Agendar</button></div>
            {lead.tasks.filter((t: any) => t.status === 'pending').slice(0, 5).map((t: any) => (
              <div key={t.id} className="small" style={{ padding: '3px 0', color: new Date(t.due_at) < new Date() ? 'var(--danger)' : undefined }}>⏳ {fmtShort(t.due_at)} — {t.title}</div>
            ))}
            {!lead.tasks.some((t: any) => t.status === 'pending') && <div className="muted small">Nenhum retorno agendado.</div>}
          </div>
          {lead.notes && <div><h3>Observações</h3><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{lead.notes}</div></div>}
        </>
      )}
      <div>
        <h3>Etiquetas da conversa</h3>
        {tags && <TagPicker value={convTags} onChange={saveTags} />}
      </div>
      {modal}
    </aside>
  );
}
