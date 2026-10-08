import { describe, expect, it } from 'vitest';
import { buildHeatmap, tierWord } from '../lib/profile';

describe('UI-05: profile helpers', () => {
  it('FR-RATE-03: a tier is a word, with fixed boundaries', () => {
    expect([1000, 1199, 1200, 1399, 1400, 1599, 1600, 1899, 1900, 2800].map(tierWord)).toEqual([
      'Newcomer',
      'Newcomer',
      'Pupil',
      'Pupil',
      'Specialist',
      'Specialist',
      'Expert',
      'Expert',
      'Master',
      'Master',
    ]);
  });

  it('FR-RATE-03: the heatmap covers every day of the range, in Monday-first weeks', () => {
    // 2026-10-05 is a Monday, 2026-10-11 a Sunday.
    const { weeks } = buildHeatmap([], '2026-10-05', '2026-10-18');
    expect(weeks).toHaveLength(2);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]![0]!.date).toBe('2026-10-05');
    expect(weeks[1]![6]!.date).toBe('2026-10-18');
    // A range that starts midway through a week is padded at the front, and at the end.
    const mid = buildHeatmap([], '2026-10-07', '2026-10-09').weeks;
    expect(mid).toHaveLength(1);
    expect(mid[0]!.map((c) => c?.date ?? null)).toEqual([
      null,
      null,
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      null,
      null,
    ]);
  });

  it('FR-RATE-03: levels are quarters of the busiest day; empty days are level 0', () => {
    const { weeks, max, busiest } = buildHeatmap(
      [
        { date: '2026-10-05', count: 1 },
        { date: '2026-10-06', count: 12 },
        { date: '2026-10-07', count: 6 },
        { date: '2026-10-08', count: 4 },
      ],
      '2026-10-05',
      '2026-10-11',
    );
    expect(max).toBe(12);
    expect(busiest).toMatchObject({ date: '2026-10-06', count: 12 });
    expect(weeks[0]!.map((c) => c!.level)).toEqual([1, 4, 2, 2, 0, 0, 0]);
  });

  it('a year with no activity has no busiest day', () => {
    const { busiest, max } = buildHeatmap([], '2026-01-01', '2026-01-31');
    expect(busiest).toBeNull();
    expect(max).toBe(0);
  });
});
