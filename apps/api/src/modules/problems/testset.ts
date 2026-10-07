import { createHash } from 'node:crypto';

const BLOCK = 512;

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'ascii');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii'); // mtime 0: the archive must be reproducible
  h.write('        ', 148, 'ascii'); // checksum placeholder: spaces
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write('0000000\0', 329, 'ascii'); // devmajor, devminor: Go writes them
  h.write('0000000\0', 337, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/**
 * The testset archive the judge fetches (FR-PROB-03): flat NN.in / NN.ans, in order, fixed
 * metadata, so the SHA-256 is reproducible. It is byte-identical to what the Go tool
 * `scripts/validate-problem -tar` writes, so a hash printed there matches the one stored here.
 */
export function buildTestset(tests: { no: number; in: Buffer; ans: Buffer }[]): {
  data: Buffer;
  hash: string;
} {
  const parts: Buffer[] = [];
  for (const t of tests) {
    for (const [ext, body] of [
      ['in', t.in],
      ['ans', t.ans],
    ] as const) {
      parts.push(header(`${String(t.no).padStart(2, '0')}.${ext}`, body.length), body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  const data = Buffer.concat(parts);
  return { data, hash: createHash('sha256').update(data).digest('hex') };
}

/**
 * Reads a testset archive written by `buildTestset` (flat NN.in / NN.ans, ustar) into
 * name -> contents. Used by the setter screens to list and download tests. Anything that is not
 * such an archive is an error rather than a guess.
 */
export function readTestset(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  while (off + BLOCK <= data.length) {
    const h = data.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('ascii', 0, 100).replace(/\0.*$/s, '');
    const size = parseInt(h.toString('ascii', 124, 135).replace(/\0.*$/s, '').trim(), 8);
    if (!/^[0-9]{2}\.(in|ans)$/.test(name) || !Number.isInteger(size) || size < 0) {
      throw new Error(`not a testset archive (entry ${JSON.stringify(name)})`);
    }
    off += BLOCK;
    if (off + size > data.length) throw new Error('testset archive is truncated');
    files.set(name, data.subarray(off, off + size));
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
