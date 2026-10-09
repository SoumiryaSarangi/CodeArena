import { Redis } from 'ioredis';
import { PgDocStore } from './pg-store';
import { createServer, type CollabOptions } from './server';

const need = (name: string) => {
  const v = process.env[name];
  if (!v || v === 'not-configured') {
    console.error(`collab: ${name} is not set; refusing to start`);
    process.exit(1);
  }
  return v;
};

// A pad server that silently forgets documents is worse than none, so storage is required. The one exception is for
// development and the browser tests: COLLAB_MEMORY=1 keeps documents in memory (never allowed in production).
const memoryOnly = process.env.COLLAB_MEMORY === '1';
if (memoryOnly && process.env.NODE_ENV === 'production') {
  console.error('collab: COLLAB_MEMORY=1 is not allowed in production; refusing to start');
  process.exit(1);
}
if (memoryOnly)
  console.warn(
    'collab: COLLAB_MEMORY=1, documents are NOT stored and are not shared between instances',
  );

const token = need('COLLAB_SERVICE_TOKEN');
const store = memoryOnly
  ? undefined
  : PgDocStore.connect(need('DATABASE_URL'), (msg, extra) =>
      console.warn(`collab: ${msg}`, extra ?? ''),
    );
const redis = memoryOnly ? undefined : new Redis(need('REDIS_URL'), { maxRetriesPerRequest: null });
redis?.on('error', (err) => console.error('collab: redis', err.message));
const storage: Pick<CollabOptions, 'store' | 'redis'> = {
  ...(store ? { store } : {}),
  ...(redis ? { redis: { client: redis, instance: process.env.COLLAB_INSTANCE } } : {}),
};
const collab = createServer({
  ...storage,
  port: Number(process.env.PORT ?? 1234),
  api: { url: need('API_URL'), token },
  token,
});
await collab.listen();
// SIGTERM: flush the open documents to Postgres before leaving (FR-PAD-06).
const stop = () =>
  void collab
    .destroy()
    .then(() => store?.close())
    .finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
