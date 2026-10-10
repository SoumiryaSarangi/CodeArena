'use client';
import type {
  AdminClarificationItem,
  AdminContestDetail,
  ClarificationNewEvent,
} from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { StateLabel } from '@/components/contests/state-label';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { adminContest, adminInbox, announce, answerClarification } from '@/lib/contests';
import { subscribe } from '@/lib/realtime';
import { cn } from '@/lib/cn';
import { ActionError } from './problem-errors';
import { ExamPanel } from './exam-panel';
import { OpsConsole } from './ops-console';

/** Open questions first (oldest first: they have waited longest), then answered ones. */
const order = (items: AdminClarificationItem[]) => {
  const open = items
    .filter((i) => i.answer === null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const done = items
    .filter((i) => i.answer !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return [...open, ...done];
};

/**
 * S16: the queue and judge panel with the contest actions (`OpsConsole`, C-07), the announcement
 * box and the clarification inbox (answer privately or for everyone; `j`/`k` move, `r` replies;
 * C-05).
 */
export function ContestOps({ id }: { id: string }) {
  const [contest, setContest] = useState<AdminContestDetail | null>(null);
  const [items, setItems] = useState<AdminClarificationItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteFailure, setNoteFailure] = useState<Error | null>(null);
  const [sent, setSent] = useState('');
  const replyBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([adminContest(id, ctl.signal), adminInbox(id, ctl.signal)])
      .then(([c, i]) => {
        setContest(c);
        setItems(order(i.items));
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [id, attempt]);

  // New questions arrive on the admins' topic; a reconnect re-reads the inbox.
  useEffect(() => {
    let wasDown = false;
    return subscribe(
      [`admin:contest:${id}:clar`],
      (e) => {
        if (e.type !== 'clar.new') return;
        const { item } = e.data as unknown as ClarificationNewEvent;
        setItems((l) => order([item, ...l.filter((i) => i.id !== item.id)]));
      },
      (s) => {
        if (s === 'reconnecting' || s === 'offline') wasDown = true;
        if (s === 'connected' && wasDown) {
          wasDown = false;
          setAttempt((n) => n + 1);
        }
      },
    );
  }, [id]);

  const current = items.find((i) => i.id === selected) ?? null;
  const pick = useCallback((item: AdminClarificationItem) => {
    setSelected(item.id);
    setReply(item.answer ?? '');
    setIsPublic(item.answer ? item.isPublic : false);
    setFailure(null);
  }, []);

  // j / k move through the inbox, r jumps to the reply box (S16); not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (t instanceof HTMLElement &&
          (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))
      )
        return;
      if (e.key === 'j' || e.key === 'k') {
        const i = items.findIndex((x) => x.id === selected);
        const next = items[e.key === 'j' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
        if (next) {
          e.preventDefault();
          pick(next);
        }
      } else if (e.key === 'r' && selected) {
        e.preventDefault();
        replyBox.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selected, pick]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await answerClarification(current.id, { answer: reply, isPublic });
      setItems((l) => order(l.map((i) => (i.id === done.id ? done : i))));
      setSent(isPublic ? 'Answer sent to everyone.' : `Answer sent to ${done.askerHandle}.`);
      // Move on to the next open question, as an inbox should.
      const next = order(items.map((i) => (i.id === done.id ? done : i))).find(
        (i) => i.answer === null,
      );
      if (next) pick(next);
      else setSelected(null);
    } catch (err) {
      setFailure(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const post = async (e: FormEvent) => {
    e.preventDefault();
    setNoteBusy(true);
    setNoteFailure(null);
    try {
      const r = await announce(id, note);
      setNote('');
      setSent(
        `Announcement posted for ${r.registered} registered contestant${r.registered === 1 ? '' : 's'}. ` +
          (r.reached > 0
            ? `${r.reached} connected right now saw it live; everyone else sees it when they open the contest.`
            : 'Nobody is connected right now; each contestant sees it as a banner when they open the contest.'),
      );
    } catch (err) {
      setNoteFailure(err as Error);
    } finally {
      setNoteBusy(false);
    }
  };

  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such contest." />
    ) : (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!contest) return <Skeleton className="h-96 w-full" />;
  const open = items.filter((i) => i.answer === null).length;

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <StateLabel state={contest.state} />
        <h1 className="text-28 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
          {contest.title}: operations
        </h1>
        <p className="text-13 text-text-2">
          <Link href={`/admin/contests/${id}`} className="underline">
            Edit the contest
          </Link>{' '}
          ·{' '}
          <Link href={`/c/${contest.slug}/board`} className="underline">
            Scoreboard
          </Link>
        </p>
      </div>
      <p role="status" className="text-13 text-v-ac">
        {sent}
      </p>

      <OpsConsole contest={contest} onChanged={() => setAttempt((n) => n + 1)} />

      {contest.rules.examMode ? <ExamPanel id={id} /> : null}

      <form onSubmit={post} className="flex flex-col gap-2" aria-label="Announcement">
        <h2 className="text-22 font-semibold">Announce to everyone</h2>
        <label className="flex flex-col gap-1 text-13 text-text-2">
          Message
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            className="rounded-md border border-border-control bg-surface-1 px-3 py-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </label>
        {noteFailure ? <ActionError error={noteFailure} /> : null}
        <div>
          <Button type="submit" variant="primary" loading={noteBusy} disabled={note.trim() === ''}>
            Send announcement
          </Button>
        </div>
      </form>

      <section aria-labelledby="inbox" className="flex flex-col gap-3">
        <h2 id="inbox" className="text-22 font-semibold">
          Clarifications{' '}
          <span className="font-normal text-text-2">
            ({open} waiting · <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd>{' '}
            move, <kbd className="font-mono">r</kbd> replies)
          </span>
        </h2>
        {items.length === 0 ? (
          <EmptyState message="No questions yet." />
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <ul aria-label="Inbox" className="flex flex-col gap-1">
              {items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => pick(i)}
                    aria-pressed={i.id === selected}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-md border border-border-strong px-3 py-2 text-left hover:bg-surface-2',
                      i.id === selected && 'border-accent bg-surface-2',
                    )}
                  >
                    <span className="text-12 text-text-3">
                      {i.askerHandle} · {i.problemLabel ? `Problem ${i.problemLabel}` : 'General'} ·{' '}
                      {i.answer
                        ? i.isPublic
                          ? 'Answered (public)'
                          : 'Answered (private)'
                        : 'Waiting'}
                    </span>
                    <span className="line-clamp-2 text-14">{i.question}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div>
              {current ? (
                <form onSubmit={send} className="flex flex-col gap-2" aria-label="Answer">
                  <p className="text-12 text-text-3">
                    {current.askerHandle} ·{' '}
                    {current.problemLabel ? `Problem ${current.problemLabel}` : 'General'}
                  </p>
                  <p className="text-14">{current.question}</p>
                  <label className="flex flex-col gap-1 text-13 text-text-2">
                    Answer
                    <textarea
                      ref={replyBox}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      maxLength={2000}
                      rows={4}
                      className="rounded-md border border-border-control bg-surface-1 px-3 py-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-14">
                    <input
                      type="checkbox"
                      checked={isPublic}
                      onChange={(e) => setIsPublic(e.target.checked)}
                    />
                    Public: show this question and answer to every contestant
                  </label>
                  {failure ? <ActionError error={failure} /> : null}
                  <div>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={busy}
                      disabled={reply.trim() === ''}
                    >
                      {current.answer ? 'Update answer' : 'Send answer'}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="text-14 text-text-2">Pick a question to answer it.</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
