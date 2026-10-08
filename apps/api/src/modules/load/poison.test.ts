import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { submissions } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { seedLoad } from './load-test';
import { createPoison, removePoisonObjects, repack, repairPoison } from './poison';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const s3Up = await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_TESTS })).then(
  () => true,
  () => false,
);
const redisUp = await new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
})
  .connect()
  .then(() => true)
  .catch(() => false);
const ready = s3Up && redisUp && (await postgresReachable());
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name) as [string];
const prefix = `p${randomBytes(4).toString('hex')}:`;

describe.skipIf(!ready)(
  'O-06: the poison job of the failure drills (needs Postgres, Redis, S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let redis: Redis;
    let slug = '';

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      redis = new Redis(config.REDIS_URL);
      const r = parsePackage(P1, readPackageDirectory(`${root}${P1}`));
      if (!r.ok) throw new Error('package rejected');
      await new ProblemImporter(db, s3, config).import(r.pkg, { visibility: 'public' });
      slug = (
        await seedLoad(db, pino({ level: 'silent' }), { count: 2, problems: [P1], tag: 'poi' })
      ).contest.slug;
    });
    afterAll(async () => {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await removePoisonObjects(s3, config.S3_BUCKET_TESTS);
      await drop?.();
    });

    const exists = (uri: string) =>
      s3
        .send(
          new HeadObjectCommand({
            Bucket: config.S3_BUCKET_TESTS,
            Key: uri.replace(/^s3:\/\/[^/]+\//, ''),
          }),
        )
        .then(
          () => true,
          () => false,
        );

    it('O-06: the job names a testset that is not there, with the real hash, on the contest lane', async () => {
      const p = await createPoison(db, redis, s3, slug, 'int main(){return 0;}', { prefix });
      expect(p.label).toBe('A');
      expect(p.poisonUri).toMatch(/\/testsets\/chaos-poison\/lt-poi-A\.tar$/);
      expect(p.poisonUri).not.toBe(p.realUri);
      expect(await exists(p.poisonUri)).toBe(false);

      const [row] = await db.select().from(submissions).where(eq(submissions.id, p.submissionId));
      expect(row).toMatchObject({ status: 'queued', lane: 'contest', verdict: null });
      const [entry] = await redis.xrange(`${prefix}jobs:contest`, '-', '+');
      const raw = entry![1][entry![1].indexOf('job') + 1]!;
      expect(JSON.parse(raw)).toMatchObject({
        submissionId: p.submissionId,
        runVersion: 1,
        lane: 'contest',
        problem: { testsetUri: p.poisonUri, testsetHash: p.poisonHash },
      });
    });

    it('O-06: repairing the outage makes the testset appear where the job looks for it, and cleanup removes it', async () => {
      const [p] = await db.select({ n: submissions.id }).from(submissions).limit(1);
      expect(p).toBeDefined();
      const fixed = await repairPoison(db, s3, slug);
      expect(await exists(fixed.to)).toBe(true);
      // What a judge will download hashes to what the dead job expects (the judge checks it).
      const stored = await s3.send(
        new GetObjectCommand({
          Bucket: config.S3_BUCKET_TESTS,
          Key: fixed.to.replace(/^s3:\/\/[^/]+\//, ''),
        }),
      );
      const sha = createHash('sha256')
        .update(Buffer.from(await stored.Body!.transformToByteArray()))
        .digest('hex');
      const [entry] = await redis.xrange(`${prefix}jobs:contest`, '-', '+');
      const job = JSON.parse(entry![1][entry![1].indexOf('job') + 1]!) as {
        problem: { testsetHash: string };
      };
      expect(sha).toBe(job.problem.testsetHash);
      expect(await removePoisonObjects(s3, config.S3_BUCKET_TESTS)).toBe(1);
      expect(await exists(fixed.to)).toBe(false);
    });

    it('O-06: a contest without participants or an unknown problem is refused', async () => {
      await expect(createPoison(db, redis, s3, slug, 'x', { label: 'Z', prefix })).rejects.toThrow(
        'no testset',
      );
      await expect(createPoison(db, redis, s3, 'lt-nope', 'x', { prefix })).rejects.toThrow(
        'no contest',
      );
    });
  },
);

describe('O-06: re-packing a testset archive', () => {
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), 'repack-'));
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', '01.in'), '1 2\n');
    writeFileSync(join(dir, 'in', '01.ans'), '3\n');
    writeFileSync(join(dir, 'in', 'big.in'), 'x'.repeat(1500)); // more than one data block
    const tar = join(dir, 'a.tar');
    execFileSync('tar', ['--format=ustar', '-cf', tar, '-C', dir, 'in']);
    return { dir, tar };
  };

  it('keeps the files, changes only the times, and the result is a valid archive with another hash', () => {
    const { dir, tar } = make();
    try {
      const original = readFileSync(tar);
      const again = repack(original, 1_234_567_890);
      expect(again.length).toBe(original.length);
      expect(createHash('sha256').update(again).digest('hex')).not.toBe(
        createHash('sha256').update(original).digest('hex'),
      );
      const out = join(dir, 'b.tar');
      writeFileSync(out, again);
      // `tar` itself accepts it (a wrong checksum would fail here) and lists the same files.
      const names = (f: string) =>
        execFileSync('tar', ['-tf', f], { encoding: 'utf8' }).split('\n').sort();
      expect(names(out)).toEqual(names(tar));
      const unpacked = join(dir, 'x');
      mkdirSync(unpacked);
      execFileSync('tar', ['-xf', out, '-C', unpacked]);
      expect(readFileSync(join(unpacked, 'in', '01.ans'), 'utf8')).toBe('3\n');
      expect(readFileSync(join(unpacked, 'in', 'big.in'), 'utf8')).toHaveLength(1500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic for one time and different for another', () => {
    const { dir, tar } = make();
    try {
      const original = readFileSync(tar);
      expect(repack(original, 1_300_000_000).equals(repack(original, 1_300_000_000))).toBe(true);
      expect(repack(original, 1_300_000_000).equals(repack(original, 1_300_000_001))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
