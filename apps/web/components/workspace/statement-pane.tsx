'use client';
import Link from 'next/link';
import type { ProblemDetail } from '@codearena/contracts';
import { Copy, Play } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';

const checkerText = (c: ProblemDetail['checker']) =>
  ({
    exact: 'Output must match exactly.',
    tokens: 'Whitespace differences are ignored.',
    float: `Numbers may differ by up to ${c.eps ?? 1e-6}.`,
    testlib: 'Any valid answer is accepted (special checker).',
  })[c.kind];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      <Copy className="size-3.5" aria-hidden />
      {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

/** Left side of S05: header, statement and samples with Copy and "Run this sample". */
export function StatementPane({
  problem,
  onRunSample,
  canRun,
  canary,
}: {
  problem: ProblemDetail;
  onRunSample: (n: number) => void;
  canRun: boolean;
  /** IN-02: text for automated assistants only. Hidden from the eye and from screen readers (docs/adr/016-canary-text.md). */
  canary?: string | null;
}) {
  return (
    <article className="flex flex-col gap-4 p-4" aria-label="Problem statement">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-text-2">
          <span>
            Time <span className="font-mono">{problem.limits.timeMs} ms</span>
          </span>
          <span>
            Memory <span className="font-mono">{problem.limits.memMb} MB</span>
          </span>
          <span>
            Rating <span className="font-mono">{problem.difficulty}</span>
          </span>
          <span>{checkerText(problem.checker)}</span>
          {problem.hasEditorial ? (
            <Link href={`/p/${problem.slug}/editorial`} className="text-accent underline">
              Editorial
            </Link>
          ) : null}
        </div>
        <ul className="flex flex-wrap gap-1" aria-label="Tags">
          {problem.tags.map((t) => (
            <li key={t} className="rounded-sm bg-surface-3 px-1.5 text-12 text-text-2">
              {t}
            </li>
          ))}
        </ul>
      </header>

      {/* The page already shows the title as its h1, so the statement's own `# Title` is dropped. */}
      <Markdown source={problem.statementMd.replace(/^\s*# .*\n+/, '')} />
      {canary ? (
        <p aria-hidden="true" data-canary className="sr-only">
          {canary}
        </p>
      ) : null}

      <section aria-label="Samples" className="flex flex-col gap-3">
        <h2 className="text-16 font-semibold">Samples</h2>
        {problem.samples.map((s, i) => (
          <div key={i} className="rounded-lg border border-border-strong">
            <div className="flex items-center justify-between border-b border-border px-3 py-1">
              <h3 className="text-13 font-medium">Sample {i + 1}</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRunSample(i + 1)}
                disabled={!canRun}
                title={canRun ? undefined : 'Sign in to run code'}
              >
                <Play className="size-3.5" aria-hidden />
                Run this sample
              </Button>
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-2">
              {(
                [
                  ['Input', s.in],
                  ['Output', s.out],
                ] as const
              ).map(([name, body]) => (
                <div key={name} className="bg-surface-1 p-3">
                  <div className="mb-1 flex items-center justify-between text-12 text-text-3">
                    {name}
                    <CopyButton text={body} label={`Copy sample ${i + 1} ${name.toLowerCase()}`} />
                  </div>
                  <pre className="relative relative overflow-x-auto font-mono text-13">{body}</pre>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </article>
  );
}
