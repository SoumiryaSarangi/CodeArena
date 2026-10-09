import { pgEnum } from 'drizzle-orm/pg-core';
import { Lane, Verdict } from '@codearena/contracts';

// Verdict and lane values come from the contracts so the DB and the wire cannot drift.
export const verdict = pgEnum('verdict', Verdict.enum);
export const lane = pgEnum('lane', Lane.enum);

export const userRole = pgEnum('user_role', ['user', 'setter', 'admin']);
export const oauthProvider = pgEnum('oauth_provider', ['google', 'github']);
export const problemVisibility = pgEnum('problem_visibility', ['public', 'contest', 'private']);
export const validationStatus = pgEnum('validation_status', [
  'pending',
  'running',
  'passed',
  'failed',
]);
export const runStatus = pgEnum('run_status', ['queued', 'running', 'done', 'failed']);
export const submissionStatus = pgEnum('submission_status', [
  'queued',
  'judging',
  'done',
  'failed',
]);
export const runReason = pgEnum('run_reason', ['initial', 'retry', 'rejudge']);
export const contestStatus = pgEnum('contest_status', [
  'draft',
  'scheduled',
  'running',
  'ended',
  'finalized',
]);
export const reviewStatus = pgEnum('review_status', ['pending', 'ready', 'failed']);
export const decisionKind = pgEnum('decision_kind', ['confirmed', 'dismissed', 'needs_more']);
export const signalKind = pgEnum('signal_kind', [
  'paste',
  'blur',
  'focus',
  'tab_hidden',
  'problem_open',
]);
export const roomStatus = pgEnum('room_status', ['open', 'closed', 'archived']);
export const roomRole = pgEnum('room_role', ['interviewer', 'candidate', 'observer']);
export const roomEventKind = pgEnum('room_event_kind', [
  'join',
  'leave',
  'run',
  'snapshot',
  'restore',
  'timer',
  'language',
]);
