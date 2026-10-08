'use client';
import type { BoardSnapshot, ContestDetail } from '@codearena/contracts';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { boardSnapshot, contestDetail } from '@/lib/contests';
import { cn } from '@/lib/cn';
import { finish, nextStep, startResolver, type Resolver, type Step } from '@/lib/resolver';
import { useSession } from '@/lib/session';
import { ScoreCell } from './score-cell';

/** UI_UX §S10: one reveal per 1.2 s in auto mode. */
const AUTO_MS = 1200;

/**
 * The resolver ceremony (C-06, FR-BOARD-06): the admin's full-screen presenter view. It starts from
 * the frozen board and reveals the pending cells one by one from the bottom rank upwards, using the
 * pure stepper in `lib/resolver.ts`. Space = next, A = auto, Esc = leave. Only the admin's screen
 * needs the state (it is shared), so nothing is stored on the server.
 */
export function ResolverView({ slug }: { slug: string }) {
  const { session } = useSession();
  const reduce = useReducedMotion();
  const [contest, setContest] = useState<ContestDetail | null>(null);
  const [initial, setInitial] = useState<Resolver | null>(null);
  const [state, setState] = useState<Resolver | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const stateRef = useRef<Resolver | null>(null);
  stateRef.current = state;

  const me = session.status === 'authed' ? session.me : null;
  const admin = me?.role === 'admin';

  const load = useCallback(() => {
    const ctl = new AbortController();
    Promise.all([
      contestDetail(slug, ctl.signal),
      boardSnapshot(slug, ctl.signal, 'frozen'),
      boardSnapshot(slug, ctl.signal),
    ])
      .then(([c, frozen, live]: [ContestDetail, BoardSnapshot, BoardSnapshot]) => {
        const r = startResolver(frozen, live, c.rules.penaltyMinutes);
        setContest(c);
        setInitial(r);
        setState(r);
        setStep(null);
        setAuto(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [slug]);

  useEffect(() => {
    if (session.status === 'loading' || !admin) return;
    return load();
  }, [session.status, admin, load]);

  const next = useCallback(() => {
    const cur = stateRef.current;
    if (!cur) return;
    const n = nextStep(cur);
    if (!n) {
      setAuto(false);
      return;
    }
    setState(n.state);
    setStep(n.step);
  }, []);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(next, AUTO_MS);
    return () => clearInterval(t);
  }, [auto, next]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      const onButton = el?.tagName === 'BUTTON' || el?.tagName === 'A';
      if (e.key === ' ' && !onButton) {
        e.preventDefault();
        next();
      } else if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setAuto((v) => !v);
      } else if (e.key === 'Escape') {
        window.location.assign(`/c/${slug}/board`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, slug]);

  if (session.status !== 'loading' && !admin) {
    return <EmptyState message="Only admins can run the resolver." />;
  }
  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such contest." />
    ) : (
      <ErrorState message={error.message} requestId={error.requestId} onRetry={load} />
    );
  }
  if (!contest || !state || !initial) return <Skeleton className="h-96 w-full" />;

  const done = state.revealed >= state.total;
  const labels = state.labels;
  const focus = step?.userId;
  const who = step ? state.rows.find((r) => r.userId === step.userId) : undefined;
  const status = done
    ? state.total === 0
      ? 'Nothing was hidden by the freeze.'
      : 'Final standings.'
    : `Revealing ${state.revealed}/${state.total}`;
  const said =
    who && step
      ? `${who.handle}, problem ${step.label}: ${step.solved ? 'accepted' : 'not accepted'}${
          step.rankAfter !== step.rankBefore ? `, now rank ${step.rankAfter}` : ''
        }`
      : '';

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-4 overflow-auto bg-bg p-6 text-text">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-16 font-medium text-warning">{done ? 'Final' : 'Resolving'}</span>
          <h1 className="text-32 font-semibold tracking-[-0.01em]">{contest.title}</h1>
        </div>
        <p role="status" className="ml-auto font-mono text-20 tabular-nums">
          {status}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={next} disabled={done}>
          Next reveal (Space)
        </Button>
        <Button variant="secondary" onClick={() => setAuto((v) => !v)} disabled={done}>
          {auto ? 'Pause (A)' : 'Auto (A)'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setAuto(false);
            setState(finish(stateRef.current!));
          }}
          disabled={done}
        >
          Skip to final
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setState(initial);
            setStep(null);
            setAuto(false);
          }}
        >
          Start over
        </Button>
        <Button asChild variant="ghost">
          <Link href={`/c/${slug}/board`}>Exit (Esc)</Link>
        </Button>
        <span aria-live="polite" className="ml-2 text-16 text-text-2">
          {said}
        </span>
      </div>
      {state.rows.length === 0 ? (
        <EmptyState message="Nobody registered." />
      ) : (
        <table className="w-full border-separate border-spacing-0 text-20">
          <caption className="sr-only">Standings during the resolver ceremony</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(TH, 'w-16 text-right')}>
                Rank
              </th>
              <th scope="col" className={cn(TH, 'text-left')}>
                Handle
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Solved
              </th>
              <th scope="col" className={cn(TH, 'text-right')}>
                Penalty
              </th>
              {labels.map((l) => (
                <th key={l} scope="col" className={cn(TH, 'text-center font-mono')}>
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r) => (
              <motion.tr
                key={r.userId}
                layout={reduce ? false : 'position'}
                transition={{ type: 'spring', duration: 0.5, bounce: 0.1 }}
                className={cn(focus === r.userId && 'bg-surface-2')}
                aria-current={focus === r.userId ? 'true' : undefined}
              >
                <td className={cn(TD, 'text-right font-mono tabular-nums')}>{r.rank}</td>
                <th scope="row" className={cn(TD, 'text-left font-mono font-medium')}>
                  {r.handle}
                </th>
                <td className={cn(TD, 'text-right font-mono tabular-nums')}>{r.solved}</td>
                <td className={cn(TD, 'text-right font-mono tabular-nums')}>{r.penalty}</td>
                {labels.map((l) => (
                  <td key={l} className={cn(TD, 'text-center')}>
                    <ScoreCell
                      cell={r.cells[l]}
                      flash={focus === r.userId && step?.label === l && step.solved}
                    />
                  </td>
                ))}
              </motion.tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TH = 'border-b border-border-strong px-4 py-3 text-16 font-medium text-text-2';
const TD = 'h-12 border-b border-border-strong/60 px-4 align-middle';
