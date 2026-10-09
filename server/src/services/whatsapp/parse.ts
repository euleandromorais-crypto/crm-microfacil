/** Converte uma mensagem no formato da Cloud API para os campos persistidos no CRM */
export interface ParsedMessage {
  type: string;
  body: string | null;
  media_id: string | null;
  media_mime: string | null;
  media_filename: string | null;
  reply_to_wamid: string | null;
  preview: string;
}

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'];
const LABELS: Record<string, string> = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎬 Vídeo',
  document: '📄 Documento',
  sticker: 'Figurinha',
  location: '📍 Localização',
  contacts: '👤 Contato',
  reaction: 'Reação',
  template: 'Modelo',
  unsupported: 'Mensagem não suportada',
};

export function parseWaMessage(m: any): ParsedMessage {
  const type: string = m.type ?? 'unsupported';
  let body: string | null = null;
  let media: any = null;
  switch (type) {
    case 'text':
      body = m.text?.body ?? null;
      break;
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker':
      media = m[type];
      body = media?.caption ?? null;
      break;
    case 'location': {
      const l = m.location ?? {};
      body = [l.name, l.address, l.latitude !== undefined ? `https://maps.google.com/?q=${l.latitude},${l.longitude}` : null].filter(Boolean).join('\n');
      break;
    }
    case 'contacts':
      body = (m.contacts ?? [])
        .map((c: any) => `${c.name?.formatted_name ?? ''} ${(c.phones ?? []).map((p: any) => p.phone).join(', ')}`.trim())
        .join('\n');
      break;
    case 'interactive': {
      const i = m.interactive ?? {};
      body = i.button_reply?.title ?? i.list_reply?.title ?? i.nfm_reply?.body ?? null;
      break;
    }
    case 'button':
      body = m.button?.text ?? null;
      break;
    case 'reaction':
      body = m.reaction?.emoji ?? null;
      break;
    case 'order':
      body = 'Pedido recebido';
      break;
    case 'template':
      body = m.template?.name ? `Modelo: ${m.template.name}` : null;
      break;
    default:
      body = m.errors?.[0]?.title ?? m.errors?.[0]?.message ?? null;
  }
  const preview = (body && body.trim()) || LABELS[type] || type;
  return {
    type,
    body,
    media_id: media?.id ?? null,
    media_mime: media?.mime_type ?? null,
    media_filename: media?.filename ?? null,
    reply_to_wamid: m.context?.id ?? null,
    preview: preview.slice(0, 200),
  };
}

export const isMediaType = (t: string) => MEDIA_TYPES.includes(t);

/** Ordem de status de entrega — nunca regredimos (webhooks podem chegar fora de ordem) */
export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, played: 3, failed: 4 };
