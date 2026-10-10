'use client';
import { useEffect, useState } from 'react';

/** Times are shown in IST and in the viewer's own zone (US-4.1). */
const IST = 'Asia/Kolkata';
const opts: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};
export const formatIst = (iso: string) =>
  `${new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: IST }).format(new Date(iso))} IST`;
export const formatLocal = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { ...opts, timeZoneName: 'short' }).format(new Date(iso));
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Both zones, or just IST when the viewer is in India. */
export const formatWhen = (iso: string) => {
  if (localZone() === IST || localZone() === 'Asia/Calcutta') return formatIst(iso);
  // US-4.1 asks for both zones; the second one repeats only what differs (the time, unless the day differs too).
  const d = new Date(iso);
  const day = (tz?: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(d);
  const sameDay = day(IST) === day();
  const local = sameDay
    ? new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZoneName: 'short',
      }).format(d)
    : formatLocal(iso);
  return `${formatIst(iso)} (${local})`;
};

/** `2 h`, `45 min`, `1 h 30 min`. */
export function formatSpan(fromIso: string, toIso: string) {
  const min = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** `2d 03:12:09` above a day, `01:02:03` below. */
export function formatCountdown(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  const hms = `${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

/**
 * Milliseconds to add to this device's clock to get the server's (FR-CONT-03): countdowns use the
 * server's time, so a wrong laptop clock cannot start a contest early. Re-measured whenever a
 * response with `serverNow` arrives.
 */
export function useServerClock(serverNow: string | undefined) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (serverNow) setOffset(Date.parse(serverNow) - Date.now());
  }, [serverNow]);
  return offset;
}

/** Re-renders every second with the server-adjusted time (epoch ms). */
export function useNow(offset: number) {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [offset]);
  return now;
}

/** `datetime-local` value (viewer's zone) ↔ ISO instant. */
const pad = (n: number) => String(n).padStart(2, '0');
export function toLocalInput(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => new Date(v).toISOString();

/** "Add to calendar" (S08): a prefilled event the user confirms in their own Google session. */
export function googleCalendarUrl(
  c: { title: string; startsAt: string; endsAt: string },
  url: string,
) {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: c.title,
    dates: `${stamp(c.startsAt)}/${stamp(c.endsAt)}`,
    details: url,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
