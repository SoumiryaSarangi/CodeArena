'use client';
import type { Announcement } from '@codearena/contracts';
import { Megaphone } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The latest announcement, shown on every page of a contest until the contestant dismisses it, so a
 * message sent from the ops console cannot be missed by looking at the wrong page or by a toast
 * that has already gone (C-09).
 */
export function AnnouncementBanner({
  note,
  onDismiss,
}: {
  note: Announcement;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-3 rounded-md border border-accent bg-surface-1 px-3 py-2"
    >
      <Megaphone className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-14">
        <p className="text-12 text-text-3">
          Announcement from the organisers ·{' '}
          <time dateTime={note.createdAt}>
            {new Date(note.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </p>
        <p className="whitespace-pre-line break-words">{note.body}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
