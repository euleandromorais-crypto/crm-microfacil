import { config } from '../../config.js';

export class GraphError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    public subcode?: number,
    public fbtraceId?: string,
    public body?: unknown,
  ) {
    super(message);
  }
  /** erros temporários que valem nova tentativa */
  get transient() {
    return this.status === 0 || this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 341, 80007, 130429, 131000, 131016].includes(this.code ?? -1);
  }
}

export function graphUrl(path: string) {
  const base = config.META_GRAPH_URL.replace(/\/$/, '');
  if (/^https?:\/\//.test(path)) return path;
  return `${base}/${config.META_GRAPH_VERSION}/${path.replace(/^\//, '')}`;
}

interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

/** Cliente mínimo da Graph API da Meta com timeout e tratamento de erros padronizado */
export async function graph<T = any>(path: string, req: GraphRequest = {}): Promise<T> {
  const url = new URL(graphUrl(path));
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (req.token) headers.Authorization = `Bearer ${req.token}`;
  let body: BodyInit | undefined;
  if (req.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.form) body = req.form;

  let res: Response;
  try {
    res = await fetch(url, { method: req.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 20_000) });
  } catch (err) {
    throw new GraphError(`Falha de conexão com a Meta: ${(err as Error).message}`, 0);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok || data?.error) {
    const e = data?.error ?? {};
    const detail = e.error_data?.details ? ` (${e.error_data.details})` : '';
    throw new GraphError(`${e.message ?? `HTTP ${res.status}`}${detail}`, res.status, e.code, e.error_subcode, e.fbtrace_id, data);
  }
  return data as T;
}

/** Baixa um binário autenticado (ex.: mídia do WhatsApp) */
export async function graphDownload(url: string, token: string) {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new GraphError(`Falha ao baixar mídia: ${(err as Error).message}`, 0);
  }
  if (!res.ok) throw new GraphError(`Falha ao baixar mídia: HTTP ${res.status}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}
