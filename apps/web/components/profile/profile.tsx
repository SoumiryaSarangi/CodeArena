'use client';
import type { RatingHistory } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { ratingHistory } from '@/lib/contests';
import { RatingGraph } from './rating-graph';

/** S12, first cut (C-08): handle, rating, rating graph and contest history. UI-05 adds the rest. */
export function Profile({ handle }: { handle: string }) {
  const [data, setData] = useState<RatingHistory | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const ctl = new AbortController();
    ratingHistory(handle, ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [handle, attempt]);

  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such user." />
    ) : (
      <ErrorState message={error.message} requestId={error.requestId} onRetry={retry} />
    );
  }
  if (!data) return <Skeleton className="h-64 w-full" />;
  const latest = [...data.history].reverse();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-mono text-24 font-semibold">{data.handle}</h1>
        <p className="text-16">
          Rating <span className="font-mono font-semibold tabular-nums">{data.rating}</span>
          <span className="ml-2 text-13 text-text-2">
            {data.history.length === 0
              ? 'unrated so far'
              : `after ${data.history.length} rated contest${data.history.length === 1 ? '' : 's'}`}
          </span>
        </p>
      </div>
      <section aria-labelledby="graph" className="flex flex-col gap-2">
        <h2 id="graph" className="text-16 font-medium">
          Rating graph
        </h2>
        {data.history.length === 0 ? (
          <p className="text-14 text-text-2">Rated contests will show up here.</p>
        ) : (
          <RatingGraph history={data.history} />
        )}
      </section>
      {latest.length > 0 ? (
        <section aria-labelledby="contests" className="flex flex-col gap-2">
          <h2 id="contests" className="text-16 font-medium">
            Contest history
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-14">
              <caption className="sr-only">Rated contests, newest first</caption>
              <thead>
                <tr className="text-left text-12 text-text-3">
                  <th scope="col" className="py-1 pr-4 font-medium">
                    Contest
                  </th>
                  <th scope="col" className="py-1 pr-4 text-right font-medium">
                    Rank
                  </th>
                  <th scope="col" className="py-1 pr-4 text-right font-medium">
                    Change
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Rating
                  </th>
                </tr>
              </thead>
              <tbody>
                {latest.map((h) => (
                  <tr key={h.contestSlug} className="border-t border-border-strong/60">
                    <th scope="row" className="py-1 pr-4 text-left font-normal">
                      <Link href={`/c/${h.contestSlug}/board`} className="underline">
                        {h.contestTitle}
                      </Link>
                    </th>
                    <td className="py-1 pr-4 text-right font-mono tabular-nums">{h.rank}</td>
                    <td className="py-1 pr-4 text-right font-mono tabular-nums">
                      {h.delta > 0 ? '+' : h.delta < 0 ? '−' : '±'}
                      {Math.abs(h.delta)}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums">{h.newRating}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
