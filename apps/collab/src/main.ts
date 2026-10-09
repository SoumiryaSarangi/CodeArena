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
const collab = createServer({
  port: Number(process.env.PORT ?? 1234),
  api: { url: need('API_URL'), token },
  token,
});
await collab.listen();
const stop = () => void collab.destroy().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
