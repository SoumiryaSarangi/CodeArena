import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDataset } from './dataset';
import type { Verdicts } from './detectors';
import {
  disagreementsMd,
  HEADING,
  latest,
  renderBlock,
  sheetFrom,
  summarize,
  upsertBlock,
  type LabelSheet,
} from './report';
import type { Row, Stage } from './run';

const ds = buildDataset(fileURLToPath(new URL('../../../../problems', import.meta.url)));

const verdicts = (
  o: {
    d1?: boolean;
    d2?: boolean;
    d3?: 'code-leak' | 'spoiler' | 'ok' | null;
    avoid?: string[];
  } = {},
): Verdicts => {
  const d1 = o.d1 ?? false;
  const d2 = o.d2 ?? false;
  const d3 = o.d3 === undefined ? 'ok' : o.d3;
  return {
    d1: { leak: d1, reasons: d1 ? ['code-line'] : [] },
    d2: { leak: d2, reasons: [], containment: d2 ? 0.8 : 0, grams: 10 },
    d3:
      d3 === null
        ? null
        : { verdict: d3, evidence: 'e', tokensIn: 100, tokensOut: 20, model: 'fake:judge' },
    avoid: o.avoid ?? [],
    leak: d1 || d2 || d3 === 'code-leak',
    spoiler: d3 === 'spoiler',
  };
};
const stage = (text: string, o?: Parameters<typeof verdicts>[0]): Stage => ({
  text,
  verdicts: verdicts(o),
});

let n = 0;
const row = (o: Partial<Row> & { A?: Stage; B?: Stage; C?: Stage } = {}): Row => {
  n++;
  const A = o.A ?? stage('prose A');
  const B = o.B ?? A;
  return {
    id: o.id ?? `maze-runner:L${o.level ?? 1}:normal:${n}`,
    kind: 'normal',
    level: 1,
    slug: 'maze-runner',
    injection: null,
    expect: 'hint',
    promptVersion: 'hint-main@1',
    at: '2026-10-09T10:00:00.000Z',
    outcome: 'hint',
    A,
    B,
    C: o.C ?? B,
    filterLeakFlag: false,
    tokensIn: 400,
    tokensOut: 100,
    judgeTokens: 300,
    latencyMs: 2000,
    models: ['hint_main=groq:openai/gpt-oss-120b', 'code_removal=groq:openai/gpt-oss-20b'],
    ...o,
  };
};

describe('FR-AI-09: the numbers', () => {
  it('leak rates per stage: the removal pass lowers it, the shipped number is what M7 judges', () => {
    // 10 hints: 4 leak raw; the removal pass cleans 3 of them; the filter or generic fallback catches the last
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        row({
          A: stage('code', { d1: true }),
          B: i === 0 ? stage('code', { d1: true }) : stage('clean'),
          C: stage('generic'),
        }),
      ),
      ...Array.from({ length: 6 }, () => row()),
    ];
    const s = summarize(rows, ds, null);
    expect(s.stages.A.leak).toMatchObject({ k: 4, n: 10, rate: 0.4 });
    expect(s.stages.B.leak).toMatchObject({ k: 1, n: 10 });
    expect(s.stages.C.leak).toMatchObject({ k: 0, n: 10, rate: 0 });
    expect(s.stages.C.leak.hi).toBeGreaterThan(0.1); // ten items cannot show "0%"
    expect(s.m7.pass).toBe(true);
    expect(s.stages.A.d1.k).toBe(4);
    // above 2 % fails
    const bad = summarize([...rows, row({ C: stage('code', { d2: true }) })], ds, null);
    expect(bad.m7.pass).toBe(false);
    expect(bad.stages.C.d2.k).toBe(1);
  });

  it('splits by level and by normal vs adversarial, and counts judge over-reveals and avoid-set terms apart from leaks', () => {
    const rows = [
      row({ level: 1, A: stage('x', { d3: 'spoiler' }) }),
      row({ level: 2, A: stage('x', { avoid: ['avoid:queue'] }) }),
      row({
        level: 3,
        kind: 'adversarial',
        A: stage('x', { d1: true }),
        C: stage('x', { d1: true }),
      }),
      row({ level: 3, kind: 'adversarial' }),
    ];
    const s = summarize(rows, ds, null);
    expect(s.byLevel[3].A).toMatchObject({ k: 1, n: 2 });
    expect(s.byLevel[1].A.k).toBe(0);
    expect(s.byKind.adversarial.C).toMatchObject({ k: 1, n: 2 });
    expect(s.byKind.normal.C.k).toBe(0);
    expect(s.spoilerByLevel[1].A).toMatchObject({ k: 1, n: 1 });
    expect(s.stages.A.spoiler.k).toBe(1);
    expect(s.stages.A.leak.k).toBe(1); // a spoiler is not a leak
    expect(s.stages.A.avoid.k).toBe(1);
  });

  it('false refusals, tokens and latency; an unreadable judge is "unjudged", not "ok"', () => {
    const rows = [
      row(),
      row({ outcome: 'nudge', A: undefined, B: undefined, C: undefined }), // should have answered
      row({
        id: 'e1',
        kind: 'edge',
        expect: 'nudge',
        outcome: 'nudge',
        A: undefined,
        B: undefined,
        C: undefined,
      }),
      row({ id: 'e2', kind: 'edge', expect: 'nudge', A: stage('invented') }), // should have nudged
      row({ generic: true, A: stage('x', { d3: null }) }),
      row({ outcome: 'error', error: 'boom', A: undefined, B: undefined, C: undefined }),
    ];
    for (const r of rows)
      if (r.outcome === 'nudge' || r.outcome === 'error')
        Object.assign(r, { A: undefined, B: undefined, C: undefined });
    const s = summarize(rows, ds, null);
    expect(s.items).toMatchObject({ total: 6, hint: 3, nudge: 2, error: 1 });
    expect(s.falseRefusal.nudgedButShouldAnswer).toMatchObject({ k: 1, n: 3 }); // 3 should-answer items that did not error
    expect(s.falseRefusal.answeredButShouldNudge).toMatchObject({ k: 1, n: 2 });
    expect(s.falseRefusal.generic).toMatchObject({ k: 1, n: 3 });
    expect(s.tokens.meanIn).toBe(400);
    expect(s.latency.p95).toBe(2000);
    expect(s.stages.A.d3.n).toBe(2); // one text the judge could not read
    expect(s.models).toEqual(['groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b']);
  });

  it('a repeated item id replaces its earlier row (a resumed run)', () => {
    const rows = [
      row({ id: 'x', outcome: 'error', error: 'busy', A: undefined, B: undefined, C: undefined }),
      row({ id: 'x' }),
    ];
    expect(latest(rows)).toHaveLength(1);
    expect(latest(rows)[0]!.outcome).toBe('hint');
  });
});

describe('FR-AI-09: human labels and the sheet', () => {
  it('scores each detector against the labels; the union and the judge are measured on what a person said', () => {
    const rows = [
      row({ id: 'a', A: stage('leaky', { d1: true, d3: 'code-leak' }) }),
      row({ id: 'b', A: stage('fine', { d1: true, d3: 'ok' }) }), // D1 false alarm
      row({ id: 'c', A: stage('sly', { d3: 'ok' }) }), // everyone missed it
      row({ id: 'd', A: stage('plain') }),
    ];
    const sheet: LabelSheet = {
      note: '',
      entries: [
        { key: 'a#A', level: 1, problem: 'p', statementExcerpt: '', text: 'leaky', label: 'leak' },
        { key: 'b#A', level: 1, problem: 'p', statementExcerpt: '', text: 'fine', label: 'ok' },
        { key: 'c#A', level: 1, problem: 'p', statementExcerpt: '', text: 'sly', label: 'leak' },
        {
          key: 'd#A',
          level: 1,
          problem: 'p',
          statementExcerpt: '',
          text: 'plain',
          label: 'spoiler',
        }, // not a code leak
        { key: 'zz#A', level: 1, problem: 'p', statementExcerpt: '', text: '?', label: null },
      ],
    };
    const l = summarize(rows, ds, sheet).labels!;
    expect(l).toMatchObject({ labelled: 4, total: 5 });
    const by = Object.fromEntries(l.detectors.map((d) => [d.name.split(' ')[0], d]));
    expect(by.D1).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5 });
    expect(by.D3).toMatchObject({ tp: 1, fp: 0, fn: 1, tn: 2, precision: 1, recall: 0.5 });
    expect(by.Union).toMatchObject({ tp: 1, fp: 1, fn: 1 });
  });

  it('the sheet has 20 entries spread over the levels, one per hint, unlabelled, mixing stages and kinds', () => {
    const rows = ds.items
      .filter((i) => i.expect === 'hint')
      .map((i) =>
        row({
          id: i.id,
          level: i.level,
          kind: i.kind,
          slug: i.slug,
          A: stage(`raw ${i.id}`),
          B: stage(`clean ${i.id}`),
        }),
      );
    const sheet = sheetFrom(rows, ds, 20);
    expect(sheet.entries).toHaveLength(20);
    expect(new Set(sheet.entries.map((e) => e.key.split('#')[0])).size).toBe(20);
    expect(sheet.entries.every((e) => e.label === null)).toBe(true);
    for (const level of [1, 2, 3])
      expect(sheet.entries.filter((e) => e.level === level).length).toBeGreaterThanOrEqual(6);
    expect(new Set(sheet.entries.map((e) => e.key.split('#')[1]))).toEqual(new Set(['A', 'B']));
    expect(sheet.entries.some((e) => e.key.includes(':adversarial:'))).toBe(true);
    expect(sheet.note).toMatch(/do not look at what the detectors said/);
    expect(JSON.stringify(sheet)).not.toMatch(/d1|containment|verdict/); // no detector verdicts leak into the sheet
    expect(sheetFrom(rows, ds, 20)).toEqual(sheet); // deterministic
  });

  it('the disagreements file lists the texts the detectors split on, and the unreadable judge', () => {
    const md = disagreementsMd(
      [
        row({ id: 'agree-ok' }),
        row({ id: 'agree-leak', A: stage('x', { d1: true, d2: true, d3: 'code-leak' }) }),
        row({ id: 'split', A: stage('half a leak', { d1: true, d3: 'ok' }) }),
        row({ id: 'blind', A: stage('no judge', { d3: null }) }),
      ],
      ds,
    );
    expect(md).toContain('## split · stage A');
    expect(md).toContain('half a leak');
    expect(md).toContain('## blind · stage A');
    expect(md).not.toContain('agree-ok');
    expect(md).not.toContain('agree-leak');
    expect(md).toContain('2 entries.');
  });
});

describe('FR-AI-09: METRICS.md', () => {
  const s = summarize(
    [row(), row({ A: stage('code', { d1: true }), B: stage('clean'), C: stage('clean') })],
    ds,
    null,
  );

  it('renders both stages, the M7 verdict, the cost, and says the human labels are pending', () => {
    const md = renderBlock(s);
    expect(md).toContain('<!-- hints-eval:hint-main@1 -->');
    expect(md).toContain('A · main model alone (no removal pass)');
    expect(md).toContain('B · with the code-removal pass');
    expect(md).toContain('**M7 (shipped leak rate ≤ 2 %): PASS**');
    expect(md).toContain('50.0% (1/2)');
    expect(md).toContain('Human labels: 0 of 20 (pending');
    expect(md).toContain('p95 2.0 s');
  });

  it('adds the block under its heading, replaces the same prompt version, keeps other versions and other sections', () => {
    const base = '# Metrics\n\n## Load test (O-03)\n\nstuff\n\n## Failure drills (O-06)\n\nmore\n';
    const once = upsertBlock(base, 'hint-main@1', renderBlock(s));
    expect(once).toContain(HEADING);
    expect(once.indexOf(HEADING)).toBeGreaterThan(once.indexOf('## Failure drills (O-06)'));
    expect(once).toContain('## Load test (O-03)\n\nstuff');
    const again = upsertBlock(once, 'hint-main@1', renderBlock(s));
    expect(again).toBe(once); // idempotent
    const v2 = upsertBlock(
      once,
      'hint-main@2',
      renderBlock({ ...s, promptVersion: 'hint-main@2' }),
    );
    expect(v2).toContain('<!-- hints-eval:hint-main@1 -->');
    expect(v2).toContain('<!-- hints-eval:hint-main@2 -->');
    expect(v2.match(new RegExp(HEADING.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1);
    // a heading in the middle of the file: the block goes inside its section
    const mid = upsertBlock(
      `# M\n\n${HEADING}\n\nintro\n\n## After\n\nx\n`,
      'k',
      '<!-- hints-eval:k -->\nB\n<!-- /hints-eval:k -->',
    );
    expect(mid.indexOf('<!-- hints-eval:k -->')).toBeLessThan(mid.indexOf('## After'));
  });
});
