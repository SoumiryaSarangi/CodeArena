'use client';
import type { ContestList, ContestSummary } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import {
  formatCountdown,
  formatSpan,
  formatWhen,
  useNow,
  useServerClock,
} from '@/lib/contest-time';
import { contestList, registerForContest } from '@/lib/contests';
import { useSession } from '@/lib/session';
import { StateLabel } from './state-label';

/** The clock of one row: time to the start, or to the end while it runs (mono, from the server's clock). */
function RowClock({ c }: { c: ContestSummary }) {
  const offset = useServerClock(undefined);
  const now = useNow(offset);
  if (c.state === 'scheduled') {
    const secs = Math.floor((Date.parse(c.startsAt) - now) / 1000);
    return secs > 0 ? (
      <span className="font-mono text-13 tabular-nums text-text-2">
        starts in {formatCountdown(secs)}
      </span>
    ) : null;
  }
  if (c.state === 'running') {
    const secs = Math.floor((Date.parse(c.endsAt) - now) / 1000);
    return secs > 0 ? (
      <span className="font-mono text-13 tabular-nums text-text-2">
        ends in {formatCountdown(secs)}
      </span>
    ) : null;
  }
  return null;
}

/** S07: Running now, Upcoming, Past. */
export function ContestListView() {
  const { session } = useSession();
  const [data, setData] = useState<ContestList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [regError, setRegError] = useState<string | null>(null);

  useEffect(() => {
    if (session.status === 'loading') return;
    const ctl = new AbortController();
    contestList(ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [attempt, session.status]);

  const register = useCallback(async (slug: string) => {
    setBusy(slug);
    setRegError(null);
    try {
      await registerForContest(slug);
      setAttempt((n) => n + 1);
    } catch (e) {
      setRegError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  if (error) {
    return (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!data) return <Skeleton className="h-64 w-full" />;

  const by = (...s: ContestSummary['state'][]) => data.items.filter((c) => s.includes(c.state));
  const sections = [
    { title: 'Running now', items: by('running') },
    { title: 'Upcoming', items: by('scheduled').reverse() },
    { title: 'Past', items: by('ended', 'finalized') },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8">
      <h1 className="text-28 font-semibold tracking-[-0.01em]">Contests</h1>
      {regError ? (
        <p role="alert" className="text-13 text-danger">
          {regError}
        </p>
      ) : null}
      {data.items.length === 0 ? <EmptyState message="No contests yet." /> : null}
      {sections
        .filter((s) => s.items.length > 0)
        .map((s) => (
          <section key={s.title} aria-label={s.title} className="flex flex-col gap-2">
            <h2 className="text-22 font-semibold">{s.title}</h2>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
              {s.items.map((c) => (
                <li key={c.slug} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link
                      href={`/c/${c.slug}`}
                      className="break-words text-16 font-medium hover:underline"
                    >
                      {c.title}
                    </Link>
                    <span className="text-13 text-text-2">
                      {formatWhen(c.startsAt)} · {formatSpan(c.startsAt, c.endsAt)} ·{' '}
                      {c.problemCount} problems · {c.registeredCount} registered
                    </span>
                  </div>
                  <RowClock c={c} />
                  <StateLabel state={c.state} />
                  {c.registered ? (
                    <span className="text-13 font-medium text-v-ac">Registered</span>
                  ) : c.state === 'scheduled' || c.state === 'running' ? (
                    session.status === 'authed' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === c.slug}
                        onClick={() => register(c.slug)}
                        aria-label={`Register for ${c.title}`}
                      >
                        Register
                      </Button>
                    ) : null
                  ) : null}
                  {c.state !== 'scheduled' ? (
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/c/${c.slug}/board`} aria-label={`Standings of ${c.title}`}>
                        Standings
                      </Link>
                    </Button>
                  ) : null}
                  {/* One filled action per row: Register, or Enter while it runs and you are in. */}
                  <Button
                    asChild
                    size="sm"
                    variant={c.state === 'running' && c.registered ? 'primary' : 'ghost'}
                  >
                    <Link
                      href={`/c/${c.slug}`}
                      aria-label={`${c.state === 'running' ? 'Enter' : 'Open'} ${c.title}`}
                    >
                      {c.state === 'running' ? 'Enter' : 'Open'}
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
