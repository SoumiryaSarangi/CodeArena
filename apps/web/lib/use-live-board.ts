'use client';
import type { BoardDiffData, BoardSnapshot } from '@codearena/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDiff } from './board';
import { boardSnapshot } from './contests';
import { subscribe } from './realtime';

/**
 * The contest board as a live value, for screens that only need a few facts from it (the arena's
 * problem tabs: my cells and solve counts). Same rules as the scoreboard: a snapshot, patched by
 * `board.diff`; a fresh snapshot after a reconnect, a moved first solve, or (during the freeze) a
 * change to my own row, because my live cells are private. `refresh()` re-reads it on demand.
 */
export function useLiveBoard(
  slug: string,
  viewer: { id: string; admin: boolean } | null,
  ready: boolean,
) {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ref = useRef<BoardSnapshot | null>(null);
  ref.current = board;
  const viewerId = useRef(viewer?.id);
  viewerId.current = viewer?.id;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback((delayMs = 0) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAttempt((n) => n + 1), delayMs);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    boardSnapshot(slug, ctl.signal)
      .then(setBoard)
      .catch(() => undefined); // the tabs just show no states
    return () => ctl.abort();
  }, [slug, ready, attempt]);

  const contestId = board?.contestId;
  const admin = viewer?.admin ?? false;
  useEffect(() => {
    if (!contestId) return;
    let wasDown = false;
    const stop = subscribe(
      [admin ? `admin:contest:${contestId}:board` : `contest:${contestId}:board`],
      (e) => {
        if (e.type !== 'board.diff') return;
        const diff = e.data as unknown as BoardDiffData;
        const cur = ref.current;
        if (!cur) return;
        const out = applyDiff(cur, diff);
        if (out.board === cur) return;
        setBoard(out.board);
        const mine = diff.rows.some((r) => r.userId === viewerId.current);
        if (out.resync || (out.board.frozen && mine)) refresh(300);
      },
      (s) => {
        if (s === 'reconnecting' || s === 'offline') wasDown = true;
        if (s === 'connected' && wasDown) {
          wasDown = false;
          refresh(300);
        }
      },
    );
    return () => {
      stop();
      clearTimeout(timer.current);
    };
  }, [contestId, admin, refresh]);

  return { board, refresh };
}
