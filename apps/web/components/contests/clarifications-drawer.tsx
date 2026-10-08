'use client';
import type { Announcement, ClarificationItem } from '@codearena/contracts';
import { MessageSquare } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { askClarification } from '@/lib/contests';
import { cn } from '@/lib/cn';

const MAX = 2000;

/** The contest bar's Clarifications button (with the unread count) and its drawer (S09). */
export function ClarificationsDrawer({
  slug,
  labels,
  items,
  notes,
  unread,
  unreadIds,
  canAsk,
  onAsked,
  onOpen,
  defaultLabel,
}: {
  slug: string;
  labels: string[];
  items: ClarificationItem[];
  notes: Announcement[];
  unread: number;
  unreadIds: Set<string>;
  canAsk: boolean;
  onAsked: (item: ClarificationItem) => void;
  onOpen: () => void;
  defaultLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(defaultLabel ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was new when the drawer opened stays highlighted while it is open.
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const change = (next: boolean) => {
    if (next) {
      setFresh(new Set(unreadIds));
      setLabel(defaultLabel ?? '');
      onOpen();
    }
    setOpen(next);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAsked(await askClarification(slug, { problemLabel: label || null, question: text }));
      setText('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'You are asking too fast. Wait a moment.'
          : err instanceof ApiError
            ? err.message
            : 'Could not send. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={unread > 0 ? `Clarifications, ${unread} new` : 'Clarifications'}
        >
          <MessageSquare className="size-4" aria-hidden />
          <span aria-hidden>Clarifications</span>
          {unread > 0 ? (
            <span
              aria-hidden
              className="rounded-sm bg-accent px-1 font-mono text-12 text-accent-fg"
            >
              {unread}
            </span>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent
        variant="drawer"
        title="Clarifications"
        description="Ask the organisers. Answers meant for everyone appear here for all contestants."
      >
        <div className="flex flex-col gap-6">
          {notes.length > 0 ? (
            <section aria-label="Announcements" className="flex flex-col gap-2">
              <h3 className="text-14 font-medium">Announcements</h3>
              <ul className="flex flex-col gap-2">
                {notes.map((n) => (
                  <li
                    key={n.id}
                    className={cn(
                      'rounded-md border border-border-strong p-2 text-14',
                      fresh.has(n.id) && 'border-accent',
                    )}
                  >
                    {n.body}
                    <time className="mt-1 block text-12 text-text-3" dateTime={n.createdAt}>
                      {new Date(n.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {canAsk ? (
            <form onSubmit={submit} className="flex flex-col gap-2" aria-label="Ask a question">
              <h3 className="text-14 font-medium">Ask a question</h3>
              <label className="flex flex-col gap-1 text-13 text-text-2">
                About
                <select
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="h-8 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <option value="">General</option>
                  {labels.map((l) => (
                    <option key={l} value={l}>
                      Problem {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-13 text-text-2">
                Question
                <textarea
                  value={text}
                  maxLength={MAX}
                  rows={3}
                  required
                  onChange={(e) => setText(e.target.value)}
                  className="rounded-md border border-border-control bg-surface-1 px-3 py-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                />
              </label>
              <div className="flex items-center justify-between">
                <span className="font-mono text-12 text-text-3">
                  {text.length}/{MAX}
                </span>
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy}
                  disabled={text.trim() === ''}
                >
                  Send
                </Button>
              </div>
              {error ? (
                <p role="alert" className="text-13 text-danger">
                  {error}
                </p>
              ) : null}
            </form>
          ) : (
            <p className="text-13 text-text-2">Questions can be asked while the contest runs.</p>
          )}

          <section aria-label="Questions and answers" className="flex flex-col gap-2">
            <h3 className="text-14 font-medium">Questions and answers</h3>
            {items.length === 0 ? (
              <p className="text-13 text-text-2">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((i) => (
                  <li
                    key={i.id}
                    className={cn(
                      'rounded-md border border-border-strong p-2 text-14',
                      fresh.has(i.id) && 'border-accent',
                    )}
                  >
                    <p className="text-12 text-text-3">
                      {i.mine ? 'You asked' : 'Asked'} ·{' '}
                      {i.problemLabel ? `Problem ${i.problemLabel}` : 'General'}
                      {i.answer
                        ? i.isPublic
                          ? ' · answered for everyone'
                          : ' · answered privately'
                        : ''}
                    </p>
                    <p className="mt-1">{i.question}</p>
                    {i.answer ? (
                      <p className="mt-2 border-l-2 border-accent pl-2">
                        <span className="sr-only">Answer: </span>
                        {i.answer}
                      </p>
                    ) : (
                      <p className="mt-2 text-13 text-text-2">Waiting for an answer…</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
