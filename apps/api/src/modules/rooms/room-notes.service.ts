import { ROOM_NOTES_MAX_BYTES, type RoomNotes, type RoomNotesPut } from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { interviewerNotes, roomMembers } from '../../db/schema';

const tracer = trace.getTracer('api');
const notesTotal = metrics.getMeter('api').createCounter('ca_room_notes_total', {
  description: 'Interviewer notes: reads, saves, refusals and conflicts (never the text)',
});

interface Actor {
  id: string;
}

/**
 * CP-05 (FR-PAD-09, US-10.4): the interviewer's private notes. They live in `interviewer_notes`, never in the Y.Doc and
 * never in an event, an audit row or a log line; the only way out is this service, and it answers the interviewer of that
 * room and nobody else (a stranger is told "no such room", a candidate or observer "interviewer only"). They stay readable
 * and editable after the room has ended: the interviewer finishes them afterwards.
 */
@Injectable()
export class RoomNotesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async interviewerOf(user: Actor, roomId: string): Promise<void> {
    const [m] = await this.db
      .select({ role: roomMembers.role })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!m) {
      notesTotal.add(1, { op: 'denied' });
      throw new ProblemError('not-found', 'No such room');
    }
    if (m.role !== 'interviewer') {
      notesTotal.add(1, { op: 'denied' });
      throw new ProblemError('forbidden', 'Only the interviewer can use the notes');
    }
  }

  async get(user: Actor, roomId: string): Promise<RoomNotes> {
    return tracer.startActiveSpan('rooms.notes.get', async (span) => {
      try {
        await this.interviewerOf(user, roomId);
        const [row] = await this.db
          .select({ body: interviewerNotes.bodyMd, updatedAt: interviewerNotes.updatedAt })
          .from(interviewerNotes)
          .where(eq(interviewerNotes.roomId, roomId))
          .limit(1);
        notesTotal.add(1, { op: 'read' });
        return { body: row?.body ?? '', updatedAt: row ? row.updatedAt.toISOString() : null };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Saves the text if the client's edit was based on what is stored (`baseUpdatedAt`; null for the first save). A
   * different value means another window saved in between: 409 `conflict`, nothing is overwritten.
   */
  async save(user: Actor, roomId: string, put: RoomNotesPut): Promise<RoomNotes> {
    return tracer.startActiveSpan('rooms.notes.save', async (span) => {
      try {
        await this.interviewerOf(user, roomId);
        if (Buffer.byteLength(put.body) > ROOM_NOTES_MAX_BYTES) {
          throw new ProblemError('payload-too-large', 'Notes are limited to 64 KB');
        }
        const base = put.baseUpdatedAt === null ? null : new Date(put.baseUpdatedAt);
        if (base !== null && Number.isNaN(base.getTime())) {
          throw new ProblemError('validation', 'baseUpdatedAt is not a time', {
            errors: [{ path: 'baseUpdatedAt', message: 'not a time' }],
          });
        }
        const saved = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .select({ updatedAt: interviewerNotes.updatedAt })
            .from(interviewerNotes)
            .where(eq(interviewerNotes.roomId, roomId))
            .for('update');
          const fresh = row
            ? base !== null && base.getTime() === row.updatedAt.getTime()
            : base === null;
          if (!fresh) return null;
          // strictly later than what was there, so two saves in one millisecond still differ
          const at = new Date(Math.max(Date.now(), (row?.updatedAt.getTime() ?? 0) + 1));
          await tx
            .insert(interviewerNotes)
            .values({ roomId, authorId: user.id, bodyMd: put.body, updatedAt: at })
            .onConflictDoUpdate({
              target: interviewerNotes.roomId,
              set: { authorId: user.id, bodyMd: put.body, updatedAt: at },
            });
          return at;
        });
        if (saved === null) {
          notesTotal.add(1, { op: 'conflict' });
          throw new ProblemError(
            'conflict',
            'The notes were saved from another window; read them again',
          );
        }
        notesTotal.add(1, { op: 'save' });
        return { body: put.body, updatedAt: saved.toISOString() };
      } finally {
        span.end();
      }
    });
  }
}
