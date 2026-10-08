/**
 * O-06 poison drill: a submission whose job cannot run until an object appears in the store, the way
 * a storage outage looks to a judge. The job names a testset the judge has never seen: the real
 * cases re-packed with other file times (so its hash is new and no judge has it cached) at a key that
 * does not exist yet. The worker fails to fetch it, publishes SE and dead-letters the job.
 * `repairPoison` then uploads that archive to the key, which is what "the outage is over" means;
 * re-queueing the dead job from the ops console must then end in the real verdict. The archive is
 * derived from the real one and the contest slug alone, so repairing needs nothing stored.
 */
import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  participants,
  problemVersions,
  submissions,
} from '../../db/schema';
import { buildJob } from '../submissions/job-builder';
import { QueueService } from '../submissions/queue.service';

export interface Poison {
  submissionId: string;
  label: string;
  /** Where the job says the testset is (it is not there yet). */
  poisonUri: string;
  /** Where the real testset is. */
  realUri: string;
  /** The hash the job expects: of the re-packed archive, not of the real one. */
  poisonHash: string;
}

/**
 * The same tar with every entry's modification time set to `mtime` (checksums recomputed): the same
 * cases, a different SHA-256. A tar is 512-byte header blocks followed by the data padded to 512.
 */
export function repack(tar: Buffer, mtime: number): Buffer {
  const out = Buffer.from(tar);
  let at = 0;
  while (at + 512 <= out.length) {
    const header = out.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break; // the end-of-archive blocks
    header.write(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 'latin1');
    header.fill(0x20, 148, 156); // the checksum is computed with its own field as spaces
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const sizeField = header.subarray(124, 136);
    const size =
      sizeField[0]! & 0x80
        ? Number(sizeField.readBigUInt64BE(4)) // base-256 sizes (very large entries)
        : parseInt(sizeField.toString('latin1').replace(/\0/g, '').trim() || '0', 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A modification time that is the same for one contest and different between contests. */
const mtimeFor = (slug: string) =>
  1_000_000_000 + (createHash('sha256').update(slug).digest().readUInt32BE(0) % 500_000_000);

async function download(s3: S3Client, uri: string): Promise<Buffer> {
  const { bucket, key } = parseUri(uri);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

const parseUri = (uri: string) => {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not an s3 uri: ${uri}`);
  return { bucket: m[1]!, key: m[2]! };
};

async function target(db: Db, slug: string, label?: string) {
  const [c] = await db.select({ id: contests.id }).from(contests).where(eq(contests.slug, slug));
  if (!c) throw new Error(`no contest "${slug}"`);
  const rows = await db
    .select({
      label: contestProblems.label,
      versionId: contestProblems.versionId,
      testsetHash: problemVersions.testsetHash,
      testsetUri: problemVersions.testsetUri,
      limits: problemVersions.limits,
      checker: problemVersions.checker,
    })
    .from(contestProblems)
    .innerJoin(problemVersions, eq(problemVersions.id, contestProblems.versionId))
    .where(eq(contestProblems.contestId, c.id))
    .orderBy(asc(contestProblems.position));
  const row = label ? rows.find((r) => r.label === label) : rows.at(-1);
  if (!row?.testsetHash || !row.testsetUri) throw new Error('that problem has no testset');
  return { contestId: c.id, row };
}

/** The made-up location for a contest's poison job (the same for create and repair). */
const poisonUri = (realUri: string, slug: string, label: string) => {
  const { bucket } = parseUri(realUri);
  return `s3://${bucket}/testsets/chaos-poison/${slug}-${label}.tar`;
};

export async function createPoison(
  db: Db,
  redis: Redis,
  s3: S3Client,
  slug: string,
  source: string,
  opts: { label?: string; prefix?: string } = {},
): Promise<Poison> {
  const { contestId, row } = await target(db, slug, opts.label);
  const [p] = await db
    .select({ userId: participants.userId })
    .from(participants)
    .where(eq(participants.contestId, contestId))
    .orderBy(asc(participants.registeredAt))
    .limit(1);
  if (!p) throw new Error('the contest has no participants');
  const fake = poisonUri(row.testsetUri!, slug, row.label);
  const poisonHash = createHash('sha256')
    .update(repack(await download(s3, row.testsetUri!), mtimeFor(slug)))
    .digest('hex');
  const [s] = await db
    .insert(submissions)
    .values({
      userId: p.userId,
      problemVersionId: row.versionId,
      contestId,
      language: 'cpp17',
      source,
      sourceBytes: Buffer.byteLength(source),
      lane: 'contest',
      contestMinute: 1,
      status: 'queued',
    })
    .returning({ id: submissions.id });
  const queue = new QueueService(redis, opts.prefix ?? '');
  try {
    await queue.enqueue(
      buildJob(
        { id: s!.id, language: 'cpp17', source, lane: 'contest', runVersion: 1 },
        {
          id: row.versionId,
          testsetHash: poisonHash,
          testsetUri: fake,
          limits: row.limits,
          checker: row.checker,
        },
        'submit',
      ),
    );
  } finally {
    queue.onModuleDestroy();
  }
  return {
    submissionId: s!.id,
    label: row.label,
    poisonUri: fake,
    realUri: row.testsetUri!,
    poisonHash,
  };
}

/** The outage is over: the archive the dead job names is in the store now. */
export async function repairPoison(
  db: Db,
  s3: S3Client,
  slug: string,
  opts: { label?: string } = {},
): Promise<{ from: string; to: string }> {
  const { row } = await target(db, slug, opts.label);
  const to = parseUri(poisonUri(row.testsetUri!, slug, row.label));
  const body = repack(await download(s3, row.testsetUri!), mtimeFor(slug));
  await s3.send(new PutObjectCommand({ Bucket: to.bucket, Key: to.key, Body: body }));
  return { from: row.testsetUri!, to: `s3://${to.bucket}/${to.key}` };
}

/** Removes what `repairPoison` uploaded (called by `cleanup`; only keys of `lt-*` contests). */
export async function removePoisonObjects(s3: S3Client, bucket: string): Promise<number> {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: 'testsets/chaos-poison/lt-' }),
  );
  const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
  if (keys.length > 0) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
  }
  return keys.length;
}
