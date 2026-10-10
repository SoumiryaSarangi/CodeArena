'use client';
import type { HomeSummary, ProfileSummary, SubmissionSummary } from '@codearena/contracts';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityHeatmap } from '@/components/profile/activity-heatmap';
import { Handle } from '@/components/handle';
import { SubmissionWire } from '@/components/submission-wire';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { VerdictBadge } from '@/components/verdict-badge';
import type { ApiError } from '@/lib/api';
import { formatCountdown, formatWhen, useNow, useServerClock } from '@/lib/contest-time';
import { homeSummary, profileSummary, recentSubmissions } from '@/lib/profile';
import { signInHref, useSession } from '@/lib/session';

function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4 md:p-5"
    >
      <h2 id={id} className="text-18 font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function NextContest({ c }: { c: NonNullable<HomeSummary['nextContest']> }) {
  const offset = useServerClock(undefined);
  const now = useNow(offset);
  const running = c.state === 'running';
  const secs = Math.floor((Date.parse(c.startsAt) - now) / 1000);
  return (
    <>
      {!running && secs > 0 ? (
        // Glanceable copy of the line below (which is the accessible one).
        <p aria-hidden className="display font-mono text-40 font-medium md:text-48">
          {formatCountdown(secs)}
        </p>
      ) : null}
      <p className="break-words text-14">
        <Link href={`/c/${c.slug}`} className="font-medium underline">
          {c.title}
        </Link>
      </p>
      <p className="text-13 text-text-2">
        {running ? 'Running now' : `Starts in ${formatCountdown(secs)}`} · {formatWhen(c.startsAt)}
      </p>
      <div className="flex items-center gap-3">
        {running ? (
          <Button asChild variant="primary">
            <Link href={`/c/${c.slug}`}>Open the contest</Link>
          </Button>
        ) : c.registered ? (
          <>
            <span className="text-13 font-medium text-v-ac">You are registered</span>
            <Button asChild variant="primary">
              <Link href={`/c/${c.slug}`}>Open the lobby</Link>
            </Button>
          </>
        ) : (
          <Button asChild variant="primary">
            <Link href={`/c/${c.slug}`}>Register</Link>
          </Button>
        )}
      </div>
    </>
  );
}

/** S03: the signed-in home. Every card that has nothing to show says so in one line. */
export function HomeView() {
  const { session } = useSession();
  const me = session.status === 'authed' ? session.me : null;
  const [home, setHome] = useState<HomeSummary | null>(null);
  const [recent, setRecent] = useState<SubmissionSummary[] | null>(null);
  const [activity, setActivity] = useState<ProfileSummary['activity'] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const handle = me?.handle ?? null;

  useEffect(() => {
    if (!me) return;
    const ctl = new AbortController();
    Promise.all([
      homeSummary(ctl.signal),
      recentSubmissions(5, ctl.signal),
      handle ? profileSummary(handle, ctl.signal).then((p) => p.activity) : Promise.resolve(null),
    ])
      .then(([h, r, a]) => {
        setHome(h);
        setRecent(r.items);
        setActivity(a);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [me, handle, attempt]);

  if (session.status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (!me) {
    return (
      <EmptyState
        message="Sign in to see your contests, practice and activity."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref('/home')}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (error) {
    return (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!home || !recent) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1120px] flex-col gap-4">
      <h1 className="break-words text-28 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
        Welcome back{handle ? ', ' : ''}
        {handle ? <Handle handle={handle} rating={me?.rating} /> : null}
      </h1>

      {home.warmUps.length > 0 ? (
        <Card id="warm" title="Start with these warm-up problems">
          <ul aria-label="Warm-up problems" className="flex flex-col gap-1">
            {home.warmUps.map((w) => (
              <li key={w.slug} className="flex items-baseline gap-3 text-14">
                <Link href={`/p/${w.slug}`} className="min-w-0 break-words underline">
                  {w.title}
                </Link>
                <span className="font-mono text-12 text-text-3">{w.difficulty}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {home.reviews ? (
        <Card id="reviews" title="Your contest reviews">
          <p className="text-14" role="status">
            {home.reviews.ready === home.reviews.total
              ? `All ${home.reviews.total} AI review${home.reviews.total === 1 ? ' is' : 's are'} ready for ${home.reviews.contestTitle}.`
              : `${home.reviews.ready} of ${home.reviews.total} AI reviews are ready for ${home.reviews.contestTitle}. The rest are being written.`}{' '}
            <Link href={`/c/${home.reviews.contestSlug}/results`} className="underline">
              Open your results
            </Link>
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <Card id="next" title="Next contest">
          {home.nextContest ? (
            <NextContest c={home.nextContest} />
          ) : (
            <p className="text-14 text-text-2">
              No contest is scheduled yet.{' '}
              <Link href="/contests" className="underline">
                See all contests
              </Link>
            </p>
          )}
        </Card>

        <Card id="continue" title="Continue practising">
          {home.continuePracticing.length === 0 ? (
            <p className="text-14 text-text-2">
              Nothing yet.{' '}
              <Link href="/practice" className="underline">
                Pick a problem
              </Link>
            </p>
          ) : (
            <ul aria-label="Recent problems" className="flex flex-col gap-1.5">
              {home.continuePracticing.map((p) => (
                <li key={p.slug} className="flex items-center gap-3 text-14">
                  <Link
                    href={`/p/${p.slug}`}
                    title={p.title}
                    className="min-w-0 truncate underline"
                  >
                    {p.title}
                  </Link>
                  <span
                    className={`ml-auto shrink-0 text-14 ${p.solved ? 'text-v-ac' : 'text-text-3'}`}
                  >
                    <span aria-hidden>{p.solved ? '✓' : '·'}</span>
                    <span className="sr-only">{p.solved ? 'Solved' : 'Not solved yet'}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card id="recent" title="Recent submissions">
        {recent.length === 0 ? (
          <p className="text-14 text-text-2">You have not submitted anything yet.</p>
        ) : (
          <ul aria-label="Recent submissions" className="flex flex-col gap-1.5">
            {recent.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5 text-14">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/p/${s.problemSlug}`} className="min-w-0 break-words underline">
                    {s.problemTitle}
                  </Link>
                  <VerdictBadge
                    verdict={s.verdict ?? 'pending'}
                    {...(s.failedTest ? { test: s.failedTest } : {})}
                  />
                  <span className="font-mono text-12 text-text-3">{s.language}</span>
                  <time className="ml-auto text-12 text-text-3" dateTime={s.createdAt}>
                    {new Date(s.createdAt).toLocaleString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <SubmissionWire verdict={s.verdict} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {activity ? (
        <Card id="activity" title="Your activity">
          <ActivityHeatmap activity={activity} compact />
        </Card>
      ) : null}
    </div>
  );
}
