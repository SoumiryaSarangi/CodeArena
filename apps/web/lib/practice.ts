/** Practice-list filters and how they live in the URL (UI_UX S04, FR-PROB-08). */
export type Status = 'solved' | 'attempted' | 'new';
export const STATUSES: Status[] = ['solved', 'attempted', 'new'];

export interface Filters {
  q: string;
  tags: string[];
  minDiff?: number;
  maxDiff?: number;
  status?: Status;
}

export const DIFFICULTIES = Array.from({ length: 28 }, (_, i) => 800 + i * 100);

const int = (v: string | null) => {
  if (v === null || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 800 && n <= 3500 && n % 100 === 0 ? n : undefined;
};

/** Reads the filters from a query string; anything invalid is ignored, never trusted. */
export function parseFilters(sp: { get(k: string): string | null }): Filters {
  const status = sp.get('status');
  return {
    q: (sp.get('q') ?? '').slice(0, 100),
    tags: (sp.get('tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10),
    minDiff: int(sp.get('minDiff')),
    maxDiff: int(sp.get('maxDiff')),
    status: STATUSES.find((s) => s === status),
  };
}

/** Canonical query string: empty filters are left out, so the same filters give the same URL. */
export function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.minDiff !== undefined) p.set('minDiff', String(f.minDiff));
  if (f.maxDiff !== undefined) p.set('maxDiff', String(f.maxDiff));
  if (f.status) p.set('status', f.status);
  return p.toString();
}

export const hasFilters = (f: Filters) => toQuery(f) !== '';

export const rangeInvalid = (f: Filters) =>
  f.minDiff !== undefined && f.maxDiff !== undefined && f.minDiff > f.maxDiff;

/** A word next to the number, so difficulty never relies on the number alone. */
export function difficultyLabel(rating: number): string {
  if (rating <= 1000) return 'Easy';
  if (rating <= 1400) return 'Medium';
  if (rating <= 1800) return 'Hard';
  return 'Expert';
}

export const STATUS_META: Record<Status | 'guest', { glyph: string; label: string }> = {
  solved: { glyph: '✓', label: 'Solved' },
  attempted: { glyph: '•', label: 'Attempted, not solved yet' },
  new: { glyph: '—', label: 'Not attempted' },
  guest: { glyph: '—', label: 'Sign in to track your progress' },
};
