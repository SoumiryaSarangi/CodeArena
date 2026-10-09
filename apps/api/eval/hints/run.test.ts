import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config';
import { AiLedger } from '../../src/modules/ai/ledger';
import { AiRouter } from '../../src/modules/ai/router';
import { type Provider, ProviderError } from '../../src/modules/ai/types';
import { createLogger } from '../../src/telemetry/logger';
import { buildDataset, type EvalDataset } from './dataset';
import { summarize } from './report';
import { runAll, type Row } from './run';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AI_GLOBAL_PER_MIN: '100000' });
const probe = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
probe.on('error', () => {});
const redisUp = await probe.connect().then(
  () => true,
  () => false,
);
probe.disconnect();

const full = buildDataset(fileURLToPath(new URL('../../../../problems', import.meta.url)));
const pick = (pattern: RegExp) => full.items.find((i) => pattern.test(i.id))!;
const mini = (...items: ReturnType<typeof pick>[]): EvalDataset => ({ ...full, items });
const PROSE = 'Think about how the grid is connected, and about what you have already visited.';

/** Answers by reading which step asks (each step's system prompt is distinct) and keeps count. */
class Scripted implements Provider {
  readonly name = 'groq' as const;
  calls: ('sufficiency' | 'main' | 'removal' | 'judge')[] = [];
  /** What the main model writes: code (a leak) or prose. */
  main = '';
  /** What the removal pass does with its input. */
  removal: (hint: string) => string = () => PROSE;
  sufficient = true;
  /** Fail this many calls first (400: not worth retrying, so the router falls through its chain). */
  failFirst = 0;
  async complete(_model: string, req: Parameters<Provider['complete']>[1]) {
    if (this.failFirst > 0) {
      this.failFirst--;
      throw new ProviderError('nope', 400);
    }
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const step = system.includes('decide whether there is enough context')
      ? 'sufficiency'
      : system.includes('edit a programming hint')
        ? 'removal'
        : system.includes('audit AI-written programming hints')
          ? 'judge'
          : 'main';
    this.calls.push(step);
    const text =
      step === 'sufficiency'
        ? JSON.stringify({ sufficient: this.sufficient, nudge: 'Your program prints nothing yet.' })
        : step === 'main'
          ? this.main
          : step === 'removal'
            ? this.removal(/<hint>\n([\s\S]*)\n<\/hint>/.exec(user)?.[1] ?? '')
            : JSON.stringify({
                verdict: /<hint>\n[\s\S]*(int main|for \()[\s\S]*<\/hint>/.test(user)
                  ? 'code-leak'
                  : 'ok',
                evidence: 'x',
              });
    return { text, usage: { inputTokens: 100, outputTokens: 20 } };
  }
}

describe.skipIf(!redisUp)('FR-AI-09: running the hint eval (needs the Compose Redis)', () => {
  const prefix = `t${randomBytes(4).toString('hex')}:`;
  let redis: Redis;
  const fake = new Scripted();
  const waits: number[] = [];
  const router = () =>
    new AiRouter(
      config,
      new AiLedger(redis, prefix),
      createLogger({ LOG_LEVEL: 'silent' }),
      { groq: fake, gemini: fake },
      async (ms) => {
        waits.push(ms);
      },
    );
  const run = async (ds: EvalDataset, o: Parameters<typeof runAll>[3] = {}) => {
    const rows: Row[] = [];
    const out = await runAll(router(), ds, (r) => rows.push(r), {
      sleep: async (ms) => void waits.push(ms),
      ...o,
    });
    return { rows, ...out };
  };
  const reset = () => {
    fake.calls = [];
    fake.main = '';
    fake.removal = () => PROSE;
    fake.sufficient = true;
    fake.failFirst = 0;
    waits.length = 0;
  };

  beforeAll(() => {
    redis = new Redis(config.REDIS_URL);
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  const LEAKY = `Here you go:\n\`\`\`cpp\n${full.problems['maze-runner']!.acSolutions[0]!}\n\`\`\``;
  const maze1 = pick(/^maze-runner:L1:normal$/);

  it('with the removal pass: the raw main answer leaks (A), the cleaned one does not (B), and that is what ships (C)', async () => {
    reset();
    fake.main = LEAKY;
    const { rows, done, errors } = await run(mini(maze1));
    expect({ done, errors }).toEqual({ done: 1, errors: 0 });
    const r = rows[0]!;
    expect(r).toMatchObject({
      outcome: 'hint',
      generic: false,
      filterLeakFlag: true,
      expect: 'hint',
      promptVersion: 'hint-main@1',
    });
    expect(r.A!.verdicts).toMatchObject({ leak: true });
    expect(
      r.A!.verdicts.d1.leak && r.A!.verdicts.d2.leak && r.A!.verdicts.d3!.verdict === 'code-leak',
    ).toBe(true); // all three agree
    expect(r.B!.text).toBe(PROSE);
    expect(r.B!.verdicts.leak).toBe(false);
    expect(r.C!.text).toBe(PROSE);
    expect(r.models).toEqual([
      'sufficiency=groq:openai/gpt-oss-20b',
      'hint_main=groq:openai/gpt-oss-120b',
      'code_removal=groq:openai/gpt-oss-20b',
    ]);
    expect(r.tokensIn).toBe(300);
    expect(r.tokensOut).toBe(60);
    expect(r.judgeTokens).toBeGreaterThan(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    // the judge ran on A and B (C is the same text as B, not judged again)
    expect(fake.calls.filter((c) => c === 'judge')).toHaveLength(2);
  });

  it('without a working removal pass the leak survives to B, the filter retries once, and the generic hint ships (C clean)', async () => {
    reset();
    fake.main = LEAKY;
    fake.removal = (h) => h; // the removal pass does nothing
    const { rows } = await run(mini(maze1));
    const r = rows[0]!;
    expect(r.A!.verdicts.leak).toBe(true);
    expect(r.B!.verdicts.leak).toBe(true); // mutation check: no cleaning, no difference between A and B
    expect(r.outcome).toBe('hint');
    expect(r.generic).toBe(true);
    expect(r.C!.verdicts.leak).toBe(false);
    expect(r.C!.verdicts.d3).toBeNull(); // the static generic hint is not sent to the judge
    expect(fake.calls.filter((c) => c === 'main')).toHaveLength(2); // one stricter retry
    const s = summarize(rows, mini(maze1), null);
    expect(s.stages.A.leak.rate).toBe(1);
    expect(s.stages.B.leak.rate).toBe(1);
    expect(s.stages.C.leak.rate).toBe(0);
    expect(s.falseRefusal.generic.k).toBe(1);
  });

  it('nothing to go on: an empty attempt nudges without a model call; a stub is a nudge from the sufficiency step', async () => {
    reset();
    const empty = pick(/^stair-climb:L2:edge:empty$/);
    const stub = pick(/^sum-two-numbers:L2:edge:stub$/);
    fake.sufficient = false;
    const { rows } = await run(mini(empty, stub));
    expect(rows.map((r) => r.outcome)).toEqual(['nudge', 'nudge']);
    expect(fake.calls).toEqual(['sufficiency']); // only the stub reached a model
    const s = summarize(rows, mini(empty, stub), null);
    expect(s.falseRefusal.answeredButShouldNudge).toMatchObject({ k: 0, n: 2 });
  });

  it('adversarial items run the same way: the injection is in the attempt the model sees', async () => {
    reset();
    fake.main = PROSE;
    const adv = pick(/:L2:adversarial:/);
    expect(adv.attempt).toMatch(/^(\/\/|#) /);
    const { rows } = await run(mini(adv));
    expect(rows[0]).toMatchObject({
      kind: 'adversarial',
      outcome: 'hint',
      injection: adv.injection,
    });
    expect(rows[0]!.C!.verdicts.leak).toBe(false);
  });

  it('resumes: finished ids are skipped, --limit stops early, an error row is retried on the next run', async () => {
    reset();
    fake.main = PROSE;
    const items = [maze1, pick(/^stair-climb:L1:normal$/), pick(/^rainfall-totals:L1:normal$/)];
    const first = await run(mini(...items), { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([items[0]!.id, items[1]!.id]);
    const second = await run(mini(...items), { skip: new Set(first.rows.map((r) => r.id)) });
    expect(second.rows.map((r) => r.id)).toEqual([items[2]!.id]);
  });

  it('a busy AI service is waited out and retried; one that never answers becomes an error row, not a crash', async () => {
    reset();
    fake.main = PROSE;
    fake.failFirst = 2; // every model of the first step refuses once: the router answers "busy"
    const ok = await run(mini(maze1));
    expect(ok.rows[0]!.outcome).toBe('hint');
    expect(waits.some((w) => w >= 1000)).toBe(true); // it slept before trying again

    reset();
    fake.failFirst = 10_000;
    const bad = await run(mini(maze1));
    expect(bad.rows[0]).toMatchObject({ outcome: 'error' });
    expect(bad.rows[0]!.error).toMatch(/busy/i);
    expect(bad.errors).toBe(1);
    // an error row does not count as a hint, and a later successful row replaces it
    const s = summarize([...bad.rows, { ...ok.rows[0]!, id: maze1.id }], mini(maze1), null);
    expect(s.items).toMatchObject({ hint: 1, error: 0 });
  });
});
