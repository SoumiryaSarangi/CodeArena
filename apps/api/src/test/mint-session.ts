/**
 * Creates a user with a handle and a valid refresh token, and prints them as JSON:
 * `tsx src/test/mint-session.ts [handle] [user|setter|admin]`. For the live browser spec (apps/web/e2e/live), which puts
 * the token in a cookie instead of going through Google or GitHub. Reads DATABASE_URL from the
 * environment (dev default otherwise) and touches nothing else.
 */
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { connect, databaseUrl } from '../db/client';
import { users } from '../db/schema';
import { TokensService } from '../modules/auth/tokens.service';

const handle = (
  process.argv[2] || `live_${randomUUID().slice(0, 8).replace(/-/g, '')}`
).toLowerCase();
const role = (process.argv[3] ?? 'user') as 'user' | 'setter' | 'admin';
if (!['user', 'setter', 'admin'].includes(role))
  throw new Error(`role must be user, setter or admin, got ${role}`);
const { db, pool } = connect(databaseUrl());
const id = randomUUID();
await db.insert(users).values({
  id,
  email: `${id}@live.example.test`,
  handle,
  role,
  name: 'Live Test',
  defaultLanguage: 'cpp17',
});
const tokens = new TokensService(db as never, pino({ level: 'silent' }));
const refresh = await tokens.issue(id, 'live-e2e');
await pool.end();
console.log(JSON.stringify({ userId: id, handle, refreshToken: refresh.token }));
