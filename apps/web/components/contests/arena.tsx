'use client';
import type {
  ContestDetail,
  ContestProblemDetail,
  ContestProblemList,
  ProblemDetail,
} from '@codearena/contracts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useImmersive } from '@/components/shell/app-shell';
import { Timer } from '@/components/timer';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { WorkspaceView, useWide } from '@/components/workspace/workspace';
import { ApiError } from '@/lib/api';
import { useNow, useServerClock, formatSpan } from '@/lib/contest-time';
import { cn } from '@/lib/cn';
import { contestDetail, contestProblem, contestProblems } from '@/lib/contests';
import { signInHref, useSession } from '@/lib/session';
import { useLiveBoard } from '@/lib/use-live-board';
import { useExam } from '@/lib/exam';
import { ExamFinished, ExamGate, ExamWarning, FinishTestButton } from './exam-guard';
import { ContestMessagesButton } from './messages-button';

type Load<T> = { s: 'loading' } | { s: 'ready'; v: T } | { s: 'error'; err: ApiError };

/** What the statement pane needs, from a contest problem (no tags or rating: those would hint). */
const asProblem = (p: ContestProblemDetail): ProblemDetail => ({
  slug: p.slug,
  title: p.title,
  difficulty: p.difficulty,
  practicePoints: 0,
  version: 1,
  testsCount: p.testsCount,
  statementMd: p.statementMd,
  tags: [],
  samples: p.samples,
  limits: p.limits,
  checker: p.checker,
  hasEditorial: false, // no editorial while the contest can still be running
});

/** S09: the workspace in contest mode, inside a contest bar. */
export function ContestArena({ slug, label }: { slug: string; label: string }) {
  const { session } = useSession();
  const path = usePathname();
  const wide = useWide();
  const [contest, setContest] = useState<ContestDetail | null>(null);
  const [list, setList] = useState<ContestProblemList | null>(null);
  const [problem, setProblem] = useState<Load<ContestProblemDetail>>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [over, setOver] = useState(false);
  // The contest has the whole window while it runs (C-09); "Show menu" brings the app bars back.
  const [full, setFull] = useState(true);

  const me = session.status === 'authed' ? session.me : null;
  const ready = session.status !== 'loading';
  const offset = useServerClock(contest?.serverNow);
  const now = useNow(offset);
  const { board, refresh } = useLiveBoard(
    slug,
    me ? { id: me.id, admin: me.role === 'admin' } : null,
    ready && !!contest && contest.state !== 'scheduled',
  );

  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    setProblem({ s: 'loading' });
    Promise.all([
      contestDetail(slug, ctl.signal),
      contestProblems(slug, ctl.signal),
      contestProblem(slug, label, ctl.signal),
    ])
      .then(([c, l, p]) => {
        setContest(c);
        setList(l);
        setProblem({ s: 'ready', v: p });
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        // The lobby may still load, so the page can say why the problems are closed.
        void contestDetail(slug).then(setContest, () => undefined);
        setProblem({ s: 'error', err: e as ApiError });
      });
    return () => ctl.abort();
  }, [slug, label, ready, attempt]);

  const endsAt = contest ? Date.parse(contest.endsAt) : Infinity;
  const running = contest?.state === 'running' && now < endsAt;
  useImmersive(running && full);
  // Exam mode (C-10): contestants only, while the contest runs.
  const examActive =
    !!contest?.exam && running && !!me && me.role !== 'admin' && me.role !== 'setter';
  const exam = useExam(slug, contest?.exam, examActive);
  // "Contest over": once, when the clock passes the end while this page is open.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) wasRunning.current = true;
    else if (wasRunning.current && contest) setOver(true);
  }, [running, contest]);

  if (problem.s === 'loading' || wide === null) {
    return <Skeleton className="h-[calc(100dvh-10rem)] min-h-[32rem] w-full" />;
  }
  if (problem.s === 'error') {
    const e = problem.err;
    if (e.status === 401 || session.status === 'guest') {
      return (
        <EmptyState
          message="Sign in to take part in the contest."
          action={
            <Button asChild variant="primary">
              <Link href={signInHref(path)}>Sign in</Link>
            </Button>
          }
        />
      );
    }
    if (e.status === 403 && e.code === 'contest-finished') {
      return <ExamFinished reason={contest?.exam?.finishReason ?? exam.state.reason} slug={slug} />;
    }
    if (e.status === 403 || e.status === 404) {
      return (
        <EmptyState
          message={
            e.status === 403
              ? 'Register for the contest to see its problems.'
              : 'This problem is not available (yet).'
          }
          action={
            <Button asChild variant="secondary">
              <Link href={`/c/${slug}`}>Back to the contest</Link>
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        message={e.message}
        requestId={e.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  if (examActive && exam.state.phase === 'finished') {
    return <ExamFinished reason={exam.state.reason} slug={slug} />;
  }
  if (examActive && exam.state.phase === 'gate') {
    return (
      <ExamGate
        title={contest?.title ?? 'Test'}
        strikes={exam.state.strikes}
        onStart={exam.start}
        contestHref={`/c/${slug}`}
      />
    );
  }

  const items = list?.items ?? [];
  const at = items.findIndex((p) => p.label === label);
  const prev = at > 0 ? items[at - 1] : undefined;
  const next = at >= 0 ? items[at + 1] : undefined;
  const mine = me ? board?.rows.find((r) => r.userId === me.id) : undefined;
  const freezeAt = contest?.freezeAt ? Date.parse(contest.freezeAt) : null;
  const frozen = running && freezeAt !== null && now >= freezeAt && me?.role !== 'admin';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-strong bg-surface-1 px-3 py-2">
        <nav aria-label="Contest problems" className="flex flex-wrap items-center gap-1">
          {items.map((p) => {
            const cell = mine?.cells[p.label];
            const solvedBy = board?.problems.find((b) => b.label === p.label)?.solvedCount ?? 0;
            const state =
              cell?.acMinute != null
                ? 'solved'
                : cell && (cell.pending > 0 || cell.attempts > 0)
                  ? 'attempted'
                  : 'new';
            const active = p.label === label;
            return (
              <Link
                key={p.label}
                href={`/c/${slug}/${p.label}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-14 hover:bg-surface-2',
                  active && 'bg-surface-3 font-medium',
                )}
              >
                <span className="font-mono">{p.label}</span>
                <span aria-hidden className="text-13 text-text-2">
                  {state === 'solved' ? '✓' : state === 'attempted' ? '…' : ''}
                  {solvedBy > 0 ? ` ${solvedBy}✓` : ''}
                </span>
                <span className="sr-only">
                  Problem {p.label}, {state === 'new' ? 'not attempted' : state}, solved by{' '}
                  {solvedBy}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1" role="group" aria-label="Move between problems">
          {prev ? (
            <Button asChild variant="ghost" size="sm">
              <Link
                href={`/c/${slug}/${prev.label}`}
                aria-label={`Previous problem, ${prev.label}`}
              >
                <ChevronLeft className="size-4" aria-hidden />
                <span className="max-sm:sr-only">Previous</span>
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled aria-label="Previous problem">
              <ChevronLeft className="size-4" aria-hidden />
              <span className="max-sm:sr-only">Previous</span>
            </Button>
          )}
          {next ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/c/${slug}/${next.label}`} aria-label={`Next problem, ${next.label}`}>
                <span className="max-sm:sr-only">Next</span>
                <ChevronRight className="size-4" aria-hidden />
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled aria-label="Next problem">
              <span className="max-sm:sr-only">Next</span>
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <ContestMessagesButton
            labels={(list?.items ?? []).map((p) => p.label)}
            canAsk={running}
            defaultLabel={label}
          />
          {examActive ? (
            <FinishTestButton onFinish={exam.finish} busy={exam.busy} error={exam.error} />
          ) : null}
          {running ? (
            <Button variant="ghost" size="sm" onClick={() => setFull((f) => !f)}>
              {full ? 'Show menu' : 'Full view'}
            </Button>
          ) : null}
          <Button asChild variant="ghost" size="sm">
            <Link href={`/c/${slug}/board`}>Board</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/c/${slug}`}>Contest</Link>
          </Button>
          {contest && running ? (
            <span className="flex items-center gap-2 text-13 text-text-2">
              Time left
              <span className="text-16">
                <Timer endsAt={endsAt - offset} />
              </span>
            </span>
          ) : (
            <span className="text-13 font-medium text-text-2">Contest ended</span>
          )}
        </div>
      </div>
      {frozen && contest?.freezeAt ? (
        <p role="status" className="rounded-md border border-accent px-3 py-2 text-13">
          Standings are frozen for the last {formatSpan(contest.freezeAt, contest.endsAt)}. You
          still see your own results.
        </p>
      ) : null}
      {!running && contest ? (
        <p className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-13">
          The contest has ended. Submissions now count as practice and do not change the standings.
        </p>
      ) : null}

      <WorkspaceView
        key={`${slug}~${label}`}
        problem={asProblem(problem.v)}
        wide={wide}
        contest={{ slug, label }}
        canary={problem.v.canaryText}
        onVerdict={() => refresh(600)}
      />

      <ExamWarning
        open={examActive && exam.state.phase === 'warning'}
        strikes={exam.state.strikes}
        onContinue={exam.resume}
      />

      <Dialog open={over} onOpenChange={setOver}>
        <DialogContent title="Contest over" description="Final results after the reveal.">
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOver(false)}>
              Keep looking
            </Button>
            <Button asChild variant="primary">
              <Link href={`/c/${slug}/board`}>Open the board</Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
