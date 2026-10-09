import { z } from 'zod';
import { RoomRole } from './collab';
import { Language } from './enums';

/** Interview rooms (CP-02): SRS §3.1.2 rooms, FR-PAD-01/02, US-10.1. Dates are ISO strings. */

export const ROOM_DURATIONS = [30, 45, 60, 90] as const;
export const RoomDuration = z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
/** More than this many open rooms per person is a script, not an interviewer. */
export const MAX_OPEN_ROOMS = 5;
/** Per room: the interviewer, a candidate, some observers. */
export const MAX_ROOM_MEMBERS = 8;

export const RoomStatus = z.enum(['open', 'closed', 'archived']);
export type RoomStatus = z.infer<typeof RoomStatus>;

/** POST /api/rooms */
export const RoomCreate = z
  .object({
    problemSlug: z.string().min(1).max(100).optional(),
    language: Language,
    durationMin: RoomDuration,
  })
  .strict()
  .meta({ id: 'RoomCreate' });
export type RoomCreate = z.infer<typeof RoomCreate>;

export const RoomSummary = z
  .object({
    id: z.uuid(),
    /** The viewer's role in the room. */
    role: RoomRole,
    status: RoomStatus,
    language: z.string(),
    durationMin: z.number().int().nullable(),
    problem: z.object({ slug: z.string(), title: z.string() }).strict().nullable(),
    createdAt: z.string(),
    /** The session ends then whatever the timer says: creation + 90 minutes. */
    expiresAt: z.string(),
    memberCount: z.number().int(),
  })
  .strict()
  .meta({ id: 'RoomSummary' });
export type RoomSummary = z.infer<typeof RoomSummary>;

export const RoomList = z
  .object({ items: z.array(RoomSummary) })
  .strict()
  .meta({ id: 'RoomList' });
export type RoomList = z.infer<typeof RoomList>;

/** GET /api/rooms/{id}: for members only. */
export const RoomView = RoomSummary.extend({
  members: z.array(z.object({ handle: z.string(), role: RoomRole }).strict()),
})
  .strict()
  .meta({ id: 'RoomView' });
export type RoomView = z.infer<typeof RoomView>;

/** POST /api/rooms/{id}/invites */
export const RoomInviteCreate = z
  .object({ role: z.enum(['candidate', 'observer']) })
  .strict()
  .meta({ id: 'RoomInviteCreate' });
export type RoomInviteCreate = z.infer<typeof RoomInviteCreate>;

export const RoomInvite = z
  .object({ url: z.string(), expiresAt: z.string() })
  .strict()
  .meta({ id: 'RoomInvite' });
export type RoomInvite = z.infer<typeof RoomInvite>;

/** POST /api/rooms/join */
export const RoomJoin = z
  .object({ token: z.string().min(20).max(200) })
  .strict()
  .meta({ id: 'RoomJoin' });
export type RoomJoin = z.infer<typeof RoomJoin>;

export const RoomJoined = z
  .object({ roomId: z.uuid(), role: RoomRole })
  .strict()
  .meta({ id: 'RoomJoined' });
export type RoomJoined = z.infer<typeof RoomJoined>;
