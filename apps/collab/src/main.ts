import { Redis } from 'ioredis';
import { PgDocStore } from './pg-store';
import { createServer } from './server';

const need = (name: string) => {
  const v = process.env[name];
  if (!v || v === 'not-configured') {
    console.error(`collab: ${name} is not set; refusing to start`);
    process.exit(1);
  }
  return v;
};

const token = need('COLLAB_SERVICE_TOKEN');
const store = PgDocStore.connect(need('DATABASE_URL'), (msg, extra) =>
  console.warn(`collab: ${msg}`, extra ?? ''),
);
const redis = new Redis(need('REDIS_URL'), { maxRetriesPerRequest: null });
redis.on('error', (err) => console.error('collab: redis', err.message));
const collab = createServer({
  store,
  redis: { client: redis, instance: process.env.COLLAB_INSTANCE },
  port: Number(process.env.PORT ?? 1234),
  api: { url: need('API_URL'), token },
  token,
});
await collab.listen();
// SIGTERM: flush the open documents to Postgres before leaving (FR-PAD-06).
const stop = () =>
  void collab
    .destroy()
    .then(() => store.close())
    .finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
