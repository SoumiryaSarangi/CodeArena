'use client';
import type {
  Announcement,
  AnnouncementEvent,
  ClarificationEvent,
  ClarificationItem,
} from '@codearena/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { announcements, clarifications } from './contests';
import { subscribe } from './realtime';

/** Newest first, one entry per id; a later copy replaces an earlier one. */
function upsert(list: ClarificationItem[], item: ClarificationItem): ClarificationItem[] {
  const old = list.find((i) => i.id === item.id);
  // `mine` is only known from my own list or my private topic: an event on the public topic
  // never takes it away.
  const merged = old ? { ...item, mine: old.mine || item.mine } : item;
  return [merged, ...list.filter((i) => i.id !== item.id)].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
}

/**
 * My clarifications, the public answers and the announcements of a contest (S09 drawer), kept live
 * over `contest:{id}:clar` and `contest:{id}:u:{me}`. New answers and announcements raise a toast
 * and count as unread until the drawer is opened. A reconnect re-reads the lists.
 */
export function useContestMessages(
  slug: string,
  contestId: string | undefined,
  userId: string | undefined,
  enabled: boolean,
) {
  const [items, setItems] = useState<ClarificationItem[]>([]);
  const [notes, setNotes] = useState<Announcement[]>([]);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    Promise.all([clarifications(slug, ctl.signal), announcements(slug, ctl.signal)])
      .then(([c, a]) => {
        setItems(c.items);
        setNotes(a.items);
        loaded.current = true;
      })
      .catch(() => undefined); // the drawer shows what it has
    return () => ctl.abort();
  }, [slug, enabled, attempt]);

  useEffect(() => {
    if (!enabled || !contestId || !userId) return;
    let wasDown = false;
    const stop = subscribe(
      [`contest:${contestId}:clar`, `contest:${contestId}:u:${userId}`],
      (e) => {
        if (e.type === 'clar.answer') {
          const { item } = e.data as unknown as ClarificationEvent;
          setItems((l) => upsert(l, item));
          setUnread((u) => new Set(u).add(item.id));
          toast(item.mine ? 'Your question was answered' : 'New clarification', {
            description: item.answer ?? undefined,
          });
        } else if (e.type === 'announce.new') {
          const { item } = e.data as unknown as AnnouncementEvent;
          setNotes((l) => (l.some((a) => a.id === item.id) ? l : [item, ...l]));
          setUnread((u) => new Set(u).add(item.id));
          toast('Announcement', { description: item.body });
        }
      },
      (s) => {
        if (s === 'reconnecting' || s === 'offline') wasDown = true;
        if (s === 'connected' && wasDown) {
          wasDown = false;
          setAttempt((n) => n + 1);
        }
      },
    );
    return stop;
  }, [contestId, userId, enabled]);

  const added = useCallback((item: ClarificationItem) => setItems((l) => upsert(l, item)), []);
  const markRead = useCallback(() => setUnread(new Set()), []);
  return { items, notes, unreadIds: unread, unread: unread.size, added, markRead };
}
