'use client';
import type { RoomTimeline, RoomView } from '@codearena/contracts';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { isLanguage, languageInfo } from '@/lib/languages';
import { BoardCanvas } from './board-canvas';
import { Player, parseFrame, type Frame, type SliceSource } from '@/lib/playback';
import { eventLabel, sessionClock } from '@/lib/replay-labels';
import { roomGet, roomNotes, roomPlayback, roomTimeline } from '@/lib/rooms';
import { signInHref, useSession } from '@/lib/session';
import { cn } from '@/lib/cn';

const ReplayEditor = dynamic(() => import('./replay-editor'), {
  ssr: false,
  loading: () => <Skeleton className="h-96 w-full" />,
});

const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 50;
const SEEK_DEBOUNCE_MS = 80;

/** S14 `/r/{roomId}/replay`: gate (interviewer only), then the replay itself. */
export function ReplayPage({ roomId }: { roomId: string }) {
  const { session } = useSession();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const authed = session.status === 'authed';

  useEffect(() => {
    if (!authed) return;
    const ctl = new AbortController();
    roomGet(roomId, ctl.signal).then(setRoom, (e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError(e as ApiError);
    });
    return () => ctl.abort();
  }, [roomId, authed]);

  if (session.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to replay this session."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref(`/r/${roomId}/replay`)}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such room, or you were not in it." action={<BackLink />} />
    ) : (
      <ErrorState message={error.message} requestId={error.requestId} />
    );
  }
  if (!room) return <Skeleton className="h-96 w-full" />;
  if (room.role !== 'interviewer') {
    // no replay request is made for anyone else: the API refuses them too
    return (
      <EmptyState message="Only the interviewer can replay a session." action={<BackLink />} />
    );
  }
  return <Replay room={room} />;
}

const BackLink = () => (
  <Button asChild variant="secondary">
    <Link href="/interview">Your rooms</Link>
  </Button>
);

function Replay({ room }: { room: RoomView }) {
  const [timeline, setTimeline] = useState<RoomTimeline | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [speed, setSpeed] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  // the whiteboard section appears once anything was drawn, and stays (the board is empty again if it was cleared)
  const [boardSeen, setBoardSeen] = useState(false);
  useEffect(() => {
    if (frame && frame.shapes.length > 0) setBoardSeen(true);
  }, [frame]);
  const playerRef = useRef<Player | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragAt, setDragAt] = useState<number | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    roomTimeline(room.id, ctl.signal).then(setTimeline, (e: unknown) => {
      if ((e as Error).name !== 'AbortError') setFailure((e as Error).message);
    });
    roomNotes(room.id, ctl.signal).then(
      (n) => setNotes(n.body),
      () => undefined,
    );
    return () => ctl.abort();
  }, [room.id]);

  // the loading hint only appears when something takes longer than 300 ms
  useEffect(() => {
    if (!busy) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, [busy]);

  useEffect(() => {
    if (!timeline) return;
    const startMs = Date.parse(timeline.startedAt);
    const source: SliceSource = {
      seek: async (toTs) => {
        const r = await roomPlayback(room.id, { toTs: new Date(toTs).toISOString() });
        return { records: parseFrame(r.bytes), fromSeq: r.fromSeq, toSeq: r.toSeq };
      },
      chunk: async (fromSeq, limit) => {
        const r = await roomPlayback(room.id, { fromSeq, toSeq: fromSeq + limit });
        return { records: parseFrame(r.bytes), fromSeq: r.fromSeq, toSeq: r.toSeq };
      },
    };
    const player = new Player({
      source,
      startMs,
      endMs: Date.parse(timeline.endedAt),
      lastSeq: timeline.lastSeq,
      onFrame: setFrame,
    });
    playerRef.current = player;
    setBusy(true);
    player.seek(startMs).then(
      () => setBusy(false),
      (e: Error) => {
        setBusy(false);
        setFailure(e.message);
      },
    );
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      void player.advance(dt).catch(() => undefined);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      player.destroy();
      playerRef.current = null;
    };
  }, [timeline, room.id]);

  const seekTo = useCallback(async (t: number) => {
    const p = playerRef.current;
    if (!p) return;
    setBusy(true);
    try {
      await p.seek(t);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
      setDragAt(null);
    }
  }, []);

  const toggle = useCallback(async () => {
    const p = playerRef.current;
    if (!p || !timeline) return;
    if (p.playing) return p.pause();
    if (p.ended) await seekTo(Date.parse(timeline.startedAt));
    p.setSpeed(speed);
    p.play(speed);
  }, [timeline, speed, seekTo]);

  const chooseSpeed = (s: number) => {
    setSpeed(s);
    playerRef.current?.setSpeed(s);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'BUTTON' ||
      !timeline ||
      !playerRef.current
    )
      return;
    if (e.key === ' ') {
      e.preventDefault();
      void toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      void seekTo(playerRef.current.position + (e.key === 'ArrowRight' ? 5000 : -5000));
    }
  };

  if (failure) return <ErrorState message={failure} />;
  if (!timeline) return <Skeleton className="h-96 w-full" />;

  const start = Date.parse(timeline.startedAt);
  const duration = Math.max(1, timeline.durationMs);
  const at = dragAt ?? frame?.at ?? start;
  const language =
    frame?.language && isLanguage(frame.language)
      ? languageInfo(frame.language)
      : languageInfo(room.language);
  const markers = timeline.events.filter((e) => e.kind !== 'timer');

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="flex flex-wrap items-baseline gap-3">
        <Link href="/interview" className="text-13 text-text-2 underline">
          Your rooms
        </Link>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">
          {room.problem?.title ?? 'Interview'}: replay
        </h1>
        <span className="text-13 text-text-2">
          {timeline.updates} edits over {sessionClock(Date.parse(timeline.endedAt), start)}
        </span>
        {slow ? (
          <span role="status" className="text-13 text-text-2">
            Loading…
          </span>
        ) : null}
      </header>

      <div className="grid gap-3 lg:grid-cols-[1fr_20rem]">
        <section
          aria-label="Replayed code"
          className="h-96 overflow-hidden rounded-md border border-border-strong"
        >
          <ReplayEditor value={frame?.text ?? ''} language={language.monaco} />
        </section>
        <aside
          aria-label="Your private notes"
          className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
        >
          <h2 className="text-14 font-medium">Your notes</h2>
          {notes === null ? (
            <Skeleton className="h-24 w-full" />
          ) : notes.trim() === '' ? (
            <p className="text-13 text-text-3">You wrote no notes in this room.</p>
          ) : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-14">{notes}</pre>
          )}
        </aside>
      </div>

      {boardSeen ? (
        <section aria-label="Replayed whiteboard" className="flex flex-col gap-2">
          <h2 className="text-14 font-medium">Whiteboard at this moment</h2>
          <div className="max-w-3xl">
            <BoardCanvas shapes={frame?.shapes ?? []} label="Replayed whiteboard, read-only" />
          </div>
        </section>
      ) : null}

      <section
        aria-label="Controls"
        className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={() => void toggle()}
            aria-label={frame?.playing ? 'Pause' : frame?.ended ? 'Play again' : 'Play'}
          >
            {frame?.playing ? 'Pause' : frame?.ended ? 'Play again' : 'Play'}
          </Button>
          <div role="group" aria-label="Speed" className="flex gap-1">
            {SPEEDS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={speed === s ? 'primary' : 'secondary'}
                aria-pressed={speed === s}
                onClick={() => chooseSpeed(s)}
              >
                {s}×
              </Button>
            ))}
          </div>
          <span className="font-mono text-14" aria-hidden>
            {sessionClock(at, start)} / {sessionClock(Date.parse(timeline.endedAt), start)}
          </span>
        </div>
        <div className="relative pb-6">
          <input
            type="range"
            aria-label="Position in the session"
            aria-valuetext={`${sessionClock(at, start)} of ${sessionClock(Date.parse(timeline.endedAt), start)}`}
            min={0}
            max={duration}
            // one millisecond, so End is exactly the end; the arrow keys are handled below in steps worth moving by
            step={1}
            onKeyDown={(e) => {
              const jump = {
                ArrowLeft: -5000,
                ArrowRight: 5000,
                PageDown: -30_000,
                PageUp: 30_000,
              }[e.key];
              if (jump === undefined) return;
              e.preventDefault();
              const p = playerRef.current;
              if (p) void seekTo(p.position + jump);
            }}
            value={Math.min(duration, Math.max(0, at - start))}
            onChange={(e) => {
              const t = start + Number(e.target.value);
              setDragAt(t);
              if (seekTimer.current) clearTimeout(seekTimer.current);
              seekTimer.current = setTimeout(() => void seekTo(t), SEEK_DEBOUNCE_MS);
            }}
            className="w-full accent-[var(--accent)]"
          />
          <div className="relative h-4" aria-label="Markers">
            {markers.map((e) => {
              const ts = Date.parse(e.ts);
              return (
                <button
                  key={e.seq}
                  type="button"
                  aria-label={`${sessionClock(ts, start)} ${eventLabel(e)}`}
                  title={`${sessionClock(ts, start)} ${eventLabel(e)}`}
                  onClick={() => void seekTo(ts)}
                  style={{
                    left: `${Math.min(100, Math.max(0, ((ts - start) / duration) * 100))}%`,
                  }}
                  className={cn(
                    'absolute top-0 h-4 w-1.5 -translate-x-1/2 rounded-sm',
                    e.kind === 'run'
                      ? 'bg-accent'
                      : e.kind === 'language'
                        ? 'bg-text-2'
                        : 'bg-text-3',
                  )}
                />
              );
            })}
          </div>
        </div>
      </section>

      <section aria-label="Events" className="flex flex-col gap-1">
        <h2 className="text-16 font-medium">What happened</h2>
        {timeline.events.length === 0 ? (
          <p className="text-13 text-text-3">Nothing was recorded besides the code.</p>
        ) : (
          <ol aria-label="Events in order" className="flex flex-col">
            {timeline.events.map((e) => (
              <li key={e.seq}>
                <button
                  type="button"
                  onClick={() => void seekTo(Date.parse(e.ts))}
                  className="flex w-full gap-3 rounded-md px-2 py-1 text-left text-14 hover:bg-surface-2"
                >
                  <span className="font-mono text-text-2">
                    {sessionClock(Date.parse(e.ts), start)}
                  </span>
                  <span>{eventLabel(e)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {timeline.eventsCut ? (
          <p className="text-13 text-text-3">Only the first 2000 events are listed.</p>
        ) : null}
      </section>
    </div>
  );
}
