import nodemailer from 'nodemailer';
import { config } from '../config.js';

export const mailEnabled = () => !!(config.SMTP_HOST && config.SMTP_FROM);

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  if (!mailEnabled()) throw new Error('SMTP não configurado');
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: config.SMTP_FROM, to, subject, text, html });
}
