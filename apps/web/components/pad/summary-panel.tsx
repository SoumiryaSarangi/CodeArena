'use client';
import type { RoomSummaryView } from '@codearena/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { roomSummary, writeRoomSummary } from '@/lib/rooms';

/** What a refusal or a failure is called in the page (the server's own words for the ones it chose). */
function say(e: unknown): string {
  const err = e as ApiError;
  if (err.status === 503) return 'The AI service is busy. Try again in a minute.';
  if (err.status === 429)
    return 'You have written the most summaries allowed this hour. Try again later.';
  if (err.status === 409)
    return 'A summary is already being written for this room. Give it a moment.';
  return err.message || 'The summary could not be written.';
}

/**
 * S14 (CP-11, FR-PAD-16): the interviewer's AI summary of the session: approach, complexity, bugs fixed and communication,
 * written from the code, the runs and the timeline (and the interviewer's own notes if ticked). It describes what the
 * data shows and never scores or recommends. It is only ever shown on this interviewer-only page.
 */
export function SummaryPanel({ roomId, hasNotes }: { roomId: string; hasNotes: boolean }) {
  const [view, setView] = useState<RoomSummaryView | null>(null);
  const [useNotes, setUseNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    roomSummary(roomId, ctl.signal).then(
      (v) => {
        setView(v);
        if (v.usedNotes !== null) setUseNotes(v.usedNotes);
      },
      (e: unknown) => {
        if ((e as Error).name !== 'AbortError') setMessage(say(e));
      },
    );
    return () => ctl.abort();
  }, [roomId]);

  const write = useCallback(async () => {
    setBusy(true);
    setMessage('');
    setCopied(false);
    try {
      setView(await writeRoomSummary(roomId, useNotes && hasNotes));
    } catch (e) {
      setMessage(say(e));
    } finally {
      setBusy(false);
    }
  }, [roomId, useNotes, hasNotes]);

  const copy = async () => {
    if (!view?.bodyMd) return;
    try {
      await navigator.clipboard.writeText(view.bodyMd);
      setCopied(true);
    } catch {
      setMessage('Your browser did not allow copying. Select the text and copy it by hand.');
    }
  };

  const ready = view?.status === 'ready' && view.bodyMd;
  return (
    <aside
      aria-label="AI summary"
      className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
    >
      <h2 className="text-18 font-semibold">AI summary</h2>
      {view === null && !message ? <Skeleton className="h-16 w-full" /> : null}
      {ready ? (
        <>
          <Markdown source={view.bodyMd!} className="text-13" />
          <p className="text-12 text-text-3">
            Written by an AI ({view.model}){' '}
            {view.generatedAt ? `on ${new Date(view.generatedAt).toLocaleString()}` : ''}; it{' '}
            {view.usedNotes ? 'read' : 'did not read'} your notes. It describes the data and can be
            wrong.
          </p>
        </>
      ) : view ? (
        <p className="text-13 text-text-3">No summary has been written for this session yet.</p>
      ) : null}
      <label className="flex items-center gap-2 text-13">
        <input
          type="checkbox"
          checked={useNotes && hasNotes}
          disabled={!hasNotes || busy}
          onChange={(e) => setUseNotes(e.target.checked)}
        />
        {hasNotes ? 'Let it read my notes' : 'It has no notes to read (you wrote none)'}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={view === null}
          onClick={() => void write()}
        >
          {ready ? 'Write it again' : 'Write the summary'}
        </Button>
        {ready ? (
          <Button size="sm" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-13 text-danger">
        {message}
      </p>
      <p className="text-12 text-text-3">
        To write it, the code, the run results, the timeline and, if ticked, your notes are sent to
        an AI service (Groq or Google). It describes what happened; it does not score the candidate
        or recommend a decision.
      </p>
    </aside>
  );
}
