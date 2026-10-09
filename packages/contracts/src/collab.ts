import { z } from 'zod';

/** The collab server asks the API who a ticket belongs to (CP-01, SD-§11, FR-PAD-03). Internal: service token. */

/** The longest a room session lasts, from the room's creation (FR-PAD-13). */
export const ROOM_SESSION_MAX_MINUTES = 90;
/** Presence colours are assigned by the server as an index into the UI's palette of this many (UI_UX §5.1). */
export const PRESENCE_COLOURS = 8;

export const RoomRole = z.enum(['interviewer', 'candidate', 'observer']);
export type RoomRole = z.infer<typeof RoomRole>;

/** POST /api/internal/rooms/{roomId}/authorize */
export const CollabAuthorizeRequest = z
  .object({ ticket: z.string().min(1).max(200) })
  .strict()
  .meta({ id: 'CollabAuthorizeRequest' });
export type CollabAuthorizeRequest = z.infer<typeof CollabAuthorizeRequest>;

/** Who the ticket's holder is, as the server verified it. The client never supplies any of this. */
export const CollabIdentity = z
  .object({
    userId: z.uuid(),
    name: z.string().min(1).max(60),
    role: RoomRole,
    /** Observers watch; their edits are ignored. */
    readOnly: z.boolean(),
    /** Epoch milliseconds: the session ends then (room creation + 90 minutes). */
    expiresAt: z.number().int(),
    colorIndex: z
      .number()
      .int()
      .min(0)
      .max(PRESENCE_COLOURS - 1),
  })
  .strict()
  .meta({ id: 'CollabIdentity' });
export type CollabIdentity = z.infer<typeof CollabIdentity>;
