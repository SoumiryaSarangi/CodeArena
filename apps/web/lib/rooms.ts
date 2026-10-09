import type {
  RoomCreate,
  RoomInvite,
  RoomInviteCreate,
  RoomJoined,
  RoomList,
  RoomRunAccepted,
  RoomRunCreate,
  RoomRunList,
  RoomView,
  TicketResponse,
} from '@codearena/contracts';
import { apiFetch } from './api';

/** Interview rooms (S13). Members only; the API decides what each role may do. */
const enc = encodeURIComponent;

export const roomList = (signal?: AbortSignal) =>
  apiFetch<RoomList>('GET', '/rooms', undefined, { auth: 'required', signal });

export const roomGet = (id: string, signal?: AbortSignal) =>
  apiFetch<RoomView>('GET', `/rooms/${enc(id)}`, undefined, { auth: 'required', signal });

export const createRoom = (body: RoomCreate) =>
  apiFetch<RoomView>('POST', '/rooms', body, { auth: 'required' });

export const createInvite = (id: string, role: RoomInviteCreate['role']) =>
  apiFetch<RoomInvite>('POST', `/rooms/${enc(id)}/invites`, { role }, { auth: 'required' });

export const joinRoom = (token: string) =>
  apiFetch<RoomJoined>('POST', '/rooms/join', { token }, { auth: 'required' });

export const closeRoom = (id: string) =>
  apiFetch<{ status: 'closed' }>('POST', `/rooms/${enc(id)}/close`, undefined, {
    auth: 'required',
  });

/** CP-04: run or submit the room's shared code. 202; the verdict arrives on the room's SSE topic. */
export const startRoomRun = (id: string, body: RoomRunCreate) =>
  apiFetch<RoomRunAccepted>('POST', `/rooms/${enc(id)}/runs`, body, { auth: 'required' });

export const roomRuns = (id: string, signal?: AbortSignal) =>
  apiFetch<RoomRunList>('GET', `/rooms/${enc(id)}/runs`, undefined, { auth: 'required', signal });

/** A single-use ticket for the pad connection; the provider asks for a fresh one on every (re)connect. */
export const padTicket = async (roomId: string) =>
  (await apiFetch<TicketResponse>('POST', '/realtime/ticket', { roomId }, { auth: 'required' }))
    .ticket;

/** Where the collab server listens for browsers, e.g. `wss://api.example.org/collab`. Inlined at build time. */
export const collabUrl = (roomId: string) =>
  `${(process.env.NEXT_PUBLIC_COLLAB_URL ?? 'ws://localhost:1234').replace(/\/$/, '')}/${roomId}`;

export const ROOM_ROLE_TEXT = {
  interviewer: 'Interviewer',
  candidate: 'Candidate',
  observer: 'Observer',
} as const;

/** `12:03` or `1:02:03`. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}
