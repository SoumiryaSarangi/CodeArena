'use client';
import type { AdminContestList, PlagRunList } from '@codearena/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionError } from '@/components/admin/problem-errors';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { formatWhen } from '@/lib/contest-time';
import { adminContests } from '@/lib/contests';
import { plagRuns, startPlagRun } from '@/lib/plag';

const RUN_TEXT = {
  queued: 'Waiting for the job',
  running: 'Checking',
  done: 'Done',
  failed: 'Failed',
} as const;

/** Admin → Integrity: past runs, and a way to start a check for a contest that is over. */
export function IntegrityRuns() {
  const router = useRouter();
  const [runs, setRuns] = useState<PlagRunList | null>(null);
  const [contests, setContests] = useState<AdminContestList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pick, setPick] = useState('');
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  const load = (signal?: AbortSignal) =>
    Promise.all([plagRuns(signal), adminContests(signal)])
      .then(([r, c]) => {
        setRuns(r);
        setContests(c);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, []);

  if (error) return <ErrorState message={error.message} requestId={error.requestId} />;
  if (!runs || !contests) return <Skeleton className="h-48 w-full" />;

  const over = contests.items.filter((c) => c.state === 'ended' || c.state === 'finalized');
  const title = (id: string) => contests.items.find((c) => c.id === id)?.title ?? 'Contest';

  const start = async () => {
    setStarting(true);
    setFailure(null);
    try {
      const made = await startPlagRun(pick);
      router.push(`/admin/integrity/${made.id}`);
    } catch (e) {
      setFailure(e as Error);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Integrity</h1>
      <section className="flex flex-col gap-2" aria-labelledby="start-check">
        <h2 id="start-check" className="text-16 font-medium">
          Check a contest for similar submissions
        </h2>
        <p className="text-13 text-text-2">
          Compares each person&apos;s final submission per problem. It flags submissions for a
          person to look at; it never penalises anyone.
        </p>
        {over.length === 0 ? (
          <p className="text-13 text-text-3">No contest has ended yet.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-13 text-text-2">
              Contest
              <select
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className="h-8 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text"
              >
                <option value="">Choose a contest…</option>
                {over.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" disabled={!pick} loading={starting} onClick={start}>
              Start check
            </Button>
          </div>
        )}
        {failure ? <ActionError error={failure} /> : null}
      </section>
      <section aria-labelledby="runs-h" className="flex flex-col gap-2">
        <h2 id="runs-h" className="text-16 font-medium">
          Checks
        </h2>
        {runs.items.length === 0 ? (
          <EmptyState message="No checks yet." />
        ) : (
          <ul className="divide-y divide-border-strong rounded-md border border-border-strong">
            {runs.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-14">
                <Link
                  href={`/admin/integrity/${r.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  {title(r.contestId)}
                </Link>
                <span className="text-text-2">{RUN_TEXT[r.status]}</span>
                <span className="ml-auto text-13 text-text-3">
                  {r.startedAt ? formatWhen(r.startedAt) : 'not started'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => void load()}
          className="self-start text-13 text-text-2 underline"
        >
          Refresh
        </button>
      </section>
    </div>
  );
}
