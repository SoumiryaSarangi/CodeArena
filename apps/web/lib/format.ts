/** Formatting rules: UI_UX §10.5. */

const pad = (n: number) => String(n).padStart(2, '0');

/** `1:52:07` style countdown/duration; hours are omitted below one hour only when `short` is set. */
export function formatDuration(totalSeconds: number, short = false): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return short && h === 0 ? `${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export const formatMs = (ms: number) => `${ms.toLocaleString('en-US')} ms`;

export function formatMemKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** One date format for submissions and runs: `10 Oct 2026, 10:00 IST` in the viewer's own zone. */
export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
