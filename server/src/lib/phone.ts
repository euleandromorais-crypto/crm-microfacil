/**
 * Normaliza telefones brasileiros/internacionais para o formato usado pelo WhatsApp (somente dígitos, com DDI).
 * - "(11) 99999-8888"  -> "5511999998888"
 * - "+55 11 99999-8888" -> "5511999998888"
 * - "011999998888"      -> "5511999998888"
 * Retorna null quando o valor não parece um telefone válido.
 */
export function normalizePhone(input: unknown, defaultCountry = '55'): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;
  if (!hasPlus) {
    digits = digits.replace(/^0+/, '');
    // número nacional brasileiro: DDD (2) + 8 ou 9 dígitos
    if (digits.length === 10 || digits.length === 11) digits = defaultCountry + digits;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/**
 * Variantes de um número brasileiro com e sem o nono dígito.
 * O WhatsApp pode entregar wa_id sem o 9 para números antigos; usamos as variantes na deduplicação.
 */
export function phoneVariants(phone: string | null): string[] {
  if (!phone) return [];
  const out = new Set([phone]);
  if (phone.startsWith('55')) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    if (rest.length === 9 && rest.startsWith('9')) out.add(`55${ddd}${rest.slice(1)}`);
    if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(`55${ddd}9${rest}`);
  }
  return [...out];
}

export function normalizeEmail(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const e = String(input).trim().toLowerCase();
  if (!e) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function formatPhone(phone?: string | null) {
  if (!phone) return '';
  if (phone.startsWith('55') && (phone.length === 12 || phone.length === 13)) {
    const ddd = phone.slice(2, 4);
    const n = phone.slice(4);
    return `+55 (${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return `+${phone}`;
}
