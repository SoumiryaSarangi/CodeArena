'use client';
import type { ProblemEditorial } from '@codearena/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { ApiError, apiFetch } from '@/lib/api';
import { useSession } from '@/lib/session';

type Load =
  | { s: 'loading' }
  | { s: 'ready'; v: ProblemEditorial }
  | { s: 'none' }
  | { s: 'error'; err: ApiError };

/** The editorial of a problem: public once a contest that used it is finalised (setters and admins: always). */
export function EditorialView({ slug }: { slug: string }) {
  const { session } = useSession();
  const [state, setState] = useState<Load>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (session.status === 'loading') return;
    const ctl = new AbortController();
    setState({ s: 'loading' });
    apiFetch<ProblemEditorial>(
      'GET',
      `/problems/${encodeURIComponent(slug)}/editorial`,
      undefined,
      {
        auth: 'optional',
        signal: ctl.signal,
      },
    )
      .then((v) => setState({ s: 'ready', v }))
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        setState(
          err instanceof ApiError && err.status === 404 ? { s: 'none' } : { s: 'error', err },
        );
      });
    return () => ctl.abort();
  }, [slug, session.status, attempt]);

  const back = (
    <Button asChild variant="secondary" size="sm">
      <Link href={`/p/${slug}`}>Back to the problem</Link>
    </Button>
  );

  if (state.s === 'loading') return <Skeleton className="h-40 w-full" />;
  if (state.s === 'error')
    return (
      <ErrorState
        message={state.err.message}
        requestId={state.err.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  if (state.s === 'none')
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-22 font-semibold tracking-[-0.01em]">Editorial</h1>
        <EmptyState message="There is no editorial for this problem yet. Editorials are published when the contest that used the problem is finalised." />
        <div>{back}</div>
      </div>
    );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-22 font-semibold tracking-[-0.01em]">Editorial · {state.v.title}</h1>
        {back}
      </div>
      <Markdown source={state.v.editorialMd} className="text-14" />
    </div>
  );
}
