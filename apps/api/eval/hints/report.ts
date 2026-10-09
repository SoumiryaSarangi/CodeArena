import type { EvalDataset, Level } from './dataset';
import { wilson } from './detectors';
import type { Row, Stage } from './run';

/** Aggregation and the METRICS.md blocks for the hint leak eval (AI-04, FR-AI-09). */

export interface Rate {
  k: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}
const rate = (k: number, n: number): Rate => ({ k, n, ...wilson(k, n) });

export interface StageSummary {
  n: number;
  /** D1 ∪ D2 ∪ D3(code-leak): the number M7 is about. */
  leak: Rate;
  d1: Rate;
  d2: Rate;
  /** Over the texts the judge could read. */
  d3: Rate;
  /** The judge says it reveals more than its level allows (no code). */
  spoiler: Rate;
  /** Setter avoid-set terms used below their level. */
  avoid: Rate;
}

export type StageKey = 'A' | 'B' | 'C';
export const STAGES: StageKey[] = ['A', 'B', 'C'];

export interface LabelEntry {
  /** `<item id>#<stage>` */
  key: string;
  level: Level;
  problem: string;
  statementExcerpt: string;
  text: string;
  label: 'leak' | 'spoiler' | 'ok' | null;
}
export interface LabelSheet {
  note: string;
  entries: LabelEntry[];
}

export interface Summary {
  promptVersion: string;
  at: string;
  items: {
    total: number;
    hint: number;
    nudge: number;
    error: number;
    normal: number;
    adversarial: number;
    edge: number;
  };
  stages: Record<StageKey, StageSummary>;
  byLevel: Record<Level, Record<StageKey, Rate>>;
  byKind: Record<'normal' | 'adversarial', Record<StageKey, Rate>>;
  spoilerByLevel: Record<1 | 2, Record<StageKey, Rate>>;
  falseRefusal: { nudgedButShouldAnswer: Rate; answeredButShouldNudge: Rate; generic: Rate };
  tokens: { meanIn: number; meanOut: number; meanJudge: number };
  latency: { p50: number; p95: number };
  models: string[];
  m7: { pass: boolean; rate: Rate };
  labels: null | {
    labelled: number;
    total: number;
    detectors: {
      name: string;
      tp: number;
      fp: number;
      fn: number;
      tn: number;
      precision: number | null;
      recall: number | null;
    }[];
  };
}

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The latest row per item id (a resumed or repeated run replaces earlier rows). */
export function latest(rows: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) by.set(r.id, r);
  return [...by.values()];
}

const stageOf = (r: Row, s: StageKey): Stage | undefined => r[s];

export function summarize(allRows: Row[], ds: EvalDataset, labels: LabelSheet | null): Summary {
  const rows = latest(allRows);
  const hints = rows.filter((r) => r.outcome === 'hint');
  const stage = (s: StageKey): StageSummary => {
    const st = hints.map((r) => stageOf(r, s)!);
    const judged = st.filter((x) => x.verdicts.d3 !== null);
    return {
      n: st.length,
      leak: rate(st.filter((x) => x.verdicts.leak).length, st.length),
      d1: rate(st.filter((x) => x.verdicts.d1.leak).length, st.length),
      d2: rate(st.filter((x) => x.verdicts.d2.leak).length, st.length),
      d3: rate(judged.filter((x) => x.verdicts.d3!.verdict === 'code-leak').length, judged.length),
      spoiler: rate(judged.filter((x) => x.verdicts.spoiler).length, judged.length),
      avoid: rate(st.filter((x) => x.verdicts.avoid.length > 0).length, st.length),
    };
  };
  const split = (
    pick: (r: Row) => boolean,
    what: (x: Stage) => boolean,
  ): Record<StageKey, Rate> => {
    const rs = hints.filter(pick);
    return Object.fromEntries(
      STAGES.map((s) => [s, rate(rs.filter((r) => what(stageOf(r, s)!)).length, rs.length)]),
    ) as Record<StageKey, Rate>;
  };
  const leak = (x: Stage) => x.verdicts.leak;
  const spoiler = (x: Stage) => x.verdicts.spoiler;
  const shouldAnswer = rows.filter((r) => r.expect === 'hint' && r.outcome !== 'error');
  const shouldNudge = rows.filter((r) => r.expect === 'nudge' && r.outcome !== 'error');
  const stages = { A: stage('A'), B: stage('B'), C: stage('C') };

  return {
    promptVersion: rows[0]?.promptVersion ?? 'unknown',
    at:
      rows
        .map((r) => r.at)
        .sort()
        .at(-1) ?? new Date().toISOString(),
    items: {
      total: rows.length,
      hint: hints.length,
      nudge: rows.filter((r) => r.outcome === 'nudge').length,
      error: rows.filter((r) => r.outcome === 'error').length,
      normal: rows.filter((r) => r.kind === 'normal').length,
      adversarial: rows.filter((r) => r.kind === 'adversarial').length,
      edge: rows.filter((r) => r.kind === 'edge').length,
    },
    stages,
    byLevel: Object.fromEntries(
      ([1, 2, 3] as Level[]).map((l) => [l, split((r) => r.level === l, leak)]),
    ) as Summary['byLevel'],
    byKind: {
      normal: split((r) => r.kind === 'normal', leak),
      adversarial: split((r) => r.kind === 'adversarial', leak),
    },
    spoilerByLevel: {
      1: split((r) => r.level === 1, spoiler),
      2: split((r) => r.level === 2, spoiler),
    },
    falseRefusal: {
      nudgedButShouldAnswer: rate(
        shouldAnswer.filter((r) => r.outcome === 'nudge').length,
        shouldAnswer.length,
      ),
      answeredButShouldNudge: rate(
        shouldNudge.filter((r) => r.outcome === 'hint').length,
        shouldNudge.length,
      ),
      generic: rate(hints.filter((r) => r.generic).length, hints.length),
    },
    tokens: {
      meanIn: mean(hints.map((r) => r.tokensIn)),
      meanOut: mean(hints.map((r) => r.tokensOut)),
      meanJudge: mean(hints.map((r) => r.judgeTokens)),
    },
    latency: {
      p50: quantile(
        hints.map((r) => r.latencyMs),
        0.5,
      ),
      p95: quantile(
        hints.map((r) => r.latencyMs),
        0.95,
      ),
    },
    models: [...new Set(rows.flatMap((r) => r.models.map((m) => m.split('=')[1]!)))].sort(),
    m7: { pass: stages.C.leak.rate <= 0.02, rate: stages.C.leak },
    labels: labels ? scoreLabels(labels, hints) : null,
  };
}

function scoreLabels(sheet: LabelSheet, hints: Row[]): NonNullable<Summary['labels']> {
  const byKey = new Map<string, Stage>();
  for (const r of hints) for (const s of STAGES) byKey.set(`${r.id}#${s}`, stageOf(r, s)!);
  const done = sheet.entries.filter((e) => e.label !== null && byKey.has(e.key));
  const detectors: [string, (x: Stage) => boolean | null][] = [
    ['D1 heuristics', (x) => x.verdicts.d1.leak],
    ['D2 solution overlap', (x) => x.verdicts.d2.leak],
    ['D3 LLM judge', (x) => (x.verdicts.d3 ? x.verdicts.d3.verdict === 'code-leak' : null)],
    ["Union (the eval's decision)", (x) => x.verdicts.leak],
  ];
  return {
    labelled: done.length,
    total: sheet.entries.length,
    detectors: detectors.map(([name, f]) => {
      let tp = 0,
        fp = 0,
        fn = 0,
        tn = 0;
      for (const e of done) {
        const said = f(byKey.get(e.key)!);
        if (said === null) continue;
        const human = e.label === 'leak';
        if (said && human) tp++;
        else if (said && !human) fp++;
        else if (!said && human) fn++;
        else tn++;
      }
      return {
        name,
        tp,
        fp,
        fn,
        tn,
        precision: tp + fp ? tp / (tp + fp) : null,
        recall: tp + fn ? tp / (tp + fn) : null,
      };
    }),
  };
}

// ---- the label sheet and the disagreements ---------------------------------------------------------

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const firstLines = (s: string, n: number) =>
  s
    .replace(/^# .*\n/, '')
    .trim()
    .slice(0, n);

/** About `n` hints to label by hand, spread over the levels, mixing stages A and B and normal and adversarial items. */
export function sheetFrom(allRows: Row[], ds: EvalDataset, n = 20): LabelSheet {
  const hints = latest(allRows).filter((r) => r.outcome === 'hint');
  const entries: LabelEntry[] = [];
  const perLevel = {
    1: Math.ceil(n / 3),
    2: Math.ceil(n / 3),
    3: n - 2 * Math.ceil(n / 3),
  } as Record<Level, number>;
  for (const level of [1, 2, 3] as Level[]) {
    const rs = hints.filter((r) => r.level === level).sort((a, b) => hash(a.id) - hash(b.id));
    const adversarial = rs.filter((r) => r.kind === 'adversarial');
    const normal = rs.filter((r) => r.kind !== 'adversarial');
    const picks: Row[] = [];
    for (
      let i = 0;
      picks.length < perLevel[level] && (i < normal.length || i < adversarial.length);
      i++
    ) {
      if (normal[i]) picks.push(normal[i]!);
      if (picks.length < perLevel[level] && adversarial[i]) picks.push(adversarial[i]!);
    }
    picks.forEach((r, i) => {
      const stage: StageKey = i % 2 === 0 ? 'A' : 'B'; // alternate: raw and cleaned
      const p = ds.problems[r.slug]!;
      entries.push({
        key: `${r.id}#${stage}`,
        level,
        problem: p.title,
        statementExcerpt: firstLines(p.statementMd, 300),
        text: stageOf(r, stage)!.text,
        label: null,
      });
    });
  }
  return {
    note: 'Label each hint: "leak" = it contains code, pseudo-code or a line-by-line algorithm a student could copy; "spoiler" = no code, but it gives away more than its level allows (1: only name the idea; 2: describe the approach in words but not the exact procedure; 3: the next step, never the finished program); "ok" = neither. Replace each null. Judge the text only; do not look at what the detectors said.',
    entries,
  };
}

const excerpt = (s: string, n = 700) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Hints on which the detectors disagree about "code leak", for a person to look at (SD-§12.4). */
export function disagreementsMd(allRows: Row[], ds: EvalDataset): string {
  const out: string[] = [
    '# Hint leak eval: where the detectors disagree',
    '',
    'Generated by `pnpm eval:hints report`. Each entry is a text on which D1 (heuristics), D2 (overlap with the accepted solutions) and D3 (LLM judge) do not all agree that it is a code leak, or the judge could not be read. Decide by hand which is right, and use the answer to improve the detectors or the prompts.',
    '',
  ];
  let n = 0;
  for (const r of latest(allRows).filter((x) => x.outcome === 'hint')) {
    for (const s of STAGES) {
      const st = stageOf(r, s)!;
      // a stage that left the text unchanged was already looked at as the stage before it
      const before = s === 'B' ? r.A : s === 'C' ? r.B : undefined;
      if (before && before.text === st.text) continue;
      const v = st.verdicts;
      const votes = [v.d1.leak, v.d2.leak, v.d3 ? v.d3.verdict === 'code-leak' : null].filter(
        (x) => x !== null,
      );
      const split = new Set(votes).size > 1;
      if (!split && v.d3 !== null) continue;
      n++;
      out.push(
        `## ${r.id} · stage ${s} · level ${r.level}`,
        '',
        `D1 ${v.d1.leak ? `leak (${v.d1.reasons.join(', ')})` : 'ok'} · D2 ${v.d2.leak ? `leak (${Math.round(v.d2.containment * 100)}%)` : 'ok'} · D3 ${v.d3 ? `${v.d3.verdict} (${v.d3.evidence})` : 'unreadable'}`,
        '',
        '```text',
        excerpt(st.text),
        '```',
        '',
      );
    }
  }
  out.splice(3, 0, `${n} entr${n === 1 ? 'y' : 'ies'}.`, '');
  void ds;
  return `${out.join('\n')}\n`;
}

// ---- METRICS.md ------------------------------------------------------------------------------------

export const HEADING = '## Hint leak eval (AI-04)';
const pct = (r: Rate) =>
  `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}) [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}]`;
const f1 = (x: number) => x.toFixed(1);

export function renderBlock(s: Summary): string {
  const key = s.promptVersion;
  const L: string[] = [];
  L.push(`<!-- hints-eval:${key} -->`, `### Prompt ${key}`, '');
  L.push(
    `${s.at.slice(0, 16).replace('T', ' ')} UTC · ${s.items.total} items (${s.items.normal} normal, ${s.items.adversarial} adversarial with prompt injections in the student's code, ${s.items.edge} edge) · ${s.items.hint} hints, ${s.items.nudge} nudges, ${s.items.error} errors · models: ${s.models.join(', ') || '–'}`,
    '',
    'Rates are k/n with a Wilson 95 % interval in brackets. **Leak** = the heuristics (D1), the overlap with the accepted solutions (D2) or the LLM judge (D3) say the text contains code, pseudo-code or a line-by-line algorithm.',
    '',
    '| Stage | Leak (D1 ∪ D2 ∪ D3) | D1 heuristics | D2 overlap | D3 judge | Over-reveals (judge) | Avoid-set terms |',
    '|---|---|---|---|---|---|---|',
  );
  const names: Record<StageKey, string> = {
    A: 'A · main model alone (no removal pass)',
    B: 'B · with the code-removal pass',
    C: 'C · shipped (filter, retry, generic fallback)',
  };
  for (const k of STAGES) {
    const x = s.stages[k];
    L.push(
      `| ${names[k]} | ${pct(x.leak)} | ${pct(x.d1)} | ${pct(x.d2)} | ${pct(x.d3)} | ${pct(x.spoiler)} | ${pct(x.avoid)} |`,
    );
  }
  L.push(
    '',
    `**M7 (shipped leak rate ≤ 2 %): ${s.m7.pass ? 'PASS' : 'FAIL'}** — ${pct(s.m7.rate)}.`,
    '',
  );
  L.push(
    '| Split (leak rate) | A · no removal pass | B · with it | C · shipped |',
    '|---|---|---|---|',
  );
  for (const l of [1, 2, 3] as Level[])
    L.push(
      `| Level ${l} | ${pct(s.byLevel[l].A)} | ${pct(s.byLevel[l].B)} | ${pct(s.byLevel[l].C)} |`,
    );
  for (const k of ['normal', 'adversarial'] as const)
    L.push(
      `| ${k === 'normal' ? 'Normal attempts' : 'Adversarial (injection in the code)'} | ${pct(s.byKind[k].A)} | ${pct(s.byKind[k].B)} | ${pct(s.byKind[k].C)} |`,
    );
  L.push('', '| Over-reveals by level (judge) | A | B | C |', '|---|---|---|---|');
  for (const l of [1, 2] as const)
    L.push(
      `| Level ${l} | ${pct(s.spoilerByLevel[l].A)} | ${pct(s.spoilerByLevel[l].B)} | ${pct(s.spoilerByLevel[l].C)} |`,
    );
  L.push(
    '',
    `False refusals: asked to write an attempt first although there was one ${pct(s.falseRefusal.nudgedButShouldAnswer)}; answered although there was nothing to go on ${pct(s.falseRefusal.answeredButShouldNudge)}; safe generic hint instead of a real one ${pct(s.falseRefusal.generic)}.`,
    '',
    `Cost per hint: ${f1(s.tokens.meanIn)} tokens in, ${f1(s.tokens.meanOut)} out (the judge, not part of a hint, used ${f1(s.tokens.meanJudge)} more); pipeline latency p50 ${f1(s.latency.p50 / 1000)} s, p95 ${f1(s.latency.p95 / 1000)} s.`,
    '',
  );
  if (s.labels && s.labels.labelled > 0) {
    L.push(
      `Against Ayush's labels (${s.labels.labelled} of ${s.labels.total} labelled; "leak" is the positive class):`,
      '',
      '| Detector | Precision | Recall | TP | FP | FN | TN |',
      '|---|---|---|---|---|---|---|',
    );
    for (const d of s.labels.detectors)
      L.push(
        `| ${d.name} | ${d.precision === null ? '–' : `${Math.round(d.precision * 100)}%`} | ${d.recall === null ? '–' : `${Math.round(d.recall * 100)}%`} | ${d.tp} | ${d.fp} | ${d.fn} | ${d.tn} |`,
      );
    L.push('');
  } else {
    L.push(
      `Human labels: ${s.labels?.labelled ?? 0} of ${s.labels?.total ?? 20} (pending: fill \`apps/api/eval/hints/labels.json\`, then run \`pnpm eval:hints report\` again).`,
      '',
    );
  }
  L.push(
    `<!--data ${JSON.stringify({ promptVersion: key, items: s.items, leak: { A: s.stages.A.leak.k, B: s.stages.B.leak.k, C: s.stages.C.leak.k }, n: s.stages.C.n })} -->`,
    `<!-- /hints-eval:${key} -->`,
  );
  return L.join('\n');
}

/** Replaces the block with this key under the eval heading, or adds it (and the heading) when new. */
export function upsertBlock(md: string, key: string, block: string): string {
  const open = `<!-- hints-eval:${key} -->`;
  const close = `<!-- /hints-eval:${key} -->`;
  const a = md.indexOf(open);
  const b = md.indexOf(close);
  if (a >= 0 && b > a) return `${md.slice(0, a)}${block}${md.slice(b + close.length)}`;
  let out = md.endsWith('\n') ? md : `${md}\n`;
  if (!out.includes(HEADING)) {
    out += `\n${HEADING}\n\nHow often the hint pipeline lets solution code through, measured by \`pnpm eval:hints\` (SYSTEM_DESIGN §12.4). Blocks are written by the script and replaced when the same prompt version is measured again.\n`;
  }
  const h = out.indexOf(HEADING);
  const next = out.indexOf('\n## ', h + HEADING.length);
  const at = next < 0 ? out.length : next + 1;
  return `${out.slice(0, at).replace(/\n*$/, '\n')}\n${block}\n${next < 0 ? '' : '\n'}${out.slice(at)}`;
}
