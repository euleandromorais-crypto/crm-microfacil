import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------- Toasts ----------------
type Toast = { id: number; kind: 'info' | 'success' | 'error'; text: string };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-4), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span>{t.text}</span>
              <button onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} aria-label="Fechar">✕</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

// ---------------- Confirmação ----------------
type ConfirmOpts = { title: string; text?: ReactNode; confirm?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} footer={
          <>
            <button className="btn" onClick={() => close(false)}>Cancelar</button>
            <button className={`btn ${state.danger ? 'danger' : 'primary'}`} onClick={() => close(true)} autoFocus>{state.confirm ?? 'Confirmar'}</button>
          </>
        }>
          <div>{state.text}</div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------------- Modal / Drawer ----------------
export function Modal({ title, children, footer, onClose, size }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; size?: 'lg' | 'xl' }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 className="ellipsis">{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

// ---------------- Básicos ----------------
export const Spinner = () => <span className="spinner" aria-label="Carregando" />;
export const Loading = ({ text = 'Carregando...' }: { text?: string }) => (
  <div className="center">
    <Spinner /> {text}
  </div>
);
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="alert error row" style={{ margin: 12 }}>
      <span className="spacer">{(error as Error)?.message ?? 'Erro ao carregar dados'}</span>
      {retry && <button className="btn sm" onClick={retry}>Tentar novamente</button>}
    </div>
  );
}
export const Empty = ({ icon = '📭', text, children }: { icon?: string; text: string; children?: ReactNode }) => (
  <div className="empty">
    <div className="big">{icon}</div>
    <div>{text}</div>
    {children && <div style={{ marginTop: 12 }}>{children}</div>}
  </div>
);

export function Field({ label, error, hint, children, className }: { label?: ReactNode; error?: string | null; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Badge({ color, children }: { color?: string; children: ReactNode }) {
  return <span className={`badge ${color ?? ''}`}>{children}</span>;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} className={value === i.value ? 'active' : ''} onClick={() => onChange(i.value)}>
          {i.label}
          {i.count !== undefined && <span className="count">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (s: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <span>
        {total ? `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} de ${total.toLocaleString('pt-BR')}` : '0 registros'}
      </span>
      {onPageSize && (
        <select className="select sm" style={{ width: 'auto' }} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} por página</option>
          ))}
        </select>
      )}
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Anterior</button>
      <span>{page} / {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima ›</button>
    </div>
  );
}

export function Dropdown({ button, children, align = 'right' }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <span onClick={() => setOpen((o) => !o)}>{button(open)}</span>
      {open && (
        <div className="dropdown-menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Avatar({ name, size = 40 }: { name?: string | null; size?: number }) {
  const n = (name ?? '?').trim();
  const initials = n.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <div className="avatar" style={{ width: size, height: size, background: `hsl(${h} 45% 55%)`, fontSize: size * 0.38 }}>
      {initials}
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="copy-field">
      <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn"
        type="button"
        onClick={() => navigator.clipboard.writeText(value).then(() => toast('Copiado para a área de transferência'), () => toast('Não foi possível copiar', 'error'))}
      >
        Copiar
      </button>
    </div>
  );
}

/** Seleção múltipla simples (lista de checkboxes em dropdown) */
export function MultiSelect({ options, value, onChange, placeholder = 'Todos' }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const label = value.length === 0 ? placeholder : value.length === 1 ? options.find((o) => o.value === value[0])?.label ?? '1 selecionado' : `${value.length} selecionados`;
  return (
    <Dropdown align="left" button={() => <button type="button" className="select" style={{ textAlign: 'left', minWidth: 150 }}>{label}</button>}>
      {() => (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {value.length > 0 && (
            <button className="item" onClick={() => onChange([])}>
              <span className="muted">Limpar seleção</span>
            </button>
          )}
          {options.map((o) => (
            <label key={o.value} className="item check">
              <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

/** Estado persistido no localStorage (filtros persistentes) */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`crm:${key}`);
      return raw ? { ...(initial as any), ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`crm:${key}`, JSON.stringify(state));
    } catch {
      /* armazenamento indisponível */
    }
  }, [key, state]);
  return [state, setState];
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
