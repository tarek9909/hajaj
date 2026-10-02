import { DateTime } from 'luxon';

/** Current calendar month as YYYY-MM. */
export function currentMonth(zone?: string): string {
  return DateTime.now().setZone(zone || 'local').toFormat('yyyy-MM');
}

export function todayIso(zone?: string): string {
  return DateTime.now().setZone(zone || 'local').toISODate() as string;
}

export function shiftMonth(month: string, delta: number): string {
  return DateTime.fromFormat(month, 'yyyy-MM').plus({ months: delta }).toFormat('yyyy-MM');
}

export function monthLabel(month: string): string {
  const d = DateTime.fromFormat(month, 'yyyy-MM');
  return d.isValid ? d.toFormat('LLLL yyyy') : month;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  return DateTime.fromFormat(month, 'yyyy-MM').endOf('month').toISODate() as string;
}

export function formatMoney(value: number | string | null | undefined, currency = 'USD', decimals = 2): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return `${currency} ${safe.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatMinutes(minutes: number | string | null | undefined): string {
  const m = Math.round(Number(minutes ?? 0));
  if (!Number.isFinite(m) || m === 0) return '0m';
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const r = abs % 60;
  if (h === 0) return `${sign}${r}m`;
  return r === 0 ? `${sign}${h}h` : `${sign}${h}h ${r}m`;
}

export function initials(name: string | null | undefined): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** First day of next month, e.g. the default effective date for salary and policy changes. */
export function nextMonthStart(): string {
  return `${shiftMonth(currentMonth(), 1)}-01`;
}
