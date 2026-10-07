'use client';
import type { AdminContestList } from '@codearena/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { StateLabel } from '@/components/contests/state-label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { formatWhen, fromLocalInput, localZone } from '@/lib/contest-time';
import { adminContests, createContest } from '@/lib/contests';
import { ActionError } from './problem-errors';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Admin → Contests: every contest (drafts too) and a form for a new one. */
export function ContestAdminList() {
  const router = useRouter();
  const [data, setData] = useState<AdminContestList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [freeze, setFreeze] = useState('30');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    adminContests(ctl.signal)
      .then(setData)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      const endsAt = fromLocalInput(end);
      const mins = Number(freeze);
      const made = await createContest({
        slug,
        title,
        startsAt: fromLocalInput(start),
        endsAt,
        freezeAt: mins > 0 ? new Date(Date.parse(endsAt) - mins * 60_000).toISOString() : null,
      });
      router.push(`/admin/contests/${made.id}`);
    } catch (err) {
      setFailure(err as Error);
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Contests</h1>

      <form onSubmit={submit} className="flex flex-col gap-3" aria-label="New contest">
        <h2 className="text-16 font-medium">New contest</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Title"
            value={title}
            required
            minLength={3}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
          />
          <Input
            label="Slug (the link: /c/…)"
            value={slug}
            required
            pattern="[a-z0-9][a-z0-9\-]{2,59}"
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
          />
          <Input
            label="Starts"
            type="datetime-local"
            value={start}
            required
            onChange={(e) => setStart(e.target.value)}
          />
          <Input
            label="Ends"
            type="datetime-local"
            value={end}
            required
            onChange={(e) => setEnd(e.target.value)}
          />
          <Input
            label="Freeze the scoreboard for the last (minutes, 0 = never)"
            type="number"
            min={0}
            value={freeze}
            onChange={(e) => setFreeze(e.target.value)}
          />
        </div>
        <p className="text-13 text-text-2">
          Times are in your time zone ({localZone()}). Problems and rules come next; a new contest
          is a draft nobody else can see.
        </p>
        {failure ? <ActionError error={failure} /> : null}
        <div>
          <Button type="submit" variant="primary" loading={saving}>
            Create draft
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2" aria-label="All contests">
        <h2 className="text-16 font-medium">All contests</h2>
        {error ? (
          <ErrorState message={error.message} requestId={error.requestId} />
        ) : !data ? (
          <Skeleton className="h-32 w-full" />
        ) : data.items.length === 0 ? (
          <EmptyState message="No contests yet. Create one above." />
        ) : (
          <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
            {data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                <Link
                  href={`/admin/contests/${c.id}`}
                  className="text-14 font-medium hover:underline"
                >
                  {c.title}
                </Link>
                <span className="text-13 text-text-2">
                  {formatWhen(c.startsAt)} · {c.problemCount} problems · {c.registeredCount}{' '}
                  registered
                </span>
                <StateLabel state={c.state} className="ml-auto" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
