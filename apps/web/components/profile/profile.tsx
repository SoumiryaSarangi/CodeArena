'use client';
import type { ProfileSummary, RatingHistory } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { ratingHistory } from '@/lib/contests';
import { profileSummary, tierWord } from '@/lib/profile';
import { ActivityHeatmap } from './activity-heatmap';
import { RatingGraph } from './rating-graph';

/** S12, first cut (C-08): handle, rating, rating graph and contest history. UI-05 adds the rest. */
export function Profile({ handle }: { handle: string }) {
  const [data, setData] = useState<RatingHistory | null>(null);
  const [prof, setProf] = useState<ProfileSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([ratingHistory(handle, ctl.signal), profileSummary(handle, ctl.signal)])
      .then(([d, p]) => {
        setData(d);
        setProf(p);
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
  if (!data || !prof) return <Skeleton className="h-64 w-full" />;
  const latest = [...data.history].reverse();

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[1120px] gap-x-10 gap-y-8 lg:grid-cols-[3fr_2fr]">
      <div className="flex min-w-0 items-center gap-4 lg:col-span-full">
        <Avatar handle={prof.handle} url={prof.avatarUrl} />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-mono text-28 font-semibold [overflow-wrap:anywhere]">
            {data.handle}
          </h1>
          <p className="flex flex-wrap items-baseline gap-x-2 text-16">
            Rating <span className="display font-mono text-40 font-semibold">{data.rating}</span>
            <span className="ml-2 font-medium">{tierWord(data.rating)}</span>
            <span className="ml-2 text-13 text-text-2">
              {data.history.length === 0
                ? 'unrated so far'
                : `after ${data.history.length} rated contest${data.history.length === 1 ? '' : 's'}`}
            </span>
          </p>
          <p className="text-13 text-text-2">
            Joined{' '}
            {new Date(prof.joinedAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <section aria-labelledby="graph" className="flex flex-col gap-3">
          <h2 id="graph" className="text-22 font-semibold">
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
            <h2 id="contests" className="text-22 font-semibold">
              Contest history
            </h2>
            <div className="relative relative overflow-x-auto">
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
      <div className="flex min-w-0 flex-col gap-8">
        <section aria-labelledby="activity" className="flex flex-col gap-3">
          <h2 id="activity" className="text-22 font-semibold">
            Activity
          </h2>
          <ActivityHeatmap activity={prof.activity} />
        </section>
        <section aria-labelledby="solved" className="flex flex-col gap-3">
          <h2 id="solved" className="text-22 font-semibold">
            Solved <span className="font-normal text-text-2">({prof.solved.total})</span>
          </h2>
          {prof.solved.total === 0 ? (
            <p className="text-14 text-text-2">No problems solved yet.</p>
          ) : (
            <div className="grid gap-6">
              <BarList
                label="By difficulty"
                rows={prof.solved.byDifficulty.map((d) => ({ name: d.label, count: d.count }))}
              />
              <BarList
                label="By tag (top 10)"
                rows={prof.solved.byTag.map((t) => ({ name: t.tag, count: t.count }))}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Avatar({ handle, url }: { handle: string; url: string | null }) {
  const cls = 'size-14 shrink-0 rounded-full border border-border-strong';
  if (!url) {
    return (
      <span
        aria-hidden
        className={`${cls} flex items-center justify-center bg-surface-2 font-mono text-20 text-text-2`}
      >
        {handle.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={`${handle}'s avatar`}
      referrerPolicy="no-referrer"
      className={`${cls} object-cover`}
    />
  );
}

/** A list with a bar behind each count; the number is always written, the bar only repeats it. */
function BarList({ label, rows }: { label: string; rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-13 font-medium text-text-2">{label}</h3>
      <ul aria-label={label} className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-3 text-14">
            <span className="w-28 shrink-0 truncate" title={r.name}>
              {r.name}
            </span>
            <span className="h-2 flex-1 rounded-sm bg-surface-3" aria-hidden>
              <span
                className="block h-2 rounded-sm bg-accent"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </span>
            <span className="w-8 text-right font-mono tabular-nums">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
