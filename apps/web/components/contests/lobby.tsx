'use client';
import type { ContestDetail, ContestProblemList, ContestState } from '@codearena/contracts';
import { CalendarPlus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Timer } from '@/components/timer';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { ApiError, type ApiError as ApiErrorType } from '@/lib/api';
import {
  formatCountdown,
  formatSpan,
  formatWhen,
  icsFile,
  useNow,
  useServerClock,
} from '@/lib/contest-time';
import { contestDetail, contestProblems, registerForContest } from '@/lib/contests';
import { signInHref, useSession } from '@/lib/session';
import { StateLabel } from './state-label';

const LANG_NAMES: Record<string, string> = {
  c: 'C',
  cpp17: 'C++17',
  cpp20: 'C++20',
  python3: 'Python 3',
  java21: 'Java 21',
  node: 'JavaScript',
};

/** S08: countdown, rules, registration, and (once readable) the problem list. */
export function ContestLobby({ slug }: { slug: string }) {
  const { session } = useSession();
  const path = usePathname();
  const [c, setC] = useState<ContestDetail | null>(null);
  const [problems, setProblems] = useState<ContestProblemList | null>(null);
  const [error, setError] = useState<ApiErrorType | null>(null);
  const [regError, setRegError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announce, setAnnounce] = useState('');

  const offset = useServerClock(c?.serverNow);
  const now = useNow(offset);

  useEffect(() => {
    if (session.status === 'loading') return;
    const ctl = new AbortController();
    contestDetail(slug, ctl.signal)
      .then((r) => {
        setC(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiErrorType);
      });
    return () => ctl.abort();
  }, [slug, attempt, session.status]);

  // The state the page shows follows the server-adjusted clock, so the arena opens at the start
  // without a reload (US-4.2); the response is re-fetched right after to learn the rest.
  let state: ContestState | null = c?.state ?? null;
  if (c && state === 'scheduled' && now >= Date.parse(c.startsAt)) state = 'running';
  if (c && state === 'running' && now >= Date.parse(c.endsAt)) state = 'ended';

  const fetched = c?.state;
  const seen = useRef<ContestState | null>(null);
  useEffect(() => {
    if (!state) return;
    if (seen.current === 'scheduled' && state === 'running') setAnnounce('Contest started');
    if (seen.current === 'running' && state === 'ended') setAnnounce('Contest ended');
    seen.current = state;
    if (fetched && state !== fetched) {
      const t = setTimeout(() => setAttempt((n) => n + 1), 700);
      return () => clearTimeout(t);
    }
  }, [state, fetched]);

  const open = state === 'running' || state === 'ended' || state === 'finalized';
  const registered = c?.registered ?? false;
  useEffect(() => {
    if (!open || session.status === 'loading') return;
    const ctl = new AbortController();
    contestProblems(slug, ctl.signal)
      .then(setProblems)
      .catch(() => setProblems(null)); // 403 until registered, 404 before the start: both mean "not yet"
    return () => ctl.abort();
  }, [slug, open, registered, session.status]);

  const register = useCallback(async () => {
    setRegistering(true);
    setRegError(null);
    try {
      setC(await registerForContest(slug));
    } catch (e) {
      setRegError(e instanceof ApiError ? e.message : 'Could not register. Try again.');
    } finally {
      setRegistering(false);
    }
  }, [slug]);

  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such contest." />
    ) : (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!c || !state) return <Skeleton className="h-64 w-full" />;

  const startsIn = (Date.parse(c.startsAt) - now) / 1000;
  const downloadIcs = () => {
    const blob = new Blob([icsFile(c, window.location.href)], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${c.slug}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <StateLabel state={state} />
        <h1 className="text-24 font-semibold tracking-[-0.01em]">{c.title}</h1>
        {c.description ? (
          <p className="whitespace-pre-line text-14 text-text-2">{c.description}</p>
        ) : null}
      </div>

      {state === 'scheduled' ? (
        <div className="flex flex-col gap-1">
          <span className="text-13 text-text-2">Starts in</span>
          <span className="font-mono text-32 tabular-nums sm:text-48" aria-hidden>
            {formatCountdown(startsIn)}
          </span>
          <span className="sr-only">Starts {formatWhen(c.startsAt)}</span>
        </div>
      ) : state === 'running' ? (
        <div className="flex flex-col gap-1">
          <span className="text-13 text-text-2">Ends in</span>
          <Timer endsAt={Date.parse(c.endsAt) - offset} className="text-32 sm:text-48" />
        </div>
      ) : null}
      <span role="status" className="sr-only">
        {announce}
      </span>

      <div className="flex flex-wrap items-center gap-3">
        {registered ? (
          <span className="text-14 font-medium text-v-ac">You are registered</span>
        ) : session.status === 'guest' ? (
          <Button asChild variant="primary">
            <Link href={signInHref(path)}>Sign in to register</Link>
          </Button>
        ) : state !== 'ended' && state !== 'finalized' ? (
          <Button
            variant="primary"
            onClick={register}
            loading={registering}
            disabled={session.status !== 'authed' || !c.canRegister}
          >
            Register
          </Button>
        ) : null}
        {!registered && !c.canRegister && state === 'running' ? (
          <span className="text-13 text-text-2">Registration closed when the contest started.</span>
        ) : null}
        {state === 'scheduled' ? (
          <Button variant="ghost" onClick={downloadIcs}>
            <CalendarPlus className="size-4" aria-hidden /> Add to calendar
          </Button>
        ) : null}
      </div>
      {regError ? (
        <p role="alert" className="text-13 text-danger">
          {regError}
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-14">
        <dt className="text-text-2">Starts</dt>
        <dd>{formatWhen(c.startsAt)}</dd>
        <dt className="text-text-2">Ends</dt>
        <dd>{formatWhen(c.endsAt)}</dd>
        <dt className="text-text-2">Duration</dt>
        <dd>{formatSpan(c.startsAt, c.endsAt)}</dd>
        {c.freezeAt ? (
          <>
            <dt className="text-text-2">Scoreboard freeze</dt>
            <dd>
              {formatSpan(c.freezeAt, c.endsAt)} before the end ({formatWhen(c.freezeAt)})
            </dd>
          </>
        ) : null}
        <dt className="text-text-2">Problems</dt>
        <dd>{c.problemCount}</dd>
        <dt className="text-text-2">Registered</dt>
        <dd>{c.registeredCount}</dd>
      </dl>

      <section aria-labelledby="rules" className="flex flex-col gap-2">
        <h2 id="rules" className="text-16 font-medium">
          Rules
        </h2>
        <ul className="list-disc pl-5 text-14 text-text-2">
          <li>
            Ranked by problems solved, then penalty, then the time of the last accepted solution.
            Equal results share a rank.
          </li>
          <li>
            Penalty: minutes from the start to the first accepted solution, plus{' '}
            {c.rules.penaltyMinutes} for each rejected attempt before it.{' '}
            {c.rules.ceCountsAsAttempt
              ? 'Compile errors count as rejected attempts.'
              : 'Compile errors do not count as rejected attempts.'}
          </li>
          <li>
            Time limits are multiplied by language:{' '}
            {Object.entries(c.rules.langMultipliers)
              .map(([l, m]) => `${LANG_NAMES[l] ?? l} ×${m}`)
              .join(', ')}
            .
          </li>
          <li>
            {c.rules.lateRegistration
              ? 'You can register until the contest ends.'
              : 'Registration closes when the contest starts.'}{' '}
            {c.rules.rated ? 'The contest is rated.' : 'The contest is unrated.'}
          </li>
        </ul>
      </section>

      {open ? (
        <section aria-labelledby="problems" className="flex flex-col gap-2">
          <h2 id="problems" className="text-16 font-medium">
            Problems
          </h2>
          {problems ? (
            <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
              {problems.items.map((p) => (
                <li key={p.label} className="flex items-baseline gap-3 px-3 py-2 text-14">
                  <span className="w-5 font-mono font-medium">{p.label}</span>
                  {state === 'ended' || state === 'finalized' ? (
                    <Link href={`/p/${p.slug}`} className="hover:underline">
                      {p.title}
                    </Link>
                  ) : (
                    <span>{p.title}</span>
                  )}
                  <span className="ml-auto font-mono text-13 text-text-2">
                    {p.limits.timeMs} ms · {p.limits.memMb} MB
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-14 text-text-2">
              {registered
                ? 'Loading the problems…'
                : 'Register to see the problems while the contest runs.'}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
