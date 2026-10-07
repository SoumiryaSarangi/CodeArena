'use client';
import type { ContestList, ContestSummary } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { formatSpan, formatWhen } from '@/lib/contest-time';
import { contestList, registerForContest } from '@/lib/contests';
import { useSession } from '@/lib/session';
import { StateLabel } from './state-label';

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
    <div className="flex max-w-4xl flex-col gap-8">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Contests</h1>
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
            <h2 className="text-16 font-medium">{s.title}</h2>
            <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
              {s.items.map((c) => (
                <li key={c.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link href={`/c/${c.slug}`} className="text-14 font-medium hover:underline">
                      {c.title}
                    </Link>
                    <span className="text-13 text-text-2">
                      {formatWhen(c.startsAt)} · {formatSpan(c.startsAt, c.endsAt)} ·{' '}
                      {c.problemCount} problems · {c.registeredCount} registered
                    </span>
                  </div>
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
                  <Button asChild size="sm" variant="secondary">
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
