/**
 * Dates and times as people read them. The server sends ISO timestamps; the person at the scanner
 * is at the office, so their own clock and time zone are the right ones to show.
 */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const timeSecondsFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const formatTime = (iso: string | null | undefined): string =>
  iso ? timeFormat.format(new Date(iso)) : '—';

/** The exact moment, to the second: for the confirmation that attendance was recorded. */
export const formatTimeExact = (iso: string | null | undefined): string =>
  iso ? timeSecondsFormat.format(new Date(iso)) : '—';

/**
 * When something last happened, the way people say it: "Today, 09:12", "Yesterday, 18:05", or the
 * date. `null` (it never happened) reads as the `never` text.
 */
export function formatWhen(
  iso: string | null | undefined,
  now = Date.now(),
  never = 'Never',
): string {
  if (!iso) return never;
  const then = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(then)) / 86_400_000);
  if (days === 0) return `Today, ${timeFormat.format(then)}`;
  if (days === 1) return `Yesterday, ${timeFormat.format(then)}`;
  return dateTimeFormat.format(then);
}

export const formatDateTime = (iso: string | null | undefined): string =>
  iso ? dateTimeFormat.format(new Date(iso)) : '—';

/** A calendar day `YYYY-MM-DD` (no time zone shift: it is a date, not an instant). */
export function formatWorkDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return dateFormat.format(new Date(y, m - 1, d));
}

/** "2 min ago", "just now" - for the recent scans list. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(iso);
}

/** "01:05" style countdown. */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
