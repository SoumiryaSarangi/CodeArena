'use client';
import type { SubmissionDetail } from '@codearena/contracts';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { VerdictBadge } from '@/components/verdict-badge';
import { VerdictGrid } from '@/components/verdict-grid';
import { ApiError, apiFetch } from '@/lib/api';
import { saveDraft, saveLanguage } from '@/lib/drafts';
import { formatDateTime, formatMemKb } from '@/lib/format';
import { buildJourney } from '@/lib/journey';
import { languageInfo } from '@/lib/languages';
import {
  applyEvent,
  gridTests,
  queueLine,
  startSubmission,
  type LiveSubmission,
} from '@/lib/live-submission';
import { subscribe } from '@/lib/realtime';
import { signInHref, useSession } from '@/lib/session';
import { verdictTitle } from '@/lib/verdicts';
import { JourneyTimeline } from './journey-timeline';

const CodeEditor = dynamic(() => import('@/components/code-editor'), {
  ssr: false,
  loading: () => <Skeleton className="h-96 w-full" />,
});

type State =
  | { s: 'loading' }
  | { s: 'ready'; d: SubmissionDetail }
  | { s: 'missing' }
  | { s: 'error'; err: ApiError };

function useSubmission(id: string, signedIn: boolean) {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(() => setAttempt((a) => a + 1), []);
  useEffect(() => {
    if (!signedIn) return;
    const c = new AbortController();
    apiFetch<SubmissionDetail>('GET', `/submissions/${encodeURIComponent(id)}`, undefined, {
      signal: c.signal,
    })
      .then((d) => setState({ s: 'ready', d }))
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        // Someone else's submission is a 404 too: the page must not reveal that it exists.
        setState(
          e instanceof ApiError && (e.status === 404 || e.status === 403)
            ? { s: 'missing' }
            : { s: 'error', err: e as ApiError },
        );
      });
    return () => c.abort();
  }, [id, signedIn, attempt]);
  return { state, reload: load };
}

export function SubmissionDetailView({ id }: { id: string }) {
  const { session } = useSession();
  const signedIn = session.status === 'authed';
  const { state, reload } = useSubmission(id, signedIn);

  if (session.status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to see this submission."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref(`/s/${id}`)}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (state.s === 'loading') return <Skeleton className="h-96 w-full" />;
  if (state.s === 'missing') {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-20 font-semibold">Submission not found</h1>
        <p className="text-14 text-text-2">It may not exist, or it is not yours to see.</p>
        <Button asChild variant="secondary">
          <Link href="/practice">Back to Practice</Link>
        </Button>
      </div>
    );
  }
  if (state.s === 'error')
    return (
      <ErrorState message={state.err.message} requestId={state.err.requestId} onRetry={reload} />
    );
  return <Detail d={state.d} isAdmin={session.me.role === 'admin'} onChanged={reload} />;
}

function Detail({
  d,
  isAdmin,
  onChanged,
}: {
  d: SubmissionDetail;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const lang = languageInfo(d.language);
  const finished = d.status === 'done' || d.status === 'failed';

  // While it is still being judged, follow it live and refresh the page's data at the verdict.
  const [live, setLive] = useState<LiveSubmission>(() =>
    startSubmission(d.id, d.tests.length || 12),
  );
  useEffect(() => {
    if (finished) return;
    let reloaded = false;
    return subscribe([`sub:${d.id}`], (e) => {
      setLive((s) => applyEvent(s, e));
      if (e.type === 'submission.verdict' && !reloaded) {
        reloaded = true;
        onChanged();
      }
    });
  }, [d.id, finished, onChanged]);

  const { steps, recorded } = buildJourney(d);
  const resubmit = () => {
    saveLanguage(d.problemSlug, d.language);
    saveDraft(d.problemSlug, d.language, d.source);
    router.push(`/p/${d.problemSlug}`);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <h1 className="text-28 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
          Submission to {d.problemTitle}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          {d.verdict ? (
            <>
              <VerdictBadge
                verdict={d.verdict}
                test={d.failedTest ?? undefined}
                className="px-2.5 py-1 text-16"
              />
              <span className="text-16">{verdictTitle(d.verdict, d.failedTest ?? undefined)}</span>
            </>
          ) : (
            <>
              <VerdictBadge verdict="pending" className="px-2.5 py-1 text-16" />
              <span role="status" className="font-mono text-14 text-text-2">
                {queueLine(live) || 'Judging…'}
              </span>
            </>
          )}
          <Button className="ml-auto" variant="secondary" onClick={resubmit}>
            Resubmit in editor
          </Button>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-13 text-text-2">
          <div className="flex gap-1">
            <dt>Problem</dt>
            <dd>
              <Link href={`/p/${d.problemSlug}`} className="text-accent underline">
                {d.problemTitle}
              </Link>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Language</dt>
            <dd className="text-text">{lang.label}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Time</dt>
            <dd className="font-mono text-text">{d.timeMs != null ? `${d.timeMs} ms` : '—'}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Memory</dt>
            <dd className="font-mono text-text">{d.memKb != null ? formatMemKb(d.memKb) : '—'}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Submitted</dt>
            <dd>
              <time
                dateTime={d.createdAt}
                title={new Date(d.createdAt).toISOString()}
                className="text-text"
              >
                {formatDateTime(d.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <JourneyTimeline
            steps={steps}
            note={
              finished && !recorded
                ? 'Step timings were not recorded for this submission.'
                : undefined
            }
          />
          {!finished ? (
            <section aria-label="Progress">
              <h2 className="mb-2 text-18 font-semibold">Progress</h2>
              <VerdictGrid tests={gridTests(live)} />
            </section>
          ) : null}
          {d.tests.length > 0 ? <TestTable d={d} /> : null}
          {isAdmin ? <AdminExtras d={d} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <section aria-label="Code" className="flex flex-col gap-2">
            <h2 className="text-18 font-semibold">Code</h2>
            <div className="h-96 overflow-hidden rounded-lg border border-border-strong">
              <CodeEditor
                path={`submission/${d.id}.${d.language}`}
                initialValue={d.source}
                onChange={() => {}}
                language={lang.monaco}
                label={`Submitted code, ${lang.label} (read only)`}
                readOnly
              />
            </div>
          </section>
          {d.verdict === 'CE' && d.compileLog ? (
            <section aria-label="Compiler output">
              <h2 className="mb-2 text-18 font-semibold">Compiler output</h2>
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-13 whitespace-pre-wrap">
                {d.compileLog}
              </pre>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TestTable({ d }: { d: SubmissionDetail }) {
  return (
    <section aria-label="Tests">
      <h2 className="mb-2 text-18 font-semibold">Tests</h2>
      <div
        role="region"
        tabIndex={0}
        aria-label="Test results table"
        className="relative relative overflow-x-auto rounded-lg border border-border-strong"
      >
        <table className="w-full text-13">
          <caption className="sr-only">Result of each test</caption>
          <thead className="bg-surface-2 text-left text-text-2">
            <tr>
              <th scope="col" className="h-8 px-3 font-medium">
                Test
              </th>
              <th scope="col" className="px-3 font-medium">
                Verdict
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Time
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Memory
              </th>
            </tr>
          </thead>
          <tbody>
            {d.tests.map((t) => {
              const first = t.no === d.failedTest;
              return (
                <tr
                  key={t.no}
                  className={
                    first
                      ? 'border-t border-border bg-v-wa/14 light:bg-transparent light:shadow-[inset_3px_0_0_var(--v-wa)]'
                      : 'border-t border-border'
                  }
                >
                  <td className="h-8 px-3 font-mono">
                    {t.no}
                    {first ? (
                      <span className="ml-2 font-sans text-12 text-text-2">first failing test</span>
                    ) : null}
                  </td>
                  <td className="px-3">
                    <VerdictBadge verdict={t.verdict} />
                    {t.checkerMsg ? (
                      <span className="ml-2 text-12 text-text-2">{t.checkerMsg}</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 text-right font-mono">
                    {t.timeMs != null ? `${t.timeMs} ms` : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 text-right font-mono">
                    {t.memKb != null ? formatMemKb(t.memKb) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminExtras({ d }: { d: SubmissionDetail }) {
  return (
    <section aria-label="Admin details">
      <h2 className="mb-2 text-18 font-semibold">Admin</h2>
      <dl className="mb-2 flex gap-1 text-13">
        <dt className="text-text-2">Judge</dt>
        <dd className="font-mono">{d.journey.workerId ?? '—'}</dd>
      </dl>
      {d.runs && d.runs.length > 0 ? (
        <table className="w-full text-13">
          <caption className="sr-only">Judging runs</caption>
          <thead className="text-left text-12 text-text-3">
            <tr>
              <th className="font-normal">Run</th>
              <th className="font-normal">Reason</th>
              <th className="font-normal">Judge</th>
              <th className="font-normal">Verdict</th>
              <th className="font-normal">Finished</th>
            </tr>
          </thead>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.runVersion} className="border-t border-border">
                <td className="py-1 font-mono">v{r.runVersion}</td>
                <td>{r.reason}</td>
                <td className="font-mono">{r.workerId ?? '—'}</td>
                <td>{r.verdict ? <VerdictBadge verdict={r.verdict} /> : '—'}</td>
                <td className="font-mono text-12">
                  {r.finishedAt ? formatDateTime(r.finishedAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
