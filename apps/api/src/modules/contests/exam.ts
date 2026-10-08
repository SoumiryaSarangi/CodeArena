import {
  ContestRules,
  EXAM_MAX_STRIKES,
  type ContestExamState,
  type ContestState,
  type ExamFinishReason,
} from '@codearena/contracts';
import { and, eq } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import type { Db } from '../../db/db.module';
import { participants } from '../../db/schema';

/** Exam mode (C-10) is a per-contest rule; contests created before it existed read as off. */
export const examOn = (rules: unknown): boolean => ContestRules.parse(rules).examMode;

/** The viewer's own exam state, or null (not an exam contest, not signed in, not registered). */
export async function examStateOf(
  db: Db,
  c: { id: string; rules: unknown },
  userId?: string,
): Promise<ContestExamState | null> {
  if (!userId || !examOn(c.rules)) return null;
  const [p] = await db
    .select({
      finishedAt: participants.finishedAt,
      finishReason: participants.finishReason,
      leaveCount: participants.leaveCount,
    })
    .from(participants)
    .where(and(eq(participants.contestId, c.id), eq(participants.userId, userId)))
    .limit(1);
  if (!p) return null;
  return {
    finishedAt: p.finishedAt ? p.finishedAt.toISOString() : null,
    finishReason: (p.finishReason as ExamFinishReason | null) ?? null,
    strikes: p.leaveCount,
    maxStrikes: EXAM_MAX_STRIKES,
  };
}

/**
 * FR-EXAM-03: a participant who finished an exam-mode contest cannot read its problems, submit or
 * run while it is still running (one entry only). After the end it is a normal contest again.
 */
export function refuseFinished(
  state: ContestState,
  rules: unknown,
  finishedAt: Date | null | undefined,
): void {
  if (state === 'running' && finishedAt && examOn(rules)) {
    throw new ProblemError('contest-finished', 'You have finished this test');
  }
}
