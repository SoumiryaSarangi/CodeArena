import { bigserial, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns';
import { users } from './identity';

export const productEvents = pgTable(
  'product_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    name: text('name').notNull(),
    props: jsonb('props'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index().on(t.name, t.at)],
);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  meta: jsonb('meta'),
  at: ts('at').notNull().defaultNow(),
});
