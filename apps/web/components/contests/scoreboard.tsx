'use client';
import type { BoardDiffData, BoardSnapshot, ContestDetail } from '@codearena/contracts';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionPill } from '@/components/connection-pill';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { applyDiff } from '@/lib/board';
import { useNow, useServerClock } from '@/lib/contest-time';
import { boardSnapshot, contestDetail } from '@/lib/contests';
import { cn } from '@/lib/cn';
import { subscribe, type ConnectionState } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { ScoreCell } from './score-cell';

/** UI_UX §7: tables of more than this many rows are windowed (fixed 36 px rows). */
const WINDOW_AFTER = 200;
const ROW_H = 36;
const OVERSCAN = 12;
const VIEW_ROWS = 18;

type Chip = { text: string; cls: string };

function chipFor(c: ContestDetail, frozen: boolean, admin: boolean): Chip {
  if (c.state === 'finalized') return { text: 'Final', cls: 'text-text-2' };
  if (frozen) return { text: 'Frozen', cls: 'text-warning' };
  if (c.state === 'running')
    return { text: admin ? 'Live (admin view)' : 'Live', cls: 'text-v-ac' };
  if (c.state === 'scheduled') return { text: 'Not started', cls: 'text-text-2' };
  return { text: 'Ended', cls: 'text-text-2' };
}

/** S10: the live scoreboard. A real `<table>`; rows glide to their new rank; diffs patch in place. */
export function Scoreboard({ slug }: { slug: string }) {
  const { session } = useSession();
  const reduce = useReducedMotion();
  const [contest, setContest] = useState<ContestDetail | null>(null);
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const boardRef = useRef<BoardSnapshot | null>(null);
  boardRef.current = board;

  const me = session.status === 'authed' ? session.me : null;
  const admin = me?.role === 'admin';
  const offset = useServerClock(board?.serverNow);
  const now = useNow(offset);

  // Snapshot + contest header. Re-read after a reconnect or when a diff cannot be applied exactly.
  useEffect(() => {
    if (session.status === 'loading') return;
    const ctl = new AbortController();
    Promise.all([contestDetail(slug, ctl.signal), boardSnapshot(slug, ctl.signal)])
      .then(([c, b]) => {
        setContest(c);
        setBoard(b);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [slug, attempt, session.status]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Live diffs: the admin topic carries the live view, everyone else the public (frozen) one.
  const contestId = board?.contestId;
  const myId = me?.id;
  // The stream handler reads it through a ref, so a late sign-in does not reopen the stream.
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  useEffect(() => {
    if (!contestId) return;
    const topic = admin ? `admin:contest:${contestId}:board` : `contest:${contestId}:board`;
    let wasDown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 300);
    };
    const stop = subscribe(
      [topic],
      (e) => {
        if (e.type !== 'board.diff') return;
        const diff = e.data as unknown as BoardDiffData;
        const cur = boardRef.current;
        if (!cur) return;
        const out = applyDiff(cur, diff);
        if (out.board === cur) return;
        const myId = myIdRef.current;
        const mine = myId ? cur.rows.find((r) => r.userId === myId) : undefined;
        const mineNow = myId ? out.board.rows.find((r) => r.userId === myId) : undefined;
        if (mine && mineNow && mine.rank !== mineNow.rank) {
          setAnnounce(`You moved to rank ${mineNow.rank}`);
        }
        setBoard(out.board);
        if (out.newFirsts.length > 0) {
          setFlash(new Set(out.newFirsts));
          setTimeout(() => setFlash(new Set()), 1600);
        }
        // Own cells during the freeze come from a private overlay, so ask for a fresh snapshot.
        if (out.resync || (out.board.frozen && myId && diff.rows.some((r) => r.userId === myId))) {
          soon();
        }
      },
      (s) => {
        setConn(s);
        if (s === 'reconnecting' || s === 'offline') wasDown = true;
        if (s === 'connected' && wasDown) {
          wasDown = false;
          soon();
        }
      },
    );
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [contestId, admin, reload]);

  const rows = board?.rows ?? [];
  const windowed = rows.length > WINDOW_AFTER;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const last = windowed
    ? Math.min(rows.length, Math.ceil(scrollTop / ROW_H) + VIEW_ROWS + OVERSCAN)
    : rows.length;
  const visible = useMemo(() => rows.slice(first, last), [rows, first, last]);

  const jumpToMe = () => {
    const i = rows.findIndex((r) => r.userId === myId);
    if (i < 0 || !scroller.current) return;
    if (windowed) {
      scroller.current.scrollTop = Math.max(0, i * ROW_H - ROW_H * 4);
      setScrollTop(scroller.current.scrollTop);
      requestAnimationFrame(() => {
        const el = scroller.current?.querySelector<HTMLElement>('[data-me]');
        el?.focus();
      });
    } else {
      const el = scroller.current.querySelector<HTMLElement>('[data-me]');
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    }
  };

  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such contest." />
    ) : (
      <ErrorState message={error.message} requestId={error.requestId} onRetry={reload} />
    );
  }
  if (!contest || !board) return <Skeleton className="h-96 w-full" />;

  // Frozen for this viewer: the server says so, or the freeze time has passed by the server's clock.
  const frozen =
    board.frozen ||
    (!admin &&
      contest.freezeAt !== null &&
      contest.state !== 'finalized' &&
      contest.state !== 'scheduled' &&
      now >= Date.parse(contest.freezeAt));
  const chip = chipFor(contest, frozen, admin);
  const meInRows = myId ? rows.some((r) => r.userId === myId) : false;
  const labels = board.problems.map((p) => p.label);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-col gap-0.5">
          <span className={cn('text-13 font-medium', chip.cls)}>{chip.text}</span>
          <h1 className="text-24 font-semibold tracking-[-0.01em]">{contest.title}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionPill state={conn} />
          <Button asChild variant="ghost" size="sm">
            <Link href={`/c/${slug}`}>Contest page</Link>
          </Button>
          {meInRows ? (
            <Button size="sm" onClick={jumpToMe}>
              Jump to me
            </Button>
          ) : null}
        </div>
      </div>
      {frozen && !admin ? (
        <p className="text-13 text-text-2">
          The scoreboard is frozen: other people&apos;s attempts show as pending (?).
          {meInRows ? ' Your own results stay visible to you.' : ''}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {announce}
      </span>

      {rows.length === 0 ? (
        <EmptyState message="Nobody has registered yet." />
      ) : (
        <div
          ref={scroller}
          onScroll={windowed ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
          className="relative max-h-[calc(100dvh-16rem)] min-w-0 max-w-full overflow-auto rounded-md border border-border-strong"
          // The scroll box is keyboard-scrollable for people who cannot use a pointer (WCAG 2.1.1).
          tabIndex={0}
          aria-label="Scoreboard, scrollable"
        >
          <table
            className="w-full border-separate border-spacing-0 text-14"
            aria-rowcount={rows.length + 1}
          >
            <caption className="sr-only">
              Scoreboard of {contest.title}, {chip.text}. Ranked by problems solved, then penalty.
            </caption>
            <thead>
              <tr>
                <th scope="col" className={cn(TH, 'left-0 w-14 text-right')}>
                  Rank
                </th>
                <th scope="col" className={cn(TH, 'left-14 min-w-32 text-left')}>
                  Handle
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Solved
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Penalty
                </th>
                {board.problems.map((p) => (
                  <th key={p.label} scope="col" className={cn(TH, 'min-w-20 text-center')}>
                    <span className="font-mono">{p.label}</span>
                    <span className="ml-1 font-normal text-text-2" title="Accepted by">
                      {p.solvedCount}
                    </span>
                    <span className="sr-only"> solved by {p.solvedCount}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {windowed && first > 0 ? (
                <tr aria-hidden style={{ height: first * ROW_H }}>
                  <td colSpan={4 + labels.length} />
                </tr>
              ) : null}
              {visible.map((r, k) => {
                const mine = r.userId === myId;
                return (
                  <motion.tr
                    key={r.userId}
                    layout={reduce || windowed ? false : 'position'}
                    transition={{ type: 'spring', duration: 0.35, bounce: 0.1 }}
                    aria-rowindex={first + k + 2}
                    data-me={mine ? '' : undefined}
                    tabIndex={mine ? -1 : undefined}
                    style={windowed ? { height: ROW_H } : undefined}
                    className={cn('group', mine && 'bg-surface-2')}
                  >
                    <td
                      className={cn(
                        TD,
                        'sticky left-0 z-[1] w-14 text-right font-mono tabular-nums',
                        mine ? 'bg-surface-2' : 'bg-surface-1',
                      )}
                    >
                      {r.rank}
                    </td>
                    <th
                      scope="row"
                      className={cn(
                        TD,
                        'sticky left-14 z-[1] text-left font-mono font-medium',
                        mine ? 'bg-surface-2' : 'bg-surface-1',
                      )}
                    >
                      {r.handle}
                      {mine ? (
                        <span className="ml-1 font-sans font-normal text-text-2">(you)</span>
                      ) : null}
                    </th>
                    <td className={cn(TD, 'text-right font-mono tabular-nums')}>{r.solved}</td>
                    <td className={cn(TD, 'text-right font-mono tabular-nums')}>{r.penalty}</td>
                    {labels.map((l) => (
                      <td key={l} className={cn(TD, 'text-center')}>
                        <ScoreCell cell={r.cells[l]} flash={flash.has(`${r.userId}:${l}`)} />
                      </td>
                    ))}
                  </motion.tr>
                );
              })}
              {windowed && last < rows.length ? (
                <tr aria-hidden style={{ height: (rows.length - last) * ROW_H }}>
                  <td colSpan={4 + labels.length} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-13 text-text-2">
        ✓ solved at that minute · ★ first to solve · +n rejected attempts · ?n pending
      </p>
    </div>
  );
}

const TH =
  'sticky top-0 z-[2] border-b border-border-strong bg-surface-1 px-3 py-2 text-13 font-medium text-text-2 first:z-[3] [&:nth-child(2)]:z-[3]';
const TD = 'h-9 border-b border-border-strong/60 px-3 align-middle';
