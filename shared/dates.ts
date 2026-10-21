/**
 * Calendar-date helpers. Everything works on YYYY-MM-DD strings in UTC so that
 * time zones never shift a bar by a day.
 */
import type { IsoDate } from './types.js';

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Days since the Unix epoch for a calendar date. */
export function toDayNumber(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(day: number): IsoDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** Today's date in the given time zone (defaults to the runtime's zone). */
export function todayIso(timeZone?: string): IsoDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

/** Accepts an ISO date or a full timestamp (as Jira returns for sprints) and returns the calendar date. */
export function toIsoDate(value: unknown): IsoDate | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined;
  if (isIsoDate(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export function minDate(dates: Array<IsoDate | undefined>): IsoDate | undefined {
  let out: IsoDate | undefined;
  for (const d of dates) if (d && (!out || d < out)) out = d;
  return out;
}

export function maxDate(dates: Array<IsoDate | undefined>): IsoDate | undefined {
  let out: IsoDate | undefined;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-01`;
}

/** Monday-based week start. */
export function startOfWeek(date: IsoDate): IsoDate {
  const day = toDayNumber(date);
  // 1970-01-01 was a Thursday (weekday 3 when Monday = 0).
  const weekday = (((day + 3) % 7) + 7) % 7;
  return fromDayNumber(day - weekday);
}
