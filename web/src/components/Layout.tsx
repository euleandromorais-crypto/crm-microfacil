import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtPhone, relative, ROLE_LABELS, STATUS_LABELS } from '../format';
import { onRealtime, useRealtime } from '../realtime';
import { Dropdown, useDebounced, useToast } from './ui';

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const dq = useDebounced(q, 250);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useQuery({ queryKey: ['search', dq], queryFn: () => api.get('/api/search', { q: dq }), enabled: dq.trim().length >= 2 });
  const items: { to: string; label: ReactNode; group: string }[] = [];
  data?.leads?.forEach((l: any) => items.push({ group: 'Leads', to: `/leads/${l.id}`, label: <><b>{l.name}</b> <span className="muted small">{fmtPhone(l.phone)} {l.email ?? ''} · {STATUS_LABELS[l.status]}</span></> }));
  data?.conversations?.forEach((c: any) => items.push({ group: 'Conversas', to: `/conversas/${c.id}`, label: <><b>{c.name}</b> <span className="muted small">{c.last_message_preview}</span></> }));
  data?.courses?.forEach((c: any) => items.push({ group: 'Cursos', to: `/catalogo?curso=${c.id}`, label: <><b>{c.name}</b> {c.code && <span className="muted small">{c.code}</span>}</> }));
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.querySelector('input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  const go = (to: string) => {
    setOpen(false);
    setQ('');
    nav(to);
  };
  let lastGroup = '';
  return (
    <div className="gsearch" ref={ref}>
      <span className="ico">⌕</span>
      <input
        className="input"
        placeholder="Buscar lead, telefone, e-mail, conversa ou curso (Ctrl+K)"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHl(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(items.length - 1, h + 1));
          else if (e.key === 'ArrowUp') setHl((h) => Math.max(0, h - 1));
          else if (e.key === 'Enter' && items[hl]) go(items[hl].to);
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && dq.trim().length >= 2 && (
        <div className="results">
          {isFetching && !data && <div className="muted small" style={{ padding: 8 }}>Buscando...</div>}
          {data && !items.length && <div className="muted small" style={{ padding: 8 }}>Nenhum resultado para “{dq}”.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.to + i}>
                {head}
                <a href={it.to} className={i === hl ? 'hl' : ''} onClick={(e) => { e.preventDefault(); go(it.to); }}>{it.label}</a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/api/notifications'), refetchInterval: 120_000 });
  useEffect(
    () =>
      onRealtime((e) => {
        if (e.type === 'notification.created') {
          api.get('/api/notifications', { unread: true }).then((r) => {
            const n = r.rows?.[0];
            if (n) {
              toast(`🔔 ${n.title}${n.body ? ` — ${n.body}` : ''}`, 'info');
              if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
                new Notification(n.title, { body: n.body ?? '' });
              }
            }
          });
        }
      }),
    [toast],
  );
  const markAll = async () => {
    await api.post('/api/notifications/read');
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <Dropdown
      button={() => (
        <button className="btn ghost icon notif-btn" aria-label="Notificações" onClick={() => 'Notification' in window && Notification.permission === 'default' && Notification.requestPermission()}>
          🔔{data?.unread > 0 && <span className="n">{data.unread > 99 ? '99+' : data.unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div style={{ width: 340 }}>
          <div className="row" style={{ padding: '4px 6px 8px' }}>
            <b className="spacer">Notificações</b>
            {data?.unread > 0 && <button className="btn sm ghost" onClick={markAll}>Marcar todas como lidas</button>}
          </div>
          {!data?.rows?.length && <div className="muted small" style={{ padding: 10 }}>Nenhuma notificação.</div>}
          {data?.rows?.map((n: any) => (
            <a
              key={n.id}
              className={`notif ${n.read_at ? '' : 'unread'}`}
              href={n.link ?? '#'}
              onClick={async (e) => {
                e.preventDefault();
                close();
                if (!n.read_at) await api.post('/api/notifications/read', { ids: [n.id] });
                qc.invalidateQueries({ queryKey: ['notifications'] });
                if (n.link) nav(n.link);
              }}
            >
              <div className="t">{n.title}</div>
              {n.body && <div className="b">{n.body}</div>}
              <div className="d">{relative(n.created_at)}</div>
            </a>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, isManager, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useRealtime(!!user);
  useEffect(() => setOpen(false), [loc.pathname]);
  const { data: counts } = useQuery({ queryKey: ['conversation-counts'], queryFn: () => api.get('/api/conversations/counts'), refetchInterval: 60_000 });
  const { data: tasks } = useQuery({ queryKey: ['task-summary', 'me'], queryFn: () => api.get('/api/tasks/summary', { assignee_id: user!.id }), refetchInterval: 120_000 });
  const flush = loc.pathname.startsWith('/conversas') || loc.pathname.startsWith('/funil');
  const nav = [
    { to: '/', label: 'Central', ico: '📊', end: true },
    { to: '/conversas', label: 'Conversas', ico: '💬', count: counts?.unread },
    { to: '/leads', label: 'Leads', ico: '👤' },
    { to: '/funil', label: 'Funil', ico: '🧭' },
    { to: '/agenda', label: 'Agenda', ico: '📅', count: tasks?.overdue },
    { to: '/catalogo', label: 'Catálogo', ico: '🎓' },
    { to: '/relatorios', label: 'Relatórios', ico: '📈' },
  ];
  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <span className="logo">M</span> CRM Comercial
        </div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span className="ico">{n.ico}</span>
              {n.label}
              {!!n.count && <span className="count">{n.count}</span>}
            </NavLink>
          ))}
          {isManager && (
            <>
              <div className="section">Gestão</div>
              <NavLink to="/automacoes"><span className="ico">⚙️</span>Automações</NavLink>
              <NavLink to="/integracoes"><span className="ico">🔌</span>Integrações</NavLink>
              <NavLink to="/admin"><span className="ico">🛠️</span>{isAdmin ? 'Administração' : 'Configurações'}</NavLink>
            </>
          )}
        </nav>
        <div className="me">
          <b>{user?.name}</b>
          <span className="small">{ROLE_LABELS[user!.role]}</span>
        </div>
      </aside>
      <div className={`backdrop-mobile ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setOpen(true)} aria-label="Abrir menu">☰</button>
          <GlobalSearch />
          <div className="spacer" />
          <Notifications />
          <Dropdown button={() => <button className="btn ghost">{user?.name.split(' ')[0]} ▾</button>}>
            {(close) => (
              <>
                <Link className="item" to="/perfil" onClick={close}>Meu perfil e senha</Link>
                <button className="item" onClick={() => { close(); void logout(); }}>Sair</button>
              </>
            )}
          </Dropdown>
        </header>
        <main className={`content ${flush ? 'flush' : ''}`}>{children}</main>
      </div>
    </div>
  );
}
