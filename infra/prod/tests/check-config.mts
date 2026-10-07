// Loads a prod.env file through the API's own production config validation (`loadConfig`), the same
// check the container runs at boot. Used by env.test.sh. Prints OK or the reason it was rejected.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../../apps/api/src/config/config.ts';

const env: Record<string, string> = {};
for (const line of readFileSync(process.argv[2]!, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  let v = line.slice(i + 1);
  if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1); // what Compose does for single quotes
  env[line.slice(0, i)] = v;
}
try {
  const c = loadConfig(env);
  console.log(
    `OK ${c.NODE_ENV} trust=${c.TRUST_PROXY} api=${c.PUBLIC_API_URL} redis=${new URL(c.REDIS_URL).username}`,
  );
} catch (e) {
  console.log(`REJECTED ${(e as Error).message}`);
  process.exit(1);
}
