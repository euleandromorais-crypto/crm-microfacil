import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function key(): Buffer {
  const raw = config.APP_ENCRYPTION_KEY;
  // aceita base64/hex de 32 bytes; caso contrário deriva via SHA-256
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  return createHash('sha256').update(raw).digest();
}

/** AES-256-GCM. Formato: v1:<iv>:<tag>:<dados> (base64) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1') throw new Error('Formato de credencial criptografada desconhecido');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(obj: unknown) {
  return encrypt(JSON.stringify(obj));
}
export function decryptJson<T = Record<string, string>>(payload: string | null | undefined): T {
  if (!payload) return {} as T;
  return JSON.parse(decrypt(payload)) as T;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmacSha256Hex(secret: string, body: string | Buffer) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Mascara um segredo para exibição: mantém só os 4 últimos caracteres */
export function mask(secret?: string | null) {
  if (!secret) return '';
  return secret.length <= 4 ? '••••' : `••••••${secret.slice(-4)}`;
}
