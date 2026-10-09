'use client';
import type { ProblemDetail, RoomView } from '@codearena/contracts';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ConnectionPill } from '@/components/connection-pill';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { ApiError, apiGet } from '@/lib/api';
import { LANGUAGES, isLanguage, languageInfo } from '@/lib/languages';
import { clock, closeRoom, createInvite, roomGet } from '@/lib/rooms';
import { signInHref, useSession } from '@/lib/session';
import { PresenceList, PresenceStyles } from './presence';
import { NotesPanel } from './notes-panel';
import { RunPanel } from './run-panel';
import { usePad } from './use-pad';

const PadEditor = dynamic(() => import('./pad-editor'), {
  ssr: false,
  loading: () => <Skeleton className="size-full min-h-40" />,
});

/** S13 `/r/{roomId}`: gate, load the room, then the live pad. */
export function RoomPage({ roomId }: { roomId: string }) {
  const { session } = useSession();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const authed = session.status === 'authed';

  useEffect(() => {
    if (!authed) return;
    const ctl = new AbortController();
    roomGet(roomId, ctl.signal)
      .then(setRoom)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [roomId, authed]);

  if (session.status === 'loading') return <Skeleton className="h-96 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to join this room."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref(`/r/${roomId}`)}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (error) {
    return error.status === 404 ? (
      <EmptyState
        message="No such room, or you are not in it. Ask the interviewer for an invite link."
        action={
          <Button asChild variant="secondary">
            <Link href="/interview">Your rooms</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState message={error.message} requestId={error.requestId} />
    );
  }
  if (!room) return <Skeleton className="h-96 w-full" />;
  if (room.status !== 'open') {
    return (
      <EmptyState
        message="This room has ended."
        action={
          <Button asChild variant="secondary">
            <Link href="/interview">Your rooms</Link>
          </Button>
        }
      />
    );
  }
  return <LiveRoom room={room} />;
}

function LiveRoom({ room }: { room: RoomView }) {
  const router = useRouter();
  const { session } = useSession();
  const handle = session.status === 'authed' ? session.me.handle : null;
  // The colour is the person's place in the member list, as the server assigns it (CP-01).
  const at = room.members.findIndex((m) => m.handle === handle);
  const { pad, status, synced, peers } = usePad(
    room.id,
    handle ? { name: handle, role: room.role, colorIndex: Math.max(0, at) % 8 } : undefined,
  );
  const observer = room.role === 'observer';
  const interviewer = room.role === 'interviewer';

  // The language is shared through the document, so a change reaches everyone (US-10.2 AC2).
  const [language, setLanguage] = useState(room.language);
  useEffect(() => {
    if (!pad) return;
    const meta = pad.doc.getMap<string>('meta');
    const read = () => {
      const v = meta.get('language');
      if (v && isLanguage(v)) setLanguage(v);
    };
    meta.observe(read);
    read();
    return () => meta.unobserve(read);
  }, [pad]);
  useEffect(() => {
    if (!pad || !synced || observer) return;
    const meta = pad.doc.getMap<string>('meta');
    if (!meta.get('language')) meta.set('language', room.language);
  }, [pad, synced, observer, room.language]);

  // The timer counts from the room's creation; the room ends for good at `expiresAt`.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = (now - Date.parse(room.createdAt)) / 1000;
  const over = room.durationMin !== null && elapsed > room.durationMin * 60;
  const ended = now >= Date.parse(room.expiresAt);

  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [showProblem, setShowProblem] = useState(true);
  useEffect(() => {
    if (!room.problem) return;
    const ctl = new AbortController();
    apiGet<ProblemDetail>(`/problems/${encodeURIComponent(room.problem.slug)}`, ctl.signal).then(
      setProblem,
      () => undefined,
    );
    return () => ctl.abort();
  }, [room.problem]);

  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [panel, setPanel] = useState('code');
  const [failure, setFailure] = useState<string | null>(null);

  const copyInvite = async (role: 'candidate' | 'observer') => {
    setBusy(true);
    setFailure(null);
    try {
      const inv = await createInvite(room.id, role);
      try {
        await navigator.clipboard.writeText(inv.url);
        setLink(null);
        setNote(`${role === 'candidate' ? 'Candidate' : 'Observer'} link copied.`);
      } catch {
        setLink(inv.url); // no clipboard (or no permission): show it to copy by hand
        setNote(`${role === 'candidate' ? 'Candidate' : 'Observer'} link ready below.`);
      }
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    setBusy(true);
    try {
      await closeRoom(room.id);
      router.push(`/r/${room.id}/replay`);
    } catch (e) {
      setFailure((e as Error).message);
      setBusy(false);
      setConfirmEnd(false);
    }
  };

  if (ended || status === 'denied') {
    return (
      <EmptyState
        message={
          ended
            ? 'This room has ended.'
            : 'You cannot join this room right now. It may have ended; ask the interviewer.'
        }
        action={
          <Button asChild variant="secondary">
            <Link href="/interview">Your rooms</Link>
          </Button>
        }
      />
    );
  }

  const info = languageInfo(language);
  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col gap-3">
      <PresenceStyles peers={peers} />
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-18 font-semibold">{room.problem?.title ?? 'Interview room'}</h1>
        <span className="font-mono text-14" aria-label="Time in the room">
          {clock(elapsed)}
          {room.durationMin ? ` / ${clock(room.durationMin * 60)}` : ''}
        </span>
        {over ? <span className="text-13 text-warning">Planned time is up</span> : null}
        <ConnectionPill state={status === 'reconnecting' ? 'reconnecting' : 'connected'} />
        <PresenceList peers={peers} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            label="Language"
            value={language}
            disabled={observer}
            onChange={(e) => pad?.doc.getMap<string>('meta').set('language', e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
          {interviewer ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void copyInvite('candidate')}>
                Copy candidate link
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void copyInvite('observer')}>
                Copy observer link
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => setConfirmEnd(true)}
              >
                End room
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {observer ? (
        <p
          role="status"
          className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-14"
        >
          You&apos;re observing: read-only.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-13 text-text-2">
        {note}
      </p>
      {link ? (
        <input
          readOnly
          aria-label="Invite link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="h-8 rounded-md border border-border-control bg-surface-1 px-2 font-mono text-13"
        />
      ) : null}
      {failure ? (
        <p role="alert" className="text-13 text-danger">
          {failure}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_22rem]">
        <Tabs value={panel} onValueChange={setPanel} className="flex min-w-0 flex-col gap-3">
          <TabsList aria-label="Room panels">
            <TabsTrigger value="code">Code</TabsTrigger>
            {interviewer ? (
              <TabsTrigger value="notes" title="Private: only you can see these">
                <span className="inline-flex items-center gap-1">
                  <Lock className="size-3.5" aria-hidden />
                  Notes
                </span>
              </TabsTrigger>
            ) : null}
          </TabsList>
          {/* both stay mounted: switching must not unbind the editor or lose unsaved notes */}
          <TabsContent
            value="code"
            forceMount
            hidden={panel !== 'code'}
            className="flex min-w-0 flex-col gap-3"
          >
            <section
              aria-label="Shared code"
              className="min-h-96 overflow-hidden rounded-md border border-border-strong"
            >
              {pad && synced ? (
                <PadEditor
                  key={pad.doc.guid}
                  pad={pad}
                  language={info.monaco}
                  readOnly={observer}
                  label={`Shared code, ${info.label}${observer ? ', read-only' : ''}`}
                />
              ) : (
                <div role="status" className="p-4 text-14 text-text-2">
                  {status === 'reconnecting' ? 'Reconnecting…' : 'Joining the room…'}
                  <Skeleton className="mt-3 h-40 w-full" />
                </div>
              )}
            </section>
            <RunPanel
              roomId={room.id}
              pad={pad}
              language={language}
              canRun={!observer}
              hasProblem={!!room.problem}
            />
          </TabsContent>
          {interviewer ? (
            <TabsContent value="notes" forceMount hidden={panel !== 'notes'}>
              <NotesPanel roomId={room.id} />
            </TabsContent>
          ) : null}
        </Tabs>
        {room.problem ? (
          <aside
            aria-label="Problem"
            className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-14 font-medium">{room.problem.title}</h2>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={showProblem}
                onClick={() => setShowProblem((v) => !v)}
              >
                {showProblem ? 'Hide' : 'Show'}
              </Button>
            </div>
            {showProblem ? (
              problem ? (
                <Markdown source={problem.statementMd.replace(/^\s*# .*\n+/, '')} />
              ) : (
                <Skeleton className="h-32 w-full" />
              )
            ) : null}
          </aside>
        ) : null}
      </div>

      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent
          title="End this room?"
          description="Everyone is disconnected and the invite links stop working."
        >
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
              Keep it open
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void end()}>
              End room
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
