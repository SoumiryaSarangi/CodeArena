import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDataset, EVAL_PROBLEMS, INJECTION_IDS, type EvalDataset } from './dataset';

const root = fileURLToPath(new URL('../../../../problems', import.meta.url));
const datasetPath = fileURLToPath(new URL('./dataset.json', import.meta.url));

describe('FR-AI-09: the hint eval dataset', () => {
  const ds = buildDataset(root);

  it('has at least 60 items (20 at level 1, 23 at levels 2 and 3), over 10 problems, and every id is unique', () => {
    expect(ds.items.length).toBeGreaterThanOrEqual(60);
    // level 1 needs no attempt, so it has no "nothing to go on" items
    expect(ds.items.filter((i) => i.level === 1)).toHaveLength(20);
    for (const level of [2, 3]) expect(ds.items.filter((i) => i.level === level)).toHaveLength(23);
    expect(new Set(ds.items.map((i) => i.slug)).size).toBe(10);
    expect(Object.keys(ds.problems).sort()).toEqual([...EVAL_PROBLEMS].sort());
    expect(new Set(ds.items.map((i) => i.id)).size).toBe(ds.items.length);
  });

  it('has 30 normal, 30 adversarial (all ten injection templates used) and 6 edge items', () => {
    const by = (k: string) => ds.items.filter((i) => i.kind === k);
    expect(by('normal')).toHaveLength(30);
    expect(by('adversarial')).toHaveLength(30);
    expect(by('edge')).toHaveLength(6);
    expect(new Set(by('adversarial').map((i) => i.injection))).toEqual(new Set(INJECTION_IDS));
    expect(INJECTION_IDS).toHaveLength(10);
  });

  it('adversarial attempts carry the injection inside the code; normal ones do not; edge ones have nothing to go on', () => {
    for (const i of ds.items.filter((x) => x.kind === 'adversarial')) {
      expect(i.attempt).toMatch(/^(\/\/|#) /);
      expect(i.attempt!.length).toBeGreaterThan(120); // the injection plus a real program
    }
    for (const i of ds.items.filter((x) => x.kind === 'normal')) {
      expect(i.attempt!.length).toBeGreaterThan(60);
      expect(i.expect).toBe('hint');
    }
    for (const i of ds.items.filter((x) => x.kind === 'edge')) {
      expect(i.expect).toBe('nudge');
      expect(i.level).toBeGreaterThan(1);
      expect((i.attempt ?? '').trim().length).toBeLessThan(80);
    }
  });

  it('every problem has an editorial, an avoid-set and accepted reference solutions to compare a hint with', () => {
    for (const p of Object.values(ds.problems)) {
      expect(p.editorialMd.length, p.slug).toBeGreaterThan(50);
      expect(Object.keys(p.avoidSet).length, p.slug).toBeGreaterThan(0);
      expect(p.acSolutions.length, p.slug).toBeGreaterThanOrEqual(1);
    }
  });

  it('is built only from the public problems/ folder (never problems-private)', () => {
    expect(root.endsWith('/problems')).toBe(true);
    expect(JSON.stringify(ds)).not.toContain('problems-private');
  });

  it('the committed dataset.json is what the builder makes (rebuild with `pnpm eval:hints build` after editing problems)', () => {
    const committed = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvalDataset;
    expect(committed).toEqual(ds);
  });
});
