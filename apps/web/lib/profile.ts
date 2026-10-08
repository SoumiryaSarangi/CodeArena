import type { HomeSummary, ProfileSummary, SubmissionList } from '@codearena/contracts';
import { apiFetch } from './api';

const enc = encodeURIComponent;

export const profileSummary = (handle: string, signal?: AbortSignal) =>
  apiFetch<ProfileSummary>('GET', `/users/${enc(handle)}/profile`, undefined, {
    auth: 'optional',
    signal,
  });

export const homeSummary = (signal?: AbortSignal) =>
  apiFetch<HomeSummary>('GET', '/me/home', undefined, { auth: 'required', signal });

export const recentSubmissions = (limit: number, signal?: AbortSignal) =>
  apiFetch<SubmissionList>('GET', `/submissions?limit=${limit}`, undefined, {
    auth: 'required',
    signal,
  });

/** A word for a rating, so a tier is never told by colour alone (UI_UX S12). */
export function tierWord(rating: number): string {
  if (rating < 1200) return 'Newcomer';
  if (rating < 1400) return 'Pupil';
  if (rating < 1600) return 'Specialist';
  if (rating < 1900) return 'Expert';
  return 'Master';
}

export interface HeatCell {
  date: string;
  count: number;
  /** 0 = no submissions, 1–4 = quarters of the busiest day. */
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * The year as columns of weeks (Monday first), ending on `to`. Days outside the range are left
 * out of the first and last column. Levels are quarters of the busiest day, so one very busy day
 * does not flatten the rest into one colour.
 */
export function buildHeatmap(
  days: { date: string; count: number }[],
  from: string,
  to: string,
): { weeks: (HeatCell | null)[][]; max: number; busiest: HeatCell | null } {
  const by = new Map(days.map((d) => [d.date, d.count]));
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // Monday = 0 … Sunday = 6
  const lead = (start.getUTCDay() + 6) % 7;
  const weeks: (HeatCell | null)[][] = [];
  let week: (HeatCell | null)[] = Array.from({ length: lead }, () => null);
  let busiest: HeatCell | null = null;
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const count = by.get(date) ?? 0;
    const level = (
      count === 0 ? 0 : Math.max(1, Math.ceil((4 * count) / max))
    ) as HeatCell['level'];
    const cell = { date, count, level };
    if (count > 0 && (!busiest || count > busiest.count)) busiest = cell;
    week.push(cell);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return { weeks, max, busiest };
}
