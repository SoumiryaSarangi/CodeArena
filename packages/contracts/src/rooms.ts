import { z } from 'zod';
import { RoomRole } from './collab';
import { Language, Verdict } from './enums';

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

// ---- running code from the pad (CP-04, FR-PAD-08) -----------------------------------------------------------------

export const ROOM_RUN_INTERVAL_MS = 2000;
/** Output is cut here in what everyone is sent (the full output stays in the database). */
export const ROOM_RUN_OUTPUT_CAP = 16 * 1024;
export const RoomRunMode = z.enum(['run', 'submit']);
export type RoomRunMode = z.infer<typeof RoomRunMode>;

/**
 * POST /api/rooms/{id}/runs. `runId` is chosen by the client (a UUID): sending the same one again does not run twice.
 * `run` takes optional standard input; `submit` judges against the attached problem's hidden tests and takes none.
 */
export const RoomRunCreate = z
  .object({
    runId: z.uuid(),
    mode: RoomRunMode,
    language: Language,
    source: z
      .string()
      .min(1)
      .max(64 * 1024),
    input: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .strict()
  .refine((r) => r.mode === 'run' || r.input === undefined, {
    message: 'A submission takes no input',
    path: ['input'],
  })
  .meta({ id: 'RoomRunCreate' });
export type RoomRunCreate = z.infer<typeof RoomRunCreate>;

export const RoomRunStatus = z.enum(['queued', 'running', 'done', 'failed']);

/** What every member sees of a run: the SSE `room.run` event on topic `room:{id}`, and the history. Hidden test data never appears. */
export const RoomRunView = z
  .object({
    runId: z.uuid(),
    mode: RoomRunMode,
    by: z.string(),
    language: z.string(),
    status: RoomRunStatus,
    verdict: Verdict.nullable(),
    timeMs: z.number().int().nullable(),
    memKb: z.number().int().nullable(),
    output: z.string().nullable(),
    stderr: z.string().nullable(),
    compileLog: z.string().nullable(),
    /** The output was longer than {@link ROOM_RUN_OUTPUT_CAP} and has been cut. */
    truncated: z.boolean(),
    /** Per-test verdicts of a submission (numbers and times only). */
    tests: z.array(
      z.object({ no: z.number().int(), verdict: Verdict, timeMs: z.number().int() }).strict(),
    ),
    createdAt: z.string(),
  })
  .strict()
  .meta({ id: 'RoomRunView' });
export type RoomRunView = z.infer<typeof RoomRunView>;

export const RoomRunList = z
  .object({ items: z.array(RoomRunView) })
  .strict()
  .meta({ id: 'RoomRunList' });
export type RoomRunList = z.infer<typeof RoomRunList>;

export const RoomRunAccepted = z
  .object({ runId: z.uuid() })
  .strict()
  .meta({ id: 'RoomRunAccepted' });
export type RoomRunAccepted = z.infer<typeof RoomRunAccepted>;

// ---- private interviewer notes (CP-05, FR-PAD-09) ------------------------------------------------------------------

export const ROOM_NOTES_MAX_BYTES = 64 * 1024;

/** GET /api/rooms/{id}/notes and the answer to a save. Only the interviewer is ever sent this. */
export const RoomNotes = z
  .object({
    body: z.string(),
    /** When it was last saved; null while nothing has been saved. The next save sends it back as `baseUpdatedAt`. */
    updatedAt: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'RoomNotes' });
export type RoomNotes = z.infer<typeof RoomNotes>;

/** PUT /api/rooms/{id}/notes. `baseUpdatedAt` is what the client last saw: a different value is a 409 `conflict`. */
export const RoomNotesPut = z
  .object({
    body: z.string().max(ROOM_NOTES_MAX_BYTES),
    baseUpdatedAt: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'RoomNotesPut' });
export type RoomNotesPut = z.infer<typeof RoomNotesPut>;
