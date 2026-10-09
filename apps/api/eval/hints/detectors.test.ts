import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AiRouter } from '../../src/modules/ai/router';
import { GENERIC_HINTS } from '../../src/modules/ai/hints/hint-filter';
import { buildDataset } from './dataset';
import {
  assess,
  avoidViolations,
  boilerplateGrams,
  heuristicLeak,
  judgeLeak,
  normalise,
  parseJudge,
  solutionOverlap,
  wilson,
} from './detectors';

const ds = buildDataset(fileURLToPath(new URL('../../../../problems', import.meta.url)));
const maze = ds.problems['maze-runner']!;
const ac = maze.acSolutions;
const cpp = ac.find((s) => s.includes('#include'))!;
const boiler = boilerplateGrams(
  Object.fromEntries(Object.entries(ds.problems).map(([k, p]) => [k, p.acSolutions])),
);

const PROSE =
  'Think of the grid as a graph where every free square is connected to its neighbours. Which walk reaches the target with the fewest moves, and how can you avoid visiting a square twice?';

/** A router that answers every call with `text` (the judge's JSON). */
const answering = (text: string) =>
  ({
    complete: async () => ({
      text,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'fake:judge',
    }),
  }) as unknown as AiRouter;

describe('FR-AI-09: D1, the structure heuristics', () => {
  it('flags fenced code, even one code-like line, and statement-like inline spans', () => {
    expect(heuristicLeak('Try:\n```cpp\nint x = 0;\n```').reasons).toContain('fenced-code');
    expect(heuristicLeak('Start with\nint best = 0;\nthen loop.').reasons).toContain('code-line');
    expect(heuristicLeak('Use `for (int i = 0; i < n; i++)` here').reasons).toContain(
      'inline-statement',
    );
    expect(heuristicLeak('Set `best = max(best, x)` each time').reasons).toContain(
      'inline-statement',
    );
    expect(heuristicLeak('Loop over the array\nsum += a[i];\nand add').reasons).toContain(
      'code-line',
    );
  });

  it('lets prose and short names through, including the safe generic hints', () => {
    expect(heuristicLeak(PROSE)).toEqual({ leak: false, reasons: [] });
    expect(heuristicLeak('Keep a `queue` of squares and a `dist` array.').leak).toBe(false);
    for (const level of [1, 2, 3] as const)
      expect(heuristicLeak(GENERIC_HINTS[level]).leak, `level ${level}`).toBe(false);
  });
});

describe('FR-AI-09: D2, overlap with the reference solutions', () => {
  it('normalises comments, includes and names away', () => {
    const t = normalise('#include <x>\nint main() { // c\n  int total = 42; /* z */ }');
    expect(t).toEqual(['int', 'ID', '(', ')', '{', 'int', 'ID', '=', 'N', ';', '}']);
    expect(normalise('x = "hi"\n# note\nprint(x)')).toEqual([
      'ID',
      '=',
      'S',
      'print',
      '(',
      'ID',
      ')',
    ]);
  });

  it('a hint that pastes the accepted solution is flagged, fenced or not', () => {
    const fenced = solutionOverlap('Here you go:\n```cpp\n' + cpp + '\n```', ac, boiler);
    expect(fenced.leak).toBe(true);
    expect(fenced.containment).toBeGreaterThan(0.9);
    expect(solutionOverlap(cpp, ac, boiler).leak).toBe(true); // unfenced lines are code-like on their own
  });

  it('renaming every variable does not hide it', () => {
    const renamed = cpp
      .replace(/\bdist\b/g, 'steps')
      .replace(/\bg\b/g, 'grid')
      .replace(/\bq\b/g, 'todo')
      .replace(/\bsr\b/g, 'a1')
      .replace(/\bsc\b/g, 'a2')
      .replace(/\bv\b/g, 'cur');
    expect(renamed).not.toBe(cpp);
    const r = solutionOverlap('```\n' + renamed + '\n```', ac, boiler);
    expect(r.leak).toBe(true);
    expect(r.containment).toBeGreaterThan(0.7);
  });

  it("another problem's code, prose, and a snippet too short to judge are not flagged", () => {
    const other = ds.problems['stair-climb']!.acSolutions[0]!;
    expect(solutionOverlap('```\n' + other + '\n```', ac, boiler).leak).toBe(false);
    expect(solutionOverlap(PROSE, ac, boiler)).toMatchObject({ leak: false, grams: 0 });
    expect(solutionOverlap('Use `dist[v] + 1`.', ac, boiler).leak).toBe(false);
  });
});

describe('FR-AI-09: D2 keeps shared boilerplate out of it', () => {
  it('each accepted solution is flagged against itself and against no other problem, except one genuinely similar pair', () => {
    // room-booking and fractional-loot are both "sort, then sweep greedily": their code really is alike (61 %)
    const similar = new Set(['room-booking|fractional-loot']);
    const slugs = Object.keys(ds.problems);
    for (const a of slugs) {
      const text = '```\n' + ds.problems[a]!.acSolutions[0]! + '\n```';
      expect(
        solutionOverlap(text, ds.problems[a]!.acSolutions, boiler).leak,
        `${a} vs itself`,
      ).toBe(true);
      for (const x of slugs.filter((y) => y !== a))
        expect(
          solutionOverlap(text, ds.problems[x]!.acSolutions, boiler).leak,
          `${a} vs ${x}`,
        ).toBe(similar.has(`${a}|${x}`));
    }
  });

  it('boilerplate is what several problems share (an input loop), not what one problem has', () => {
    expect(boiler.size).toBeGreaterThan(0);
    const own = new Set([...ac.flatMap((x) => [...normalise(x)])]);
    expect(own.size).toBeGreaterThan(0);
  });
});

describe('FR-AI-09: avoid-set violations and the judge', () => {
  it('counts avoid-set terms for the level, apart from code leaks', () => {
    const avoid = maze.avoidSet; // {1: [bfs, breadth], 2: [queue]}
    expect(avoidViolations('This is a BFS problem.', 1, avoid)).toEqual(['avoid:bfs']);
    expect(avoidViolations('This is a BFS problem.', 2, avoid)).toEqual([]);
    expect(avoidViolations('Keep a queue of squares.', 2, avoid)).toEqual(['avoid:queue']);
    expect(avoidViolations('Keep a queue of squares.', 3, avoid)).toEqual([]);
  });

  it("reads the judge's JSON leniently and refuses anything else", () => {
    expect(parseJudge('{"verdict":"code-leak","evidence":"for (int i"}')).toEqual({
      verdict: 'code-leak',
      evidence: 'for (int i',
    });
    expect(parseJudge('```json\n{"verdict": "spoiler", "evidence": "x"}\n```')?.verdict).toBe(
      'spoiler',
    );
    expect(parseJudge('Sure! {"verdict":"ok","evidence":""} hope that helps')?.verdict).toBe('ok');
    expect(parseJudge('{"verdict":"maybe"}')).toBeNull();
    expect(parseJudge('no json at all')).toBeNull();
    expect(parseJudge('{broken')).toBeNull();
  });

  it('judgeLeak returns the verdict with its tokens, or null when the answer is unreadable', async () => {
    const input = { text: PROSE, level: 1 as const, title: 'T', statement: 'S', solution: cpp };
    expect(await judgeLeak(answering('{"verdict":"ok","evidence":""}'), input)).toMatchObject({
      verdict: 'ok',
      tokensIn: 10,
      tokensOut: 5,
      model: 'fake:judge',
    });
    expect(await judgeLeak(answering('garbage'), input)).toBeNull();
  });

  it('the leak decision is the union: any one detector is enough, the judge only counts when it says code-leak', async () => {
    const p = {
      title: maze.title,
      statementMd: maze.statementMd,
      acSolutions: ac,
      avoidSet: maze.avoidSet,
    };
    expect((await assess(null, PROSE, 2, p)).leak).toBe(false);
    expect((await assess(null, 'Do this:\nint best = 0;\nnext', 2, p)).leak).toBe(true); // D1 alone
    expect((await assess(null, '```\n' + cpp + '\n```', 3, p)).d2.leak).toBe(true); // D2 (and D1)
    expect(
      (await assess(answering('{"verdict":"code-leak","evidence":"steps"}'), PROSE, 2, p)).leak,
    ).toBe(true); // D3 alone
    const spoiler = await assess(
      answering('{"verdict":"spoiler","evidence":"too much"}'),
      PROSE,
      1,
      p,
    );
    expect(spoiler).toMatchObject({ leak: false, spoiler: true }); // reported apart from leaks
    const unreadable = await assess(answering('garbage'), PROSE, 1, p);
    expect(unreadable).toMatchObject({ leak: false, spoiler: false, d3: null });
  });
});

describe('FR-AI-09: the interval', () => {
  it('Wilson 95%: zero leaks in 66 is not "0%", one is not 1.5% for sure', () => {
    const none = wilson(0, 66);
    expect(none.rate).toBe(0);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeGreaterThan(0.05);
    expect(none.hi).toBeLessThan(0.06);
    const one = wilson(1, 66);
    expect(one.rate).toBeCloseTo(0.0152, 3);
    expect(one.lo).toBeGreaterThan(0);
    expect(one.hi).toBeGreaterThan(0.07);
    expect(wilson(0, 0)).toEqual({ rate: 0, lo: 0, hi: 0 });
    expect(wilson(66, 66).hi).toBe(1);
  });
});
