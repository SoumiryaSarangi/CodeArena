'use client';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { collabUrl, padTicket } from '@/lib/rooms';

export type PadStatus = 'connecting' | 'connected' | 'reconnecting' | 'denied';

/** A person in the room, from awareness; the server wrote `user`, the client cannot (FR-PAD-04). */
export interface Peer {
  clientId: number;
  name: string;
  role: 'interviewer' | 'candidate' | 'observer';
  colorIndex: number;
  self: boolean;
}

export interface Pad {
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

/**
 * The shared document of a room (SD-§11): one Y.Doc named `room:{id}`, a Hocuspocus provider that fetches a fresh
 * single-use ticket for every (re)connect, and the connection state and the people present as React state.
 */
export function usePad(roomId: string, me?: Omit<Peer, 'clientId' | 'self'>) {
  const [pad, setPad] = useState<Pad | null>(null);
  const [status, setStatus] = useState<PadStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const doc = new Y.Doc();
    let everConnected = false;
    const provider = new HocuspocusProvider({
      url: collabUrl(roomId),
      name: `room:${roomId}`,
      document: doc,
      token: () => padTicket(roomId),
      onStatus: ({ status: s }) => {
        if (s === 'connected') {
          everConnected = true;
          setStatus('connected');
        } else if (s === 'disconnected') {
          setStatus((prev) =>
            prev === 'denied' ? prev : everConnected ? 'reconnecting' : 'connecting',
          );
        }
      },
      onAuthenticationFailed: () => setStatus('denied'),
      onSynced: () => setSynced(true),
      onAwarenessChange: ({ states }) => {
        const list: Peer[] = [];
        for (const st of states as { clientId: number; user?: Partial<Peer> }[]) {
          const u = st.user;
          if (!u || typeof u.name !== 'string' || !u.role) continue;
          list.push({
            clientId: st.clientId,
            name: u.name,
            role: u.role,
            colorIndex: Number(u.colorIndex ?? 0),
            self: st.clientId === doc.clientID,
          });
        }
        setPeers(list);
      },
    });
    setPad({ doc, provider });
    return () => {
      provider.destroy();
      doc.destroy();
      setPad(null);
      setSynced(false);
      setPeers([]);
    };
  }, [roomId]);

  // The server does not echo a person's own state back, so "you" comes from what the API said about this member.
  const everyone: Peer[] =
    me && pad && !peers.some((p) => p.self)
      ? [{ ...me, clientId: pad.doc.clientID, self: true }, ...peers]
      : peers;
  return { pad, status, synced, peers: everyone };
}
