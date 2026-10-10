import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  // no Render, a URL pública vem em RENDER_EXTERNAL_URL
  APP_URL: z.string().default(process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  DATABASE_POOL_MAX: z.coerce.number().default(15),
  // 32 bytes em base64 ou hex — usado para criptografar credenciais de integrações
  APP_ENCRYPTION_KEY: z.string().min(32, 'APP_ENCRYPTION_KEY deve ter pelo menos 32 caracteres'),
  SESSION_TTL_HOURS: z.coerce.number().default(12),
  COOKIE_SECURE: bool,
  TRUST_PROXY: bool,
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(16),
  // executa a fila de jobs no mesmo processo da API (true) ou em processo separado (false)
  RUN_WORKER_IN_PROCESS: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === 'true' || v === '1'),
  LOG_LEVEL: z.string().default('info'),
  META_GRAPH_VERSION: z.string().default('v23.0'),
  META_GRAPH_URL: z.string().default('https://graph.facebook.com'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: bool,
  TZ_APP: z.string().default('America/Sao_Paulo'),
  // administrador inicial criado na primeira inicialização (útil em Docker/Render, sem terminal)
  ADMIN_NAME: z.string().optional(),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuração inválida:');
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
export const APP_TZ = config.TZ_APP;
