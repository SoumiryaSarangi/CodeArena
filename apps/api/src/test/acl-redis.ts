import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

const infra = fileURLToPath(new URL('../../../../infra/redis/', import.meta.url));

export const ACL_PASSWORDS = { admin: 'admin-test', api: 'api-test', judge: 'judge-test' } as const;

export const dockerAvailable = () => {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
};

export interface AclRedis {
  addr: { host: string; port: number };
  as: (user: keyof typeof ACL_PASSWORDS) => Redis;
  stop: () => void;
}

/**
 * A throwaway Redis started from the repository's real ACL file and entrypoint
 * script (infra/redis), so tests exercise the exact users compose and production
 * run. Each `as(user)` returns a client authenticated as that user.
 */
export async function startAclRedis(): Promise<AclRedis> {
  const id = execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-p',
      '127.0.0.1::6379',
      '-e',
      `REDIS_ADMIN_PASSWORD=${ACL_PASSWORDS.admin}`,
      '-e',
      `REDIS_JUDGE_PASSWORD=${ACL_PASSWORDS.judge}`,
      '-e',
      `REDIS_API_PASSWORD=${ACL_PASSWORDS.api}`,
      '-v',
      `${infra}users.acl.tmpl:/etc/redis/users.acl.tmpl:ro`,
      '-v',
      `${infra}entrypoint.sh:/entrypoint.sh:ro`,
      '--entrypoint',
      'sh',
      'redis:7',
      '/entrypoint.sh',
    ],
    { encoding: 'utf8' },
  ).trim();
  const mapped = execFileSync('docker', ['port', id, '6379/tcp'], { encoding: 'utf8' })
    .split('\n')[0]!
    .trim();
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const addr = { host: '127.0.0.1', port };
  const clients: Redis[] = [];
  const as = (user: keyof typeof ACL_PASSWORDS) => {
    const c = new Redis({
      ...addr,
      username: user,
      password: ACL_PASSWORDS[user],
      maxRetriesPerRequest: 2,
    });
    c.on('error', () => {});
    clients.push(c);
    return c;
  };
  const stop = () => {
    for (const c of clients) c.disconnect();
    try {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  };
  const admin = as('admin');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await admin.ping();
      break;
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error('the ACL Redis did not come up');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { addr, as, stop };
}
