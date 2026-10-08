'use client';
import type { Announcement } from '@codearena/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AnnouncementBanner } from '@/components/contests/announcement-banner';
import { contestDetail } from './contests';
import { useSession } from './session';
import { useContestMessages } from './use-contest-messages';

type Messages = ReturnType<typeof useContestMessages>;

interface Value {
  slug: string;
  /** Signed in and registered (or an admin): messages are live. */
  active: boolean;
  messages: Messages;
  /** Re-read the contest, e.g. right after registering. */
  reload: () => void;
}

const Ctx = createContext<Value | null>(null);

/** The messages of the contest the page belongs to; null outside `/c/[slug]/…`. */
export const useContestMessagesContext = () => useContext(Ctx);

const key = (slug: string) => `ca:dismissed-announcements:${slug}`;
const read = (slug: string): string[] => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(key(slug)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Pure: the announcement to show, or null (nothing new, already dismissed, or the contest is over). */
export function bannerNote(
  notes: Announcement[],
  dismissed: ReadonlySet<string>,
  contestOver: boolean,
): Announcement | null {
  const latest = notes[0];
  if (!latest || contestOver || dismissed.has(latest.id)) return null;
  return latest;
}

/**
 * One subscription to the contest's announcements and clarifications for the whole contest area
 * (lobby, problems, board), plus the banner. Before C-09 only the problem page listened, so a
 * contestant on any other page never saw an announcement.
 */
export function ContestMessagesProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const { session } = useSession();
  const [contest, setContest] = useState<{ id: string; registered: boolean; over: boolean } | null>(
    null,
  );
  const [tick, setTick] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const meId = session.status === 'authed' ? session.me.id : undefined;
  const admin = session.status === 'authed' && session.me.role === 'admin';
  const ready = session.status !== 'loading';

  useEffect(() => {
    if (!ready || !meId) {
      setContest(null);
      return;
    }
    const ctl = new AbortController();
    contestDetail(slug, ctl.signal)
      .then((c) =>
        setContest({
          id: c.id,
          registered: c.registered,
          over: c.state === 'ended' || c.state === 'finalized',
        }),
      )
      .catch(() => setContest(null));
    return () => ctl.abort();
  }, [slug, ready, meId, tick]);

  useEffect(() => setDismissed(new Set(read(slug))), [slug]);

  const active = !!meId && !!contest && (contest.registered || admin);
  const messages = useContestMessages(slug, contest?.id, meId, active);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const note = bannerNote(messages.notes, dismissed, contest?.over ?? false);
  const dismiss = () => {
    if (!note) return;
    const next = new Set(dismissed).add(note.id);
    setDismissed(next);
    try {
      window.localStorage.setItem(key(slug), JSON.stringify([...next].slice(-50)));
    } catch {
      /* private window: the banner just comes back on the next visit */
    }
  };

  const value = useMemo(
    () => ({ slug, active, messages, reload }),
    [slug, active, messages, reload],
  );
  return (
    <Ctx.Provider value={value}>
      {active && note ? <AnnouncementBanner note={note} onDismiss={dismiss} /> : null}
      {children}
    </Ctx.Provider>
  );
}
