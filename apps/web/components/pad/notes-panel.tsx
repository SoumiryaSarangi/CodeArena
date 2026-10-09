'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { roomNotes, saveRoomNotes } from '@/lib/rooms';

export const AUTOSAVE_MS = 1000;

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string }
  | { kind: 'conflict' };

const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * CP-05 (FR-PAD-09): the interviewer's private notes. Rendered only for the interviewer; nobody else even asks the API.
 * Autosaves 1 s after the last keystroke, when the box loses focus, when the page is hidden and when the panel goes away.
 * Each save says what it was based on, so a second window cannot be overwritten without a word.
 */
export function NotesPanel({ roomId }: { roomId: string }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const latest = useRef('');
  const base = useRef<string | null>(null);
  const savedText = useRef('');
  const inFlight = useRef(false);
  const blocked = useRef(false); // a conflict is waiting for a decision
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    roomNotes(roomId, ctl.signal).then(
      (n) => {
        latest.current = savedText.current = n.body;
        base.current = n.updatedAt;
        setText(n.body);
        setStatus({ kind: 'idle' });
      },
      (e: unknown) => {
        if ((e as Error).name !== 'AbortError')
          setStatus({ kind: 'error', message: (e as Error).message });
      },
    );
    return () => ctl.abort();
  }, [roomId]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current || blocked.current || latest.current === savedText.current) return;
    if (status.kind === 'loading') return;
    inFlight.current = true;
    setStatus({ kind: 'saving' });
    const sending = latest.current;
    try {
      const saved = await saveRoomNotes(roomId, { body: sending, baseUpdatedAt: base.current });
      base.current = saved.updatedAt;
      savedText.current = sending;
      setStatus({ kind: 'saved', at: new Date() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        blocked.current = true;
        setStatus({ kind: 'conflict' });
      } else {
        setStatus({ kind: 'error', message: (e as Error).message || 'could not reach the server' });
      }
    } finally {
      inFlight.current = false;
    }
    // more was typed while saving
    if (!blocked.current && latest.current !== savedText.current) void flush();
  }, [roomId, status.kind]);

  const onChange = (value: string) => {
    setText(value);
    latest.current = value;
    if (blocked.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  // Hidden tab, or the panel going away: do not leave unsaved text behind.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      void flush();
    };
  }, [flush]);

  const useSaved = async () => {
    try {
      const n = await roomNotes(roomId);
      latest.current = savedText.current = n.body;
      base.current = n.updatedAt;
      blocked.current = false;
      setText(n.body);
      setStatus({ kind: 'saved', at: new Date() });
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  };
  const keepMine = async () => {
    try {
      const n = await roomNotes(roomId); // learn what is stored now, then write mine over it on purpose
      base.current = n.updatedAt;
      savedText.current = n.body;
      blocked.current = false;
      await flush();
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  };

  return (
    <section
      aria-label="Private notes"
      className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
    >
      <label htmlFor="notes-box" className="text-14 font-medium">
        Private notes: only you can see these
      </label>
      <textarea
        id="notes-box"
        value={text}
        disabled={status.kind === 'loading'}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void flush()}
        rows={14}
        maxLength={65536}
        placeholder="Approach, communication, bugs found, follow-up questions…"
        className="min-h-60 rounded-md border border-border-control bg-surface-1 p-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <p role="status" aria-live="polite" className="text-13 text-text-2">
        {status.kind === 'loading' && 'Loading…'}
        {status.kind === 'saving' && 'Saving…'}
        {status.kind === 'saved' && `Saved ${clock(status.at)}`}
        {status.kind === 'idle' && 'Notes save by themselves.'}
        {status.kind === 'error' && (
          <span className="text-danger">Not saved: {status.message}</span>
        )}
        {status.kind === 'conflict' && (
          <span className="text-warning">
            Not saved: these notes were saved from another window.
          </span>
        )}
      </p>
      {status.kind === 'conflict' ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void useSaved()}>
            Use the saved version
          </Button>
          <Button size="sm" variant="primary" onClick={() => void keepMine()}>
            Keep mine
          </Button>
        </div>
      ) : null}
    </section>
  );
}
