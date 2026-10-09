'use client';
import type { BoardRow, ContestDetail, ContestResults, ReviewItem } from '@codearena/contracts';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { VerdictBadge } from '@/components/verdict-badge';
import { ApiError } from '@/lib/api';
import {
  boardSnapshot,
  contestDetail,
  contestResults,
  myReviews,
  openReview,
  rateReview,
} from '@/lib/contests';
import { signInHref, useSession } from '@/lib/session';

/** While a review is queued or being written, the list is read again this often (no notifications exist yet). */
const POLL_MS = 20_000;

interface Mine {
  row: BoardRow | null;
  change: ContestResults['changes'][number] | null;
  rated: boolean;
}

/** S11: after the contest. My place, my rating change, and an AI review of my final submission for each problem I tried. */
export function ContestResultsView({ slug }: { slug: string }) {
  const { session } = useSession();
  const [contest, setContest] = useState<ContestDetail | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const opened = useRef(new Set<string>());

  const me = session.status === 'authed' ? session.me : null;

  useEffect(() => {
    if (session.status === 'loading') return;
    const ctl = new AbortController();
    (async () => {
      const c = await contestDetail(slug, ctl.signal);
      setContest(c);
      if (c.state !== 'finalized') return;
      const [board, results] = await Promise.all([
        boardSnapshot(slug, ctl.signal),
        contestResults(slug, ctl.signal).catch(() => null),
      ]);
      setMine({
        row: me ? (board.rows.find((r) => r.userId === me.id) ?? null) : null,
        change: me ? (results?.changes.find((r) => r.userId === me.id) ?? null) : null,
        rated: results?.rated ?? false,
      });
      if (me) setItems((await myReviews(slug, ctl.signal)).items);
    })().catch((e) => {
      if ((e as Error).name !== 'AbortError') setError(e as ApiError);
    });
    return () => ctl.abort();
  }, [slug, session.status, me?.id]);

  // Opening a review writes it on demand. One at a time, so a long list does not hit the AI service at once.
  useEffect(() => {
    if (!items) return;
    const next = items.find((i) => i.status !== 'ready' && !opened.current.has(i.reviewId));
    if (!next) return;
    opened.current.add(next.reviewId);
    setItems(
      (all) =>
        all && all.map((i) => (i.reviewId === next.reviewId ? { ...i, status: 'generating' } : i)),
    );
    openReview(next.submissionId)
      .then((r) =>
        setItems(
          (all) =>
            all &&
            all.map((i) =>
              i.reviewId === next.reviewId
                ? { ...i, status: r.status, contentMd: r.contentMd, helpful: r.helpful }
                : i,
            ),
        ),
      )
      .catch(() =>
        setItems(
          (all) =>
            all && all.map((i) => (i.reviewId === next.reviewId ? { ...i, status: 'failed' } : i)),
        ),
      );
  }, [items]);

  // A queued review is written by the background writer: pick it up when it is ready, without a reload.
  const waiting = items?.some((i) => i.status === 'queued' || i.status === 'generating') ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      myReviews(slug)
        .then((r) =>
          setItems(
            (all) =>
              all &&
              all.map((i) => {
                const fresh = r.items.find((x) => x.reviewId === i.reviewId);
                return fresh && fresh.status === 'ready' && i.status !== 'ready'
                  ? { ...i, ...fresh }
                  : i;
              }),
          ),
        )
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, slug]);

  const rate = (item: ReviewItem, helpful: boolean) => {
    setItems(
      (all) => all && all.map((i) => (i.reviewId === item.reviewId ? { ...i, helpful } : i)),
    );
    void rateReview(item.reviewId, helpful).catch(() => {});
  };

  if (error)
    return (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => location.reload()}
      />
    );
  if (!contest) return <Skeleton className="h-40 w-full" />;

  const delta = mine?.change?.delta ?? 0;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-20 font-semibold tracking-[-0.01em]">Results · {contest.title}</h1>
        <Button asChild variant="secondary" size="sm">
          <Link href={`/c/${slug}/board`}>Final standings</Link>
        </Button>
      </div>

      {contest.state !== 'finalized' ? (
        <EmptyState message="The results are final once the organisers finalise the contest. Until then, see the scoreboard." />
      ) : !me ? (
        <p className="text-14">
          <Link className="text-accent underline" href={signInHref(`/c/${slug}/results`)}>
            Sign in
          </Link>{' '}
          to see your result and your AI reviews.
        </p>
      ) : (
        <>
          <section
            aria-label="My result"
            className="grid grid-cols-2 gap-3 rounded-lg border border-border-strong p-4 sm:grid-cols-4"
          >
            <Stat label="Rank" value={mine?.row ? `#${mine.row.rank}` : '—'} />
            <Stat label="Solved" value={mine?.row ? String(mine.row.solved) : '0'} />
            <Stat label="Penalty" value={mine?.row ? String(mine.row.penalty) : '—'} />
            <Stat
              label="Rating"
              value={
                mine?.change
                  ? `${delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '= '}${delta}`
                  : mine?.rated
                    ? 'did not take part'
                    : 'unrated'
              }
              extra={
                mine?.change ? `${mine.change.oldRating} → ${mine.change.newRating}` : undefined
              }
            />
          </section>

          <h2 className="text-16 font-semibold">Your problems</h2>
          {items === null ? (
            <Skeleton className="h-24 w-full" />
          ) : items.length === 0 ? (
            <EmptyState message="You did not submit anything in this contest, so there is nothing to review." />
          ) : (
            <ol className="flex flex-col gap-3">
              {items.map((item) => (
                <li key={item.reviewId}>
                  <ReviewCard item={item} onRate={(h) => rate(item, h)} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div>
      <div className="text-12 text-text-3">{label}</div>
      <div className="font-mono text-18 tabular-nums">{value}</div>
      {extra ? <div className="font-mono text-12 text-text-3">{extra}</div> : null}
    </div>
  );
}

function ReviewCard({ item, onRate }: { item: ReviewItem; onRate: (helpful: boolean) => void }) {
  return (
    <section
      aria-label={`Problem ${item.label}`}
      className="rounded-lg border border-border-strong p-4"
    >
      <h3 className="flex flex-wrap items-center gap-2 text-16 font-medium">
        {item.label}. {item.problemTitle}
        {item.verdict ? (
          <VerdictBadge verdict={item.verdict} test={item.failedTest ?? undefined} />
        ) : null}
        <span className="ml-auto flex gap-1">
          {item.hasEditorial ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/p/${item.problemSlug}/editorial`}>Editorial</Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost" size="sm">
            <Link href={`/p/${item.problemSlug}`}>Upsolve</Link>
          </Button>
        </span>
      </h3>
      <div className="mt-3" aria-live="polite">
        {item.status === 'ready' && item.contentMd ? (
          <div className="flex flex-col gap-3">
            <h4 className="text-13 font-medium text-text-2">AI review of your final submission</h4>
            <Markdown source={item.contentMd} className="text-14" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-13 text-text-2">Was this useful?</span>
              <Button
                size="sm"
                variant={item.helpful === true ? 'secondary' : 'ghost'}
                aria-pressed={item.helpful === true}
                onClick={() => onRate(true)}
              >
                Useful
              </Button>
              <Button
                size="sm"
                variant={item.helpful === false ? 'secondary' : 'ghost'}
                aria-pressed={item.helpful === false}
                onClick={() => onRate(false)}
              >
                Not useful
              </Button>
            </div>
          </div>
        ) : item.status === 'generating' ? (
          <p role="status" className="text-14 text-text-2">
            Writing your review…
          </p>
        ) : item.status === 'failed' ? (
          <p className="text-14 text-danger">
            The review could not be written. Reload this page to try again.
          </p>
        ) : (
          <p role="status" className="text-14 text-text-2">
            Your review is queued. It is written in the background and appears here by itself when
            it is ready.
          </p>
        )}
      </div>
    </section>
  );
}
