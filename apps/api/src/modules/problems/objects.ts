import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../../config/config';

/** A stored object that cannot be used (wrong place, too big): never a server fault. */
export class ObjectError extends Error {}

/**
 * Reads a small object named by an `s3://<bucket>/<prefix>...` URI. Same rules the judge applies:
 * the configured bucket only, a fixed key prefix, no path tricks, a size cap.
 */
export async function readObject(
  s3: S3Client,
  config: Config,
  uri: string,
  prefix: string,
  maxBytes: number,
): Promise<Buffer> {
  const m = /^s3:\/\/([^/?#]+)\/([^?#]+)$/.exec(uri);
  const key = m?.[2];
  if (!m || m[1] !== config.S3_BUCKET_TESTS || !key?.startsWith(prefix) || key.includes('..')) {
    throw new ObjectError(`${uri} is not a ${prefix} object of this deployment`);
  }
  const out = await s3.send(new GetObjectCommand({ Bucket: m[1], Key: key }));
  if (out.ContentLength !== undefined && out.ContentLength > maxBytes) {
    throw new ObjectError(`${key} is ${out.ContentLength} bytes (limit ${maxBytes})`);
  }
  const body = Buffer.from(await out.Body!.transformToByteArray());
  if (body.length > maxBytes) throw new ObjectError(`${key} is larger than ${maxBytes} bytes`);
  return body;
}
