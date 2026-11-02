import { createHash } from 'node:crypto';

export type Row = Record<string, unknown>;
export const BTC = 'binance|futures|BTC|USDT|USDT';
export const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
export const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
export function timestamp(value: unknown): string | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 8.64e15 ? new Date(n).toISOString() : null;
}
export const fresh = (value: unknown, now = Date.now(), maxAge = 30_000): boolean =>
  timestamp(value) !== null && now >= Number(value) && now - Number(value) <= maxAge;
export const publicId = (kind: string, value: unknown): string =>
  `${kind}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;

type Decimal = { n: bigint; s: number };
function parse(value: string): Decimal {
  if (!/^-?\d+(\.\d+)?$/.test(value) || value.length > 256) throw new Error('INVALID_DECIMAL');
  const [whole = '0', fraction = ''] = value.split('.');
  return { n: BigInt(whole + fraction), s: fraction.length };
}
function format({ n, s }: Decimal): string {
  const sign = n < 0n ? '-' : '';
  const digits = (n < 0n ? -n : n).toString().padStart(s + 1, '0');
  const result = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}` : digits;
  return sign + (result.includes('.') ? result.replace(/0+$/, '').replace(/\.$/, '') : result);
}
export const money = (value: unknown): string | null => {
  try { return typeof value === 'string' ? format(parse(value)) : null; } catch { return null; }
};
export const nonzero = (value: unknown): boolean => { const d = money(value); return d !== null && parse(d).n !== 0n; };
export const abs = (value: string): string => value.replace(/^-/, '');
export function add(a: string, b: string): string {
  const x = parse(a), y = parse(b), s = Math.max(x.s, y.s);
  return format({ n: x.n * 10n ** BigInt(s - x.s) + y.n * 10n ** BigInt(s - y.s), s });
}
export function multiply(a: string, b: string): string {
  const x = parse(a), y = parse(b); return format({ n: x.n * y.n, s: x.s + y.s });
}
export function divide(a: string, b: string): string {
  const x = parse(a), y = parse(b);
  if (y.n === 0n) throw new Error('ZERO_DENOMINATOR');
  return format({ n: x.n * 10n ** BigInt(y.s + 18) / (y.n * 10n ** BigInt(x.s)), s: 18 });
}
export function priceAt(reference: string, fraction: string, tick: string, ceil = false): string {
  const x = parse(multiply(reference, fraction)), t = parse(tick);
  if (x.n <= 0n || t.n <= 0n) throw new Error('INVALID_PRICE');
  const a = x.n * 10n ** BigInt(t.s), b = t.n * 10n ** BigInt(x.s);
  return format({ n: ((a + (ceil ? b - 1n : 0n)) / b) * t.n, s: t.s });
}

/** Valid integer grid avoids the kernel's f64-to-plan decimal tail before tick rounding. */
export function integerPriceTick(tick: string): string {
  const t = parse(tick);
  if (t.n <= 0n) throw new Error('INVALID_TICK');
  let a = t.n, b = 10n ** BigInt(t.s);
  while (b !== 0n) [a, b] = [b, a % b];
  return (t.n / a).toString();
}

/** Public text never forwards raw transport errors, account identifiers or URLs. */
export function safeReason(value: unknown, hidden: readonly string[] = []): string {
  let output = String(value ?? 'UNKNOWN');
  for (const secret of hidden.filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join('[private]');
  return output.replace(/https?:\/\/[^\s]+/g, '[endpoint]')
    .replace(/(?:\/[\w.-]+){2,}/g, '[path]')
    .replace(/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '[address]').slice(0, 800);
}

export class ScenarioFailure extends Error {
  constructor(readonly code: string, message = code, readonly outcome: 'FAIL' | 'UNKNOWN' = 'FAIL') { super(message); }
}
