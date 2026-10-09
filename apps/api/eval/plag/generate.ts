import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from '../../src/config/config';
import { AiLedger } from '../../src/modules/ai/ledger';
import { AiRouter } from '../../src/modules/ai/router';

/**
 * PL-03: independent solutions for the plagiarism eval's negative class. Run on the production VM (the only place with
 * the AI keys): the statements come on stdin, one JSON line per solution goes to stdout. Each problem gets
 * solutions in each language in several writing styles; they are "independent" in the sense that matters (written
 * without seeing each other or the reference solution), and they will often resemble each other, as real students'
 * solutions do. They are checked against the problem's tests before they are used (`plag.evalset`).
 */

export const PERSONAS = [
  'You are a fast competitive programmer: short names, minimal code, standard library heavy.',
  'You are a careful beginner: long descriptive names, small helper functions, a few comments.',
  'You are a seasoned engineer who prefers a different but valid approach from the most obvious one when one exists.',
  'You write in a compact functional style, avoiding mutable globals.',
] as const;

export const LANGUAGES = { cpp17: 'C++17', python3: 'Python 3' } as const;

/** The program inside the first fenced block (or the whole answer when there is none). */
export function extractCode(answer: string): string {
  const m = /```[a-zA-Z0-9+#]*\n([\s\S]*?)```/.exec(answer);
  return (m ? m[1]! : answer).trim();
}

export interface Problem {
  slug: string;
  statementMd: string;
}
export interface Solution {
  slug: string;
  language: keyof typeof LANGUAGES;
  persona: number;
  source: string;
}

export const haveKey = (slug: string, language: string, persona: number) =>
  `${slug}:${language}:${persona}`;

export function prompt(language: keyof typeof LANGUAGES, persona: number, statement: string) {
  return [
    {
      role: 'system' as const,
      content: `${PERSONAS[persona]} Solve the programming problem. Reply with one complete, compilable ${LANGUAGES[language]} program that reads standard input and writes standard output, in a single fenced code block, and nothing else. Real code only: never pseudo-code, never an outline.`,
    },
    { role: 'user' as const, content: statement },
  ];
}

async function main() {
  const problems = JSON.parse(readFileSync(0, 'utf8')) as Problem[];
  const perLanguage = Number(process.argv[2] ?? '4');
  // `slug:language:persona` entries already done (a resumed run): the validated solutions of an earlier pass
  const have = new Set((process.env.PLAG_HAVE ?? '').split(',').filter(Boolean));
  const config = loadConfig();
  const redis = new Redis(config.REDIS_URL);
  const router = new AiRouter(
    config,
    new AiLedger(redis, config.QUEUE_KEY_PREFIX),
    pino({ level: 'warn' }, pino.destination(2)),
  );
  for (const p of problems) {
    for (const language of Object.keys(LANGUAGES) as (keyof typeof LANGUAGES)[]) {
      for (let persona = 0; persona < perLanguage; persona++) {
        if (have.has(haveKey(p.slug, language, persona))) continue;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const r = await router.complete({
              task: 'review',
              feature: 'plag-eval',
              messages: prompt(language, persona, p.statementMd),
              maxTokens: 1400,
              temperature: 0.9,
            });
            const s: Solution = { slug: p.slug, language, persona, source: extractCode(r.text) };
            process.stdout.write(`${JSON.stringify(s)}\n`);
            console.error(`ok  ${p.slug} ${language} ${persona}`);
            break;
          } catch (e) {
            console.error(`retry ${p.slug} ${language} ${persona}: ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 15_000));
          }
        }
      }
    }
  }
  redis.disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
