'use client';
import type { RoomRunView } from '@codearena/contracts';
import { useCallback, useEffect, useState } from 'react';
import { VerdictBadge } from '@/components/verdict-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { languageInfo } from '@/lib/languages';
import { subscribe } from '@/lib/realtime';
import { restoreRoom, roomRuns, startRoomRun } from '@/lib/rooms';
import type { Pad } from './use-pad';

/** Newest first, one entry per run: a later event for the same run replaces the earlier one. */
export function mergeRun(list: RoomRunView[], next: RoomRunView): RoomRunView[] {
  const rest = list.filter((r) => r.runId !== next.runId);
  return [next, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}

const STATUS_WORD = {
  queued: 'Waiting for a judge…',
  running: 'Running…',
  failed: 'Could not be judged',
} as const;

/**
 * S13 output panel (CP-04): Run (with input) and Submit (the problem's hidden tests) on the code everyone shares, and the
 * history of runs. Everyone in the room sees every run, who pressed the button and the same output, because it arrives
 * from the server on the room's topic and not from the browser that ran it.
 */
export function RunPanel({
  roomId,
  pad,
  language,
  canRun,
  canRestore = false,
  hasProblem,
}: {
  roomId: string;
  pad: Pad | null;
  /** The shared language id (`cpp17`, `python3`…). */
  language: string;
  canRun: boolean;
  /** The interviewer of an open room may put an earlier run's code back (CP-07). */
  canRestore?: boolean;
  hasProblem: boolean;
}) {
  const [runs, setRuns] = useState<RoomRunView[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [restoring, setRestoring] = useState<RoomRunView | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restored, setRestored] = useState('');

  useEffect(() => {
    const ctl = new AbortController();
    roomRuns(roomId, ctl.signal).then(
      (r) => setRuns((cur) => r.items.reduce((acc, it) => mergeRun(acc, it), cur)),
      () => undefined,
    );
    const stop = subscribe([`room:${roomId}`], (e) => {
      if (e.type === 'room.run') setRuns((cur) => mergeRun(cur, e.data as unknown as RoomRunView));
    });
    return () => {
      ctl.abort();
      stop();
    };
  }, [roomId]);

  const go = useCallback(
    async (mode: 'run' | 'submit') => {
      if (!pad || pending) return;
      setPending(mode);
      setMessage('');
      try {
        await startRoomRun(roomId, {
          runId: crypto.randomUUID(),
          mode,
          language: language as never,
          source: pad.doc.getText('code').toString(),
          ...(mode === 'run' ? { input } : {}),
        });
      } catch (e) {
        const err = e as ApiError;
        setMessage(
          err.status === 429
            ? 'One run every 2 seconds in this room. Try again in a moment.'
            : err.message || 'The run could not be started.',
        );
      } finally {
        setPending(null);
      }
    },
    [pad, pending, roomId, language, input],
  );

  const restore = useCallback(async () => {
    if (!restoring) return;
    setRestoreBusy(true);
    setMessage('');
    setRestored('');
    try {
      await restoreRoom(roomId, restoring.runId);
      setRestored(
        `Restored the code from @${restoring.by}'s run at ${new Date(restoring.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
      );
    } catch (e) {
      const err = e as ApiError;
      setMessage(
        err.status === 404
          ? 'That run has no saved version.'
          : err.status === 429
            ? 'One restore every 2 seconds in this room. Try again in a moment.'
            : err.message || 'The code could not be restored.',
      );
    } finally {
      setRestoreBusy(false);
      setRestoring(null);
    }
  }, [restoring, roomId]);

  return (
    <section
      aria-label="Run and output"
      className="flex flex-col gap-3 rounded-md border border-border-strong p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-13 text-text-2">
          Input for Run
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            maxLength={65536}
            disabled={!canRun}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void go('run');
              }
            }}
            className="rounded-md border border-border-control bg-surface-1 p-2 font-mono text-13 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
          />
        </label>
        <Button
          variant="primary"
          disabled={!canRun || !pad || pending !== null}
          loading={pending === 'run'}
          onClick={() => void go('run')}
        >
          Run
        </Button>
        <Button
          disabled={!canRun || !hasProblem || !pad || pending !== null}
          loading={pending === 'submit'}
          onClick={() => void go('submit')}
          title={hasProblem ? undefined : 'Attach a problem to the room to submit'}
        >
          Submit
        </Button>
      </div>
      {!canRun ? (
        <p className="text-13 text-text-3">
          You are observing: you can read the output but not run code.
        </p>
      ) : null}
      {!hasProblem && canRun ? (
        <p className="text-13 text-text-3">
          Submit judges the room&apos;s problem on its hidden tests; this room has none attached.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-13 text-danger">
        {message}
      </p>
      <p role="status" aria-live="polite" className="text-13 text-text-2">
        {restored}
      </p>
      <ol aria-label="Runs, newest first" className="flex flex-col gap-3">
        {runs.length === 0 ? (
          <li className="text-13 text-text-3">Nothing has been run yet.</li>
        ) : null}
        {runs.map((r) => (
          <li
            key={r.runId}
            className="flex flex-col gap-1 border-t border-border-strong pt-2 text-14"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">@{r.by}</span>
              <span className="text-text-2">{r.mode === 'run' ? 'ran' : 'submitted'}</span>
              <span className="text-text-2">{languageInfo(r.language).label}</span>
              {r.status === 'done' && r.verdict ? <VerdictBadge verdict={r.verdict} /> : null}
              {r.status !== 'done' ? (
                <span className="text-text-2">{STATUS_WORD[r.status]}</span>
              ) : null}
              {r.timeMs !== null ? (
                <span className="font-mono text-13 text-text-2">{r.timeMs} ms</span>
              ) : null}
            </div>
            {r.tests.length > 0 ? (
              <ul aria-label="Tests" className="flex flex-wrap gap-x-3 gap-y-1 text-13">
                {r.tests.map((t) => (
                  <li key={t.no}>
                    Test {t.no} <span className="font-mono">{t.verdict}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {r.compileLog ? <Out label="Compiler" text={r.compileLog} /> : null}
            {r.output ? <Out label="Output" text={r.output} /> : null}
            {r.stderr ? <Out label="Errors" text={r.stderr} /> : null}
            {canRestore ? (
              <div>
                <Button size="sm" onClick={() => setRestoring(r)}>
                  Restore this version
                </Button>
              </div>
            ) : null}
            {r.truncated ? (
              <p className="text-13 text-text-3">
                The output is longer than 16 KB and has been cut.
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <Dialog open={restoring !== null} onOpenChange={(o) => (o ? undefined : setRestoring(null))}>
        <DialogContent
          title="Restore this version?"
          description="Everyone in the room will see the code go back to this run's. What was typed since stays in the replay. Anything typed at this moment is kept and may end up mixed in."
        >
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={restoreBusy} onClick={() => void restore()}>
              Restore
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Out({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-12 text-text-3">{label}</div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2 font-mono text-13">
        {text}
      </pre>
    </div>
  );
}
