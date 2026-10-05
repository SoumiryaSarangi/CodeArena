import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid';

export const id = () => uuid('id').primaryKey().$defaultFn(uuidv7);
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => ts('created_at').notNull().defaultNow();

export const citext = customType<{ data: string }>({ dataType: () => 'citext' });
export const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
