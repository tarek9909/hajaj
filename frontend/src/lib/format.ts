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

/** Start of week (Monday) as YYYY-MM-DD for a given date or today */
export function weekStart(dateIso?: string, zone?: string): string {
  const dt = dateIso ? DateTime.fromISO(dateIso, { zone: zone || 'local' }) : DateTime.now().setZone(zone || 'local');
  return (dt.isValid ? dt : DateTime.now()).startOf('week').toISODate() as string;
}

/** End of week (Sunday) as YYYY-MM-DD for a given date or today */
export function weekEnd(dateIso?: string, zone?: string): string {
  const dt = dateIso ? DateTime.fromISO(dateIso, { zone: zone || 'local' }) : DateTime.now().setZone(zone || 'local');
  return (dt.isValid ? dt : DateTime.now()).endOf('week').toISODate() as string;
}

/** Shift a week by delta weeks, returning start and end dates */
export function shiftWeekRange(startDateIso: string, deltaWeeks: number): { startDate: string; endDate: string } {
  const base = DateTime.fromISO(startDateIso);
  const dt = (base.isValid ? base : DateTime.now()).plus({ weeks: deltaWeeks });
  return {
    startDate: dt.startOf('week').toISODate() as string,
    endDate: dt.endOf('week').toISODate() as string,
  };
}

/** Format a week range with week number, e.g. "Week 41: Oct 05 – Oct 11, 2026" */
export function weekLabel(startDateIso: string, endDateIso?: string): string {
  const start = DateTime.fromISO(startDateIso);
  if (!start.isValid) return startDateIso;
  const end = endDateIso ? DateTime.fromISO(endDateIso) : start.plus({ days: 6 });
  const sameYear = start.year === end.year;
  const rangeStr = sameYear
    ? `${start.toFormat('LLL dd')} – ${end.toFormat('LLL dd, yyyy')}`
    : `${start.toFormat('LLL dd, yyyy')} – ${end.toFormat('LLL dd, yyyy')}`;
  return `Week ${start.weekNumber}: ${rangeStr}`;
}

export interface MonthOption {
  value: string; // '2026-10'
  label: string; // 'October 2026'
  startDate: string; // '2026-10-01'
  endDate: string; // '2026-10-31'
  isCurrent: boolean;
}

export function generateMonthOptions(centerMonth?: string, pastMonths = 8, futureMonths = 12): MonthOption[] {
  const current = currentMonth();
  const base = centerMonth ? DateTime.fromFormat(centerMonth, 'yyyy-MM') : DateTime.now();
  const validBase = base.isValid ? base : DateTime.now();
  const options: MonthOption[] = [];

  for (let i = -pastMonths; i <= futureMonths; i++) {
    const m = validBase.plus({ months: i });
    const monthStr = m.toFormat('yyyy-MM');
    const isCur = monthStr === current;
    options.push({
      value: monthStr,
      label: `${m.toFormat('LLLL yyyy')}${isCur ? ' (Current Month)' : ''}`,
      startDate: monthStart(monthStr),
      endDate: monthEnd(monthStr),
      isCurrent: isCur,
    });
  }
  return options;
}

export interface WeekOption {
  value: string; // '2026-10-05_2026-10-11'
  label: string; // 'Week 41: Oct 05 – Oct 11, 2026'
  weekNumber: number;
  year: number;
  startDate: string; // '2026-10-05'
  endDate: string; // '2026-10-11'
  isCurrent: boolean;
}

export function generateWeekOptions(centerDateIso?: string, pastWeeks = 10, futureWeeks = 16): WeekOption[] {
  const today = DateTime.now();
  const currentWeekStart = today.startOf('week').toISODate()!;

  const baseDt = centerDateIso ? DateTime.fromISO(centerDateIso) : today;
  const baseMonday = (baseDt.isValid ? baseDt : today).startOf('week');
  const options: WeekOption[] = [];

  for (let i = -pastWeeks; i <= futureWeeks; i++) {
    const mon = baseMonday.plus({ weeks: i });
    const sun = mon.plus({ days: 6 });
    const startStr = mon.toISODate()!;
    const endStr = sun.toISODate()!;
    const isCurrent = startStr === currentWeekStart;

    const sameYear = mon.year === sun.year;
    const dateRangeText = sameYear
      ? `${mon.toFormat('LLL dd')} – ${sun.toFormat('LLL dd, yyyy')}`
      : `${mon.toFormat('LLL dd, yyyy')} – ${sun.toFormat('LLL dd, yyyy')}`;

    options.push({
      value: `${startStr}_${endStr}`,
      label: `Week ${mon.weekNumber}: ${dateRangeText}${isCurrent ? ' (Current Week)' : ''}`,
      weekNumber: mon.weekNumber,
      year: mon.weekYear,
      startDate: startStr,
      endDate: endStr,
      isCurrent,
    });
  }
  return options;
}
