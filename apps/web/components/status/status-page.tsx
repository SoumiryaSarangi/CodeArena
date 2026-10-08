'use client';
import type { PlatformStatus } from '@codearena/contracts';
import { AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { usePlatformStatus } from '@/lib/status';
import { Architecture } from './architecture';

const POLL_MS = 5000;
const REPO = 'https://github.com/SoumiryaSarangi/CodeArena';
/** Number of sandbox attack cases in `tests/attack-suite/cases` (FR-JUDGE-10 asks for at least 25). */
export const ATTACK_CASES = 28;

const STATE = {
  ok: { word: 'Operational', Icon: CheckCircle2, cls: 'text-success' },
  degraded: { word: 'Degraded', Icon: AlertTriangle, cls: 'text-warning' },
  down: { word: 'Down', Icon: XCircle, cls: 'text-danger' },
  planned: { word: 'Not released', Icon: Clock, cls: 'text-text-3' },
} as const;

const HEADLINE = {
  ok: 'All systems operational',
  degraded: 'Some systems are degraded',
  down: 'Judging is down',
} as const;

const secs = (ms: number | null) =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-16 font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Live({ s }: { s: PlatformStatus }) {
  const o = STATE[s.overall];
  return (
    <>
      <div
        role="status"
        className="flex items-center gap-3 rounded-md border border-border-strong bg-surface-1 px-4 py-3"
      >
        <o.Icon className={cn('size-5 shrink-0', o.cls)} aria-hidden />
        <p className="text-16 font-medium">{HEADLINE[s.overall]}</p>
        <p className="ml-auto text-12 text-text-3">
          Updated {new Date(s.serverNow).toLocaleTimeString()}
        </p>
      </div>

      <ul
        aria-label="Components"
        className="flex flex-col divide-y divide-border-strong/60 rounded-md border border-border-strong"
      >
        {s.components.map((c) => {
          const st = STATE[c.state];
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <st.Icon className={cn('size-4 shrink-0', st.cls)} aria-hidden />
              <span className="min-w-28 text-14 font-medium">{c.label}</span>
              <span className={cn('text-13 font-medium', st.cls)}>{st.word}</span>
              <span className="text-13 text-text-2 sm:ml-auto">{c.detail}</span>
            </li>
          );
        })}
      </ul>

      <dl className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Right now">
        <Tile label="Verdict time p50 (15 min)">{secs(s.p50Ms)}</Tile>
        <Tile label="Verdict time p95 (15 min)">{secs(s.p95Ms)}</Tile>
        <Tile label="Submissions judged">{s.totals.submissionsJudged.toLocaleString()}</Tile>
        <Tile label="Contests hosted">{s.totals.contestsHosted.toLocaleString()}</Tile>
      </dl>
      <p className="text-13 text-text-2">
        Waiting in queue:{' '}
        {s.queue.map((q, i) => (
          <span key={q.lane}>
            {i > 0 ? ' · ' : ''}
            {q.lane} <span className="font-mono">{q.depth}</span>
          </span>
        ))}
      </p>
    </>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-strong px-3 py-2">
      <dt className="text-12 text-text-3">{label}</dt>
      <dd className="font-mono text-16 tabular-nums">{children}</dd>
    </div>
  );
}

const STEPS = [
  [
    'You submit',
    'The API checks you may submit, stores your code in Postgres and puts a job on a queue in Redis. Contest jobs have their own lane and are picked first.',
  ],
  [
    'A judge picks it up',
    'A worker on a separate private network takes the job. It holds no database password and has no internet: it can only talk to Redis and read the tests.',
  ],
  [
    'It runs in a sandbox',
    'Your code is compiled and run inside an isolate sandbox: its own box, no network, no other process or file visible, with hard limits on time, memory and output.',
  ],
  [
    'The checker decides',
    'Each test output is compared with the expected answer by the problem’s checker (exact, tokens, numbers within a tolerance, or a custom one). The first failing test names the verdict.',
  ],
  [
    'The verdict streams back',
    'The result goes back through Redis; the API stores it and pushes it to your browser and to the scoreboard live. The same submission can later be rejudged and the newer verdict wins.',
  ],
] as const;

/** S18: the public status page: live health, how it is built, how it is protected. */
/** Measured by the O-03 burst test (docs/METRICS.md), 8 Oct 2026, production judges. */
const LOAD_TEST = [
  { judges: '1', wait: '26.1 s / 48.6 s', verdict: '26.6 s / 50.8 s', drain: '58 s' },
  { judges: '2', wait: '0.0 s / 0.5 s', verdict: '0.4 s / 2.1 s', drain: '2 s' },
];

export function StatusPage() {
  const s = usePlatformStatus(POLL_MS);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 py-6">
      <header>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">Status</h1>
        <p className="text-14 text-text-2">
          Live health of CodeArena, and how judging works under the hood.
        </p>
      </header>

      <Section id="health" title="Health">
        {s === null ? (
          <Skeleton className="h-64 w-full" />
        ) : s === 'error' ? (
          <div role="status" className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-16 font-medium text-danger">
              <XCircle className="size-5" aria-hidden /> Status unavailable
            </p>
            <ErrorState message="The status service did not answer. If other pages work, this is probably short; if nothing loads, the API is down." />
          </div>
        ) : (
          <Live s={s} />
        )}
      </Section>

      <Section id="how" title="How judging works">
        <ol className="flex flex-col gap-3">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="flex gap-3">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong font-mono text-12"
                aria-hidden
              >
                {i + 1}
              </span>
              <p className="text-14 leading-6">
                <strong className="font-medium">{title}.</strong>{' '}
                <span className="text-text-2">{text}</span>
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="arch" title="Architecture">
        <Architecture />
      </Section>

      <Section id="security" title="Security">
        <p className="text-14 text-text-2">
          Untrusted code is the whole point of an online judge, so the sandbox is attacked on
          purpose every night:{' '}
          <strong className="font-medium text-text">{ATTACK_CASES} attack programs</strong> (fork
          bombs, memory and disk floods, network access, reading other boxes or the host, escape
          attempts) must all be stopped on a real judge VM. The result of the last run:
        </p>
        <p>
          <a
            href={`${REPO}/actions/workflows/nightly-attack.yml`}
            className="inline-flex items-center gap-2 underline"
          >
            <img
              src={`${REPO}/actions/workflows/nightly-attack.yml/badge.svg`}
              alt="Nightly sandbox attack suite: result of the last run"
              height={20}
              width={150}
            />
            <span className="text-13">Nightly runs on GitHub</span>
          </a>
        </p>
      </Section>

      <Section id="load" title="Load test">
        <p className="text-14 text-text-2">
          500 submissions in 2 minutes (about 4 a second, C++ and Python, accepted, wrong, too slow
          and crashing programs) from 150 test accounts, with 200 live listeners on the scoreboard.
          Measured on the production judges on 8 October 2026; every submission got its verdict.
        </p>
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          role="region"
          aria-label="Burst test results"
          tabIndex={0}
        >
          <table className="w-full min-w-[32rem] text-14">
            <caption className="sr-only">Burst test results by number of judge servers</caption>
            <thead>
              <tr className="text-left text-13 text-text-2">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Judge servers
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Wait in the queue (median / 95th)
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Submit to verdict (median / 95th)
                </th>
                <th scope="col" className="py-1 font-medium">
                  Queue empty after the last submit
                </th>
              </tr>
            </thead>
            <tbody>
              {LOAD_TEST.map((r) => (
                <tr key={r.judges} className="border-t border-border">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                    {r.judges}
                  </th>
                  <td className="py-1.5 pr-3 font-mono">{r.wait}</td>
                  <td className="py-1.5 pr-3 font-mono">{r.verdict}</td>
                  <td className="py-1.5 font-mono">{r.drain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-13 text-text-3">
          The test problems are quick to judge (about half a second a submission). A contest with
          heavier problems takes longer, which is why a second judge runs during contests. Full
          numbers are in the project&apos;s metrics file.
        </p>
      </Section>
    </div>
  );
}
