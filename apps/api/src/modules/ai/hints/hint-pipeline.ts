import type { HintLevel } from '@codearena/contracts';
import type { AiRouter } from '../router';
import { avoidTermsFor, filterHint, GENERIC_HINTS } from './hint-filter';
import { CODE_REMOVAL, HINT_MAIN, type HintContext, SUFFICIENCY } from './hint-prompts';

export const DEFAULT_NUDGE =
  'Write and run an attempt first, then ask again: a hint works best on your own code.';

/** One try at a hint: what the main model wrote, what the removal pass made of it, and what the filter said. */
export interface HintAttempt {
  /** Stage A: the main model's raw answer, before the code-removal pass. */
  main: string;
  /** Stage B: after the code-removal pass. */
  cleaned: string;
  /** Why the deterministic filter refused `cleaned` (empty when it passed). */
  filterReasons: string[];
}

export type PipelineResult =
  | {
      kind: 'nudge';
      nudge: string;
      models: string[];
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
    }
  | {
      kind: 'hint';
      /** Stage C: what ships (the cleaned text, or the safe generic hint after two blocked tries). */
      text: string;
      generic: boolean;
      /** The first main answer already failed the filter (the number AI-04 reports before/after the removal pass). */
      leak: boolean;
      blocked: string | null;
      attempts: HintAttempt[];
      models: string[];
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
    };

/** The sufficiency model answers JSON; anything unreadable counts as "sufficient" (the later steps and the filter still guard). */
export function parseSufficiency(raw: string): { sufficient: boolean; nudge: string } {
  const body = raw.replace(/^```(?:json)?|```$/gm, '').trim();
  try {
    const v = JSON.parse(body) as { sufficient?: unknown; nudge?: unknown };
    return {
      sufficient: v.sufficient !== false,
      nudge: typeof v.nudge === 'string' ? v.nudge.trim() : '',
    };
  } catch {
    return { sufficient: true, nudge: '' };
  }
}

/**
 * SD-§12.2 steps 3-6 as one function, used by the hint service and by the leak eval (AI-04) so both measure the
 * same thing: sufficiency (only with code) → main hint → code removal (always) → deterministic filter; one stricter
 * regeneration, then the safe generic hint. Every stage's text is kept in `attempts` for the eval.
 */
export async function runHintPipeline(
  router: AiRouter,
  ctx: HintContext,
  avoidSet: Record<string, string[]>,
  hasCode: boolean,
  onBlocked?: (info: { level: HintLevel; reasons: string[]; attempt: number }) => void,
): Promise<PipelineResult> {
  const started = performance.now();
  const models: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  const call = async (
    task: 'sufficiency' | 'hint_main' | 'code_removal',
    messages: ReturnType<typeof SUFFICIENCY.render>,
    maxTokens: number,
    json = false,
  ) => {
    const r = await router.complete({
      task,
      feature: 'hint',
      messages,
      maxTokens,
      temperature: task === 'hint_main' ? 0.3 : 0,
      json,
    });
    models.push(`${task}=${r.model}`);
    tokensIn += r.usage.inputTokens;
    tokensOut += r.usage.outputTokens;
    return r.text.trim();
  };
  const elapsed = () => Math.round(performance.now() - started);

  // 1. sufficiency (only when there is code to judge)
  if (hasCode) {
    const verdict = parseSufficiency(await call('sufficiency', SUFFICIENCY.render(ctx), 60, true));
    if (!verdict.sufficient) {
      // The nudge is always the fixed sentence: the AI-04 eval found model-written nudges that gave the algorithm away,
      // and they would skip the code-removal pass.
      return {
        kind: 'nudge',
        nudge: DEFAULT_NUDGE,
        models,
        tokensIn,
        tokensOut,
        latencyMs: elapsed(),
      };
    }
  }

  const attempts: HintAttempt[] = [];
  const withAvoid = { ...ctx, avoid: avoidTermsFor(avoidSet, ctx.level) };
  let leak = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    // 2. main hint, 3. code-removal rewrite (always, independent of the main model behaving)
    const main = await call(
      'hint_main',
      HINT_MAIN.render({ ...withAvoid, strict: attempt > 0 }),
      350,
    );
    if (attempt === 0) leak = !filterHint(main, ctx.level, avoidSet).ok;
    const cleaned = await call('code_removal', CODE_REMOVAL.render({ hint: main }), 350);
    // 4. deterministic filter
    const f = filterHint(cleaned, ctx.level, avoidSet);
    attempts.push({ main, cleaned, filterReasons: f.reasons });
    if (f.ok && cleaned.length > 0) {
      return {
        kind: 'hint',
        text: cleaned,
        generic: false,
        leak,
        blocked: null,
        attempts,
        models,
        tokensIn,
        tokensOut,
        latencyMs: elapsed(),
      };
    }
    onBlocked?.({ level: ctx.level, reasons: f.reasons, attempt });
  }
  return {
    kind: 'hint',
    text: GENERIC_HINTS[ctx.level],
    generic: true,
    leak,
    blocked: 'filter',
    attempts,
    models,
    tokensIn,
    tokensOut,
    latencyMs: elapsed(),
  };
}
