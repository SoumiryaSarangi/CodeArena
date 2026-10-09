import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from '../../src/config/config';
import { ProblemError } from '../../src/common/problem';
import { runHintPipeline } from '../../src/modules/ai/hints/hint-pipeline';
import { HINT_PROMPT_VERSION } from '../../src/modules/ai/hints/hint-prompts';
import { AiLedger } from '../../src/modules/ai/ledger';
import { AiRouter } from '../../src/modules/ai/router';
import { buildDataset, type EvalDataset, type EvalItem } from './dataset';
import { assess, boilerplateGrams, type Verdicts } from './detectors';
import {
  renderBlock,
  sheetFrom,
  summarize,
  upsertBlock,
  disagreementsMd,
  type LabelSheet,
} from './report';

/** What one text (a pipeline stage) scored. */
export interface Stage {
  text: string;
  verdicts: Verdicts;
}

/** One finished item: a line of the results JSONL. */
export interface Row {
  id: string;
  kind: EvalItem['kind'];
  level: EvalItem['level'];
  slug: string;
  injection: string | null;
  expect: EvalItem['expect'];
  promptVersion: string;
  at: string;
  outcome: 'hint' | 'nudge' | 'error';
  error?: string;
  nudge?: string;
  generic?: boolean;
  /** A: the main model alone (no removal pass). B: after the removal pass. C: what ships. */
  A?: Stage;
  B?: Stage;
  C?: Stage;
  /** The first main answer failed the shipping filter (the service's `leak_flag`). */
  filterLeakFlag?: boolean;
  tokensIn: number;
  tokensOut: number;
  /** Tokens spent judging (kept apart: the judge is not part of a hint's cost). */
  judgeTokens: number;
  latencyMs: number;
  models: string[];
}

export interface RunOptions {
  /** Item ids already done (a resumed run). */
  skip?: Set<string>;
  limit?: number;
  paceMs?: number;
  /** Waits when the AI service is busy (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const busy = (e: unknown) =>
  e instanceof ProblemError && (e.code === 'ai-busy' || e.code === 'rate-limited');

/**
 * Runs one item through the real hint pipeline and scores the three stages. Stage C is scored again only if it
 * differs from B (a blocked or retried hint); the safe generic hint is static and gets only the free detectors.
 */
export async function runItem(
  router: AiRouter,
  ds: EvalDataset,
  item: EvalItem,
  boilerplate: Set<string>,
): Promise<Row> {
  const p = ds.problems[item.slug]!;
  const problem = {
    title: p.title,
    statementMd: p.statementMd,
    acSolutions: p.acSolutions,
    avoidSet: p.avoidSet,
    boilerplate,
  };
  const base = {
    id: item.id,
    kind: item.kind,
    level: item.level,
    slug: item.slug,
    injection: item.injection,
    expect: item.expect,
    promptVersion: HINT_PROMPT_VERSION,
    at: new Date().toISOString(),
  };
  const hasCode = (item.attempt ?? '').trim().length > 0;
  // The service answers a nudge at levels 2 and 3 without an attempt, before any model call.
  if (item.level > 1 && !hasCode) {
    return {
      ...base,
      outcome: 'nudge',
      nudge: '(no attempt)',
      tokensIn: 0,
      tokensOut: 0,
      judgeTokens: 0,
      latencyMs: 0,
      models: [],
    };
  }
  const result = await runHintPipeline(
    router,
    {
      level: item.level,
      title: p.title,
      statement: p.statementMd,
      editorial: p.editorialMd,
      code: item.attempt,
      language: item.language,
      verdict: item.verdict,
      failedTest: item.failedTest,
    },
    p.avoidSet,
    hasCode,
  );
  if (result.kind === 'nudge') {
    return {
      ...base,
      outcome: 'nudge',
      nudge: result.nudge,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      judgeTokens: 0,
      latencyMs: result.latencyMs,
      models: result.models,
    };
  }
  let judgeTokens = 0;
  const score = async (text: string, judge: boolean): Promise<Stage> => {
    const verdicts = await assess(judge ? router : null, text, item.level, problem);
    judgeTokens += (verdicts.d3?.tokensIn ?? 0) + (verdicts.d3?.tokensOut ?? 0);
    return { text, verdicts };
  };
  const first = result.attempts[0]!;
  const A = await score(first.main, true);
  const B = first.cleaned === first.main ? A : await score(first.cleaned, true);
  const C = result.text === first.cleaned ? B : await score(result.text, !result.generic);
  return {
    ...base,
    outcome: 'hint',
    generic: result.generic,
    A,
    B,
    C,
    filterLeakFlag: result.leak,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    judgeTokens,
    latencyMs: result.latencyMs,
    models: result.models,
  };
}

/** The whole run: items in order, JSONL out, waiting out a busy AI service, errors recorded not thrown. */
export async function runAll(
  router: AiRouter,
  ds: EvalDataset,
  emit: (row: Row) => void,
  o: RunOptions = {},
): Promise<{ done: number; errors: number }> {
  const sleep = o.sleep ?? defaultSleep;
  const boilerplate = boilerplateGrams(
    Object.fromEntries(Object.values(ds.problems).map((p) => [p.slug, p.acSolutions])),
  );
  let done = 0;
  let errors = 0;
  for (const item of ds.items) {
    if (o.skip?.has(item.id)) continue;
    if (o.limit !== undefined && done + errors >= o.limit) break;
    let row: Row | null = null;
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      try {
        row = await runItem(router, ds, item, boilerplate);
      } catch (e) {
        if (busy(e) && attempt < 3) {
          const wait = Math.min(
            Number((e as ProblemError).extra.headers?.['Retry-After'] ?? 30) * 1000,
            70_000,
          );
          o.log?.(`${item.id}: AI busy, waiting ${Math.round(wait / 1000)} s`);
          await sleep(wait);
          continue;
        }
        row = {
          id: item.id,
          kind: item.kind,
          level: item.level,
          slug: item.slug,
          injection: item.injection,
          expect: item.expect,
          promptVersion: HINT_PROMPT_VERSION,
          at: new Date().toISOString(),
          outcome: 'error',
          error: (e as Error).message.slice(0, 200),
          tokensIn: 0,
          tokensOut: 0,
          judgeTokens: 0,
          latencyMs: 0,
          models: [],
        };
      }
    }
    emit(row!);
    if (row!.outcome === 'error') errors++;
    else done++;
    o.log?.(`${row!.outcome === 'error' ? 'ERR ' : 'ok  '} ${item.id}`);
    if (o.paceMs) await sleep(o.paceMs);
  }
  return { done, errors };
}

// ---- the command line -----------------------------------------------------------------------------

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
/** Result rows from a JSONL file; any other line (a stray log line) is ignored. */
export const parseRows = (text: string): Row[] =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const o = JSON.parse(l) as Partial<Row>;
        return o &&
          typeof o.id === 'string' &&
          typeof o.outcome === 'string' &&
          typeof o.promptVersion === 'string'
          ? [o as Row]
          : [];
      } catch {
        return [];
      }
    });
const readRows = (file: string): Row[] =>
  existsSync(file) ? parseRows(readFileSync(file, 'utf8')) : [];

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    const root = arg('problems', here('../../../../problems'))!;
    const ds = buildDataset(root);
    writeFileSync(here('./dataset.json'), `${JSON.stringify(ds, null, 2)}\n`);
    console.error(
      `dataset.json: ${ds.items.length} items over ${Object.keys(ds.problems).length} problems`,
    );
    return;
  }
  if (cmd === 'run') {
    // The dataset comes on stdin (`-`) when this runs inside the production container (no files in there).
    const src = arg('dataset', here('./dataset.json'))!;
    const ds = JSON.parse(
      src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8'),
    ) as EvalDataset;
    const config = loadConfig();
    const redis = new Redis(config.REDIS_URL);
    const router = new AiRouter(
      config,
      new AiLedger(redis, config.QUEUE_KEY_PREFIX),
      // logs go to stderr: stdout is the results file
      pino({ level: 'warn', base: { service: 'eval' } }, pino.destination(2)),
    );
    if (!router.available) throw new Error('no AI provider is configured (keys missing)');
    const skip = new Set(
      (arg('skip') ? readRows(arg('skip')!) : [])
        .filter((r) => r.outcome !== 'error')
        .map((r) => r.id),
    );
    const r = await runAll(router, ds, (row) => process.stdout.write(`${JSON.stringify(row)}\n`), {
      skip,
      limit: arg('limit') ? Number(arg('limit')) : undefined,
      paceMs: Number(arg('pace', '0')),
      log: (l) => console.error(l),
    });
    console.error(`done ${r.done}, errors ${r.errors}`);
    redis.disconnect();
    return;
  }
  const results = (arg('results') ?? '').split(',').filter(Boolean).flatMap(readRows);
  const ds = JSON.parse(readFileSync(here('./dataset.json'), 'utf8')) as EvalDataset;
  if (cmd === 'sheet') {
    const out = arg('out', here('./labels.json'))!;
    if (existsSync(out) && !process.argv.includes('--force'))
      throw new Error(`${out} exists (it may hold labels); pass --force to replace it`);
    const sheet = sheetFrom(results, ds, Number(arg('n', '20')));
    writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`);
    console.error(
      `${out}: ${sheet.entries.length} hints to label (fill "label" with "leak", "spoiler" or "ok")`,
    );
    return;
  }
  if (cmd === 'report') {
    const labelsFile = arg('labels', here('./labels.json'))!;
    const labels = existsSync(labelsFile)
      ? (JSON.parse(readFileSync(labelsFile, 'utf8')) as LabelSheet)
      : null;
    const metrics = arg('metrics', here('../../../../docs/METRICS.md'))!;
    const summary = summarize(results, ds, labels);
    const md = existsSync(metrics) ? readFileSync(metrics, 'utf8') : '# Metrics\n';
    writeFileSync(metrics, upsertBlock(md, summary.promptVersion, renderBlock(summary)));
    writeFileSync(here('./disagreements.md'), disagreementsMd(results, ds));
    console.error(`${metrics} updated (${summary.promptVersion}); disagreements.md written`);
    return;
  }
  console.error(
    'usage: eval:hints build | run [--dataset file|-] [--skip results.jsonl] [--limit n] [--pace ms] | sheet --results a.jsonl [--n 20] | report --results a.jsonl[,b.jsonl] [--labels file]',
  );
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
