'use client';
import { ROOM_DURATIONS, type ProblemList, type RoomList } from '@codearena/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ActionError } from '@/components/admin/problem-errors';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiGet, type ApiError } from '@/lib/api';
import { formatWhen } from '@/lib/contest-time';
import { LANGUAGES } from '@/lib/languages';
import { ROOM_ROLE_TEXT, createRoom, roomList } from '@/lib/rooms';
import { signInHref, useSession } from '@/lib/session';

/** S13 `/interview`: start a room, and the rooms I am in. */
export function InterviewList() {
  const { session } = useSession();
  const router = useRouter();
  const authed = session.status === 'authed';
  const [rooms, setRooms] = useState<RoomList | null>(null);
  const [problems, setProblems] = useState<ProblemList['items']>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState('');
  const [language, setLanguage] = useState('cpp17');
  const [duration, setDuration] = useState('45');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    if (!authed) return;
    const ctl = new AbortController();
    roomList(ctl.signal).then(setRooms, (e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError(e as ApiError);
    });
    apiGet<ProblemList>('/problems?limit=100', ctl.signal).then(
      (p) => setProblems(p.items),
      () => undefined,
    );
    return () => ctl.abort();
  }, [authed]);

  if (session.status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to start or join an interview room."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref('/interview')}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (!session.me.handle) {
    return (
      <EmptyState
        message="Choose a handle first: the other person sees it in the room."
        action={
          <Button asChild variant="primary">
            <Link href="/onboarding">Choose a handle</Link>
          </Button>
        }
      />
    );
  }
  if (error) return <ErrorState message={error.message} requestId={error.requestId} />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFailure(null);
    try {
      const room = await createRoom({
        language: language as never,
        durationMin: Number(duration) as 30 | 45 | 60 | 90,
        ...(problem ? { problemSlug: problem } : {}),
      });
      router.push(`/r/${room.id}`);
    } catch (err) {
      setFailure(err as Error);
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Interview rooms</h1>
      <form onSubmit={submit} aria-label="New room" className="flex flex-col gap-3">
        <h2 className="text-16 font-medium">New room</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Problem" value={problem} onChange={(e) => setProblem(e.target.value)}>
            <option value="">No problem (blank pad)</option>
            {problems.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </Select>
          <Select label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
          <Select label="Duration" value={duration} onChange={(e) => setDuration(e.target.value)}>
            {ROOM_DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Button type="submit" variant="primary" loading={saving}>
            Create room
          </Button>
        </div>
        {failure ? <ActionError error={failure} /> : null}
      </form>

      <section aria-labelledby="mine" className="flex flex-col gap-2">
        <h2 id="mine" className="text-16 font-medium">
          Your rooms
        </h2>
        {!rooms ? (
          <Skeleton className="h-24 w-full" />
        ) : rooms.items.length === 0 ? (
          <EmptyState message="No rooms yet. Create one, then copy the candidate link." />
        ) : (
          <ul className="divide-y divide-border-strong rounded-md border border-border-strong">
            {rooms.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-14">
                {r.status === 'open' ? (
                  <Link href={`/r/${r.id}`} className="font-medium text-accent hover:underline">
                    {r.problem?.title ?? 'Interview room'}
                  </Link>
                ) : (
                  <span className="font-medium">{r.problem?.title ?? 'Interview room'}</span>
                )}
                <span className="text-text-2">{ROOM_ROLE_TEXT[r.role]}</span>
                <span className="text-text-2">{r.status === 'open' ? 'Open' : 'Ended'}</span>
                <span className="ml-auto text-13 text-text-3">{formatWhen(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
