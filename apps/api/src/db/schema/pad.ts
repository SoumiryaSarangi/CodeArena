import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, ts } from './columns';
import { roomEventKind, roomRole, roomStatus } from './enums';
import { users } from './identity';
import { problems } from './problems';

const seq = () => bigint('seq', { mode: 'number' }).notNull();

export const rooms = pgTable('rooms', {
  id: id(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  problemId: uuid('problem_id').references(() => problems.id),
  language: text('language').notNull(),
  durationMin: integer('duration_min'),
  status: roomStatus('status').notNull().default('open'),
  createdAt: createdAt(),
  closedAt: ts('closed_at'),
  docBytes: integer('doc_bytes').notNull().default(0),
  /** Code suggestions in the editor (ED-01); the interviewer may switch them while the room is open. */
  suggestions: boolean('suggestions').notNull().default(true),
});

const roomId = () =>
  uuid('room_id')
    .notNull()
    .references(() => rooms.id);

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: roomId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: roomRole('role').notNull(),
    joinedAt: ts('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
);

export const roomInvites = pgTable('room_invites', {
  id: id(),
  roomId: roomId(),
  role: roomRole('role').notNull(),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

export const roomDocs = pgTable('room_docs', {
  roomId: uuid('room_id')
    .primaryKey()
    .references(() => rooms.id),
  state: bytea('state').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const roomUpdates = pgTable(
  'room_updates',
  {
    roomId: roomId(),
    seq: seq(),
    ts: ts('ts').notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    update: bytea('update').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.seq] })],
);

export const roomCheckpoints = pgTable(
  'room_checkpoints',
  {
    roomId: roomId(),
    seq: seq(),
    state: bytea('state').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.seq] })],
);

export const roomEvents = pgTable(
  'room_events',
  {
    roomId: roomId(),
    seq: seq(),
    ts: ts('ts').notNull().defaultNow(),
    userId: uuid('user_id').references(() => users.id),
    kind: roomEventKind('kind').notNull(),
    payload: jsonb('payload'),
  },
  (t) => [index().on(t.roomId, t.seq)],
);

export const roomSnapshots = pgTable('room_snapshots', {
  id: id(),
  roomId: roomId(),
  seq: seq(),
  label: text('label'),
  snapshot: bytea('snapshot').notNull(),
  createdAt: createdAt(),
});

/** Interviewer notes never go in the Y.Doc (CLAUDE.md); they live here only. */
export const interviewerNotes = pgTable('interviewer_notes', {
  roomId: uuid('room_id')
    .primaryKey()
    .references(() => rooms.id),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id),
  bodyMd: text('body_md').notNull().default(''),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** CP-11: the AI summary of a session. One row per room, replaced when it is written again; interviewer-only. */
export const roomSummaries = pgTable('room_summaries', {
  roomId: uuid('room_id')
    .primaryKey()
    .references(() => rooms.id),
  contentMd: text('content_md').notNull(),
  model: text('model'),
  createdAt: createdAt(),
  promptVersion: text('prompt_version').notNull().default(''),
  tokens: integer('tokens').notNull().default(0),
  usedNotes: boolean('used_notes').notNull().default(true),
  /** What the summary was made from (a hash): the same facts again do not call a model again. */
  inputHash: text('input_hash').notNull().default(''),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
