import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { config } from '../../config.js';
import { pool, queryOne } from '../../db/pool.js';
import { PermanentError } from '../../lib/jobs.js';
import { publish } from '../../lib/realtime.js';
import { getWaAccount } from '../meta/app.js';
import { graph, graphDownload } from '../meta/graph.js';

export const MEDIA_DIR = resolve(config.STORAGE_DIR, 'media');

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/amr': '.amr', 'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

export function extensionFor(mime?: string | null, filename?: string | null) {
  const fromName = filename ? extname(filename) : '';
  if (fromName && fromName.length <= 6) return fromName.toLowerCase();
  const base = (mime ?? '').split(';')[0].trim();
  return EXT[base] ?? '.bin';
}

export async function saveMediaFile(messageId: number, data: Buffer, mime?: string | null, filename?: string | null) {
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(MEDIA_DIR, month);
  await mkdir(dir, { recursive: true });
  const rel = join(month, `${messageId}${extensionFor(mime, filename)}`);
  await writeFile(join(MEDIA_DIR, rel), data);
  return rel;
}

/** Job: baixa a mídia recebida da Meta (URLs expiram — por isso guardamos uma cópia local) */
export async function downloadMediaJob(payload: { messageId: number }) {
  const msg = await queryOne(
    `SELECT m.id, m.media_id, m.media_mime, m.media_filename, m.conversation_id, c.wa_account_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id=$1`,
    [payload.messageId],
  );
  if (!msg || !msg.media_id) return;
  const account = await getWaAccount(msg.wa_account_id);
  try {
    const info = await graph<{ url: string; mime_type: string; file_size: number }>(msg.media_id, { token: account.access_token });
    const data = await graphDownload(info.url, account.access_token);
    const rel = await saveMediaFile(msg.id, data, info.mime_type ?? msg.media_mime, msg.media_filename);
    await pool.query(`UPDATE messages SET media_path=$2, media_mime=COALESCE(media_mime,$3), media_size=$4, media_status='ready' WHERE id=$1`, [
      msg.id,
      rel,
      info.mime_type,
      data.length,
    ]);
    await publish({ type: 'message.status', id: msg.id, conversationId: msg.conversation_id, managers: true });
  } catch (err: any) {
    if (err?.status === 404 || err?.status === 400) {
      await pool.query(`UPDATE messages SET media_status='failed' WHERE id=$1`, [msg.id]);
      throw new PermanentError(`Mídia indisponível: ${err.message}`);
    }
    throw err;
  }
}
