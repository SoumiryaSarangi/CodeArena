'use client';
import type { RunResult, SubmissionList } from '@codearena/contracts';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VerdictBadge } from '@/components/verdict-badge';
import { VerdictGrid } from '@/components/verdict-grid';
import { formatMemKb } from '@/lib/format';
import { lineDiff } from '@/lib/line-diff';
import { gridTests, queueLine, type LiveSubmission } from '@/lib/live-submission';
import { verdictTitle } from '@/lib/verdicts';
import type { RunView } from './use-judging';

export type DrawerTab = 'console' | 'tests' | 'submissions' | 'coach';
export const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: 'console', label: 'Console' },
  { id: 'tests', label: 'Tests' },
  { id: 'submissions', label: 'Submissions' },
  { id: 'coach', label: 'Coach' },
];

const Block = ({ title, text }: { title: string; text: string }) => (
  <div>
    <h4 className="mb-1 text-12 text-text-3">{title}</h4>
    <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-13 whitespace-pre-wrap">
      {text === '' ? '(empty)' : text}
    </pre>
  </div>
);

function RunCard({ run }: { run: RunView }) {
  const r: RunResult | undefined = run.result;
  return (
    <section aria-label={run.label} className="rounded-lg border border-border-strong p-3">
      <h3 className="mb-2 flex flex-wrap items-center gap-2 text-13 font-medium">
        {run.label}
        {run.status === 'queued' ? <VerdictBadge verdict="pending" /> : null}
        {run.status === 'failed' ? (
          <span className="text-danger">Could not run. Try again.</span>
        ) : null}
        {r?.verdict ? <VerdictBadge verdict={r.verdict} /> : null}
        {r?.timeMs != null ? (
          <span className="font-mono text-12 text-text-3">
            {r.timeMs} ms · {formatMemKb(r.memKb ?? 0)}
          </span>
        ) : null}
        {r?.matches === true ? (
          <span className="text-12 text-v-ac">Matches the expected output</span>
        ) : null}
        {r?.matches === false ? (
          <span className="text-12 text-v-wa">Differs from the expected output</span>
        ) : null}
      </h3>
      {r ? (
        <div className="flex flex-col gap-2">
          {r.compileLog ? <Block title="Compiler output" text={r.compileLog} /> : null}
          {r.expected !== null && r.output !== null && r.matches === false ? (
            <table className="w-full text-13" aria-label="Expected and your output, line by line">
              <thead>
                <tr className="text-left text-12 text-text-3">
                  <th className="w-10 font-normal">Line</th>
                  <th className="font-normal">Expected</th>
                  <th className="font-normal">Yours</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {lineDiff(r.expected, r.output).map((l) => (
                  <tr key={l.no} className={l.same ? '' : 'bg-v-wa/14'}>
                    <td className="text-text-3">{l.no}</td>
                    <td>{l.expected ?? '(missing)'}</td>
                    <td>
                      {l.actual ?? '(missing)'}
                      {l.same ? null : <span className="sr-only"> (differs)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : r.output !== null ? (
            <Block title="Output" text={r.output} />
          ) : null}
          {r.stderr ? <Block title="Errors (stderr)" text={r.stderr} /> : null}
        </div>
      ) : null}
    </section>
  );
}

export function ConsoleTab({
  runs,
  input,
  onInput,
  onRunInput,
  onRunSamples,
  running,
  samplesCount,
}: {
  runs: RunView[];
  input: string;
  onInput: (s: string) => void;
  onRunInput: () => void;
  onRunSamples: () => void;
  running: boolean;
  samplesCount: number;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="custom-input" className="text-13 text-text-2">
          Custom input
        </label>
        <textarea
          id="custom-input"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          rows={3}
          spellCheck={false}
          className="rounded-md border border-border-control bg-surface-1 p-2 font-mono text-13 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onRunInput} disabled={running}>
            Run with this input
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRunSamples}
            disabled={running || samplesCount === 0}
          >
            Run all samples
          </Button>
        </div>
      </div>
      <div aria-live="polite" className="flex flex-col gap-3">
        {runs.length === 0 ? (
          <p className="text-13 text-text-3">Run your code to see its output here.</p>
        ) : (
          runs.map((r) => <RunCard key={r.id} run={r} />)
        )}
      </div>
    </div>
  );
}

export function TestsTab({
  live,
  submitting,
  connectionHint,
}: {
  live: LiveSubmission | null;
  submitting: boolean;
  connectionHint?: string;
}) {
  if (!live) return <EmptyState message="Submit your code to see the result of every test here." />;
  const realId = live.id !== 'pending';
  const done = live.phase === 'done' && live.verdict;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        {done ? (
          <>
            <VerdictBadge verdict={live.verdict!} test={live.failedTest ?? undefined} />
            <span className="text-14">
              {verdictTitle(live.verdict!, live.failedTest ?? undefined)}
            </span>
            {live.timeMs !== undefined ? (
              <span className="font-mono text-12 text-text-3">
                {live.timeMs} ms · {formatMemKb(live.memKb ?? 0)}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <VerdictBadge verdict="pending" />
            <span role="status" className="font-mono text-13 text-text-2">
              {submitting && !realId ? 'Submitting…' : queueLine(live)}
            </span>
          </>
        )}
        {realId ? (
          <Link href={`/s/${live.id}`} className="ml-auto text-13 text-accent underline">
            Details →
          </Link>
        ) : null}
      </div>
      {connectionHint ? <p className="text-12 text-text-3">{connectionHint}</p> : null}
      <VerdictGrid
        tests={gridTests(live)}
        finalAnnouncement={
          done ? verdictTitle(live.verdict!, live.failedTest ?? undefined) : undefined
        }
      />
    </div>
  );
}

export function SubmissionsTab({
  items,
  signedIn,
}: {
  items: SubmissionList['items'] | null;
  signedIn: boolean;
}) {
  if (!signedIn) return <EmptyState message="Sign in to see your submissions." />;
  if (items === null) return <p className="p-3 text-13 text-text-3">Loading…</p>;
  if (items.length === 0) return <EmptyState message="No submissions for this problem yet." />;
  return (
    <table className="w-full text-13">
      <caption className="sr-only">My submissions for this problem</caption>
      <thead className="text-left text-12 text-text-3">
        <tr>
          <th className="px-3 py-1 font-normal">When</th>
          <th className="px-3 py-1 font-normal">Language</th>
          <th className="px-3 py-1 font-normal">Verdict</th>
          <th className="px-3 py-1 text-right font-normal">Time</th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <tr key={s.id} className="border-t border-border">
            <td className="px-3 py-1">
              <Link href={`/s/${s.id}`} className="underline">
                {new Date(s.createdAt).toLocaleTimeString()}
              </Link>
            </td>
            <td className="px-3 py-1">{s.language}</td>
            <td className="px-3 py-1">
              {s.verdict ? (
                <VerdictBadge verdict={s.verdict} test={s.failedTest ?? undefined} />
              ) : (
                <VerdictBadge verdict="pending" />
              )}
            </td>
            <td className="px-3 py-1 text-right font-mono">
              {s.timeMs != null ? `${s.timeMs} ms` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The four-tab drawer (UI_UX S05). `value` is controlled so Alt+1..4 can switch it. */
export function Drawer({
  value,
  onValue,
  children,
  tabs = DRAWER_TABS,
}: {
  value: DrawerTab;
  onValue: (t: DrawerTab) => void;
  children: Partial<Record<DrawerTab, React.ReactNode>>;
  /** The tabs to show, in order (a contest has no Coach, FR-CONT-08). */
  tabs?: { id: DrawerTab; label: string }[];
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onValue(v as DrawerTab)}
      className="flex size-full min-h-0 flex-col"
    >
      <TabsList aria-label="Output" className="px-3">
        {tabs.map((t, i) => (
          <TabsTrigger key={t.id} value={t.id} aria-keyshortcuts={`Alt+${i + 1}`}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="min-h-0 flex-1 overflow-auto">
          {children[t.id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
