import { JudgeJob } from '@codearena/contracts';
import { describe, expect, it } from 'vitest';
import { buildJob } from './job-builder';

const version = {
  id: 'v1',
  testsetHash: 'a'.repeat(64),
  testsetUri: 's3://codearena/testsets/' + 'a'.repeat(64) + '.tar',
  limits: { timeMs: 1000, memMb: 256, outputKb: 1024 },
  checker: { kind: 'tokens' },
};

describe('S-01: job builder (shared with the reconciler, Q-03b)', () => {
  const item = { id: 's1', language: 'cpp17', source: 'int main(){}', lane: 'practice' as const };

  it('builds a job the contract accepts, and the same one every time', () => {
    const a = buildJob(item, version, 'submit');
    expect(buildJob(item, version, 'submit')).toEqual(a);
    const full = {
      ...a,
      jobId: 'j',
      seq: 0,
      enqueuedAt: 1,
      traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
    };
    expect(JudgeJob.safeParse(full).success).toBe(true);
  });

  it('stops at the first failure only in the contest lane', () => {
    expect(buildJob(item, version, 'submit').stopOnFirstFailure).toBe(false);
    expect(buildJob({ ...item, lane: 'contest' }, version, 'submit').stopOnFirstFailure).toBe(true);
  });

  it('carries the run version and custom input, and refuses a version without tests', () => {
    expect(buildJob({ ...item, runVersion: 3, customInput: '1 2' }, version, 'run')).toMatchObject({
      runVersion: 3,
      customInput: '1 2',
      mode: 'run',
    });
    expect(() => buildJob(item, { ...version, testsetHash: null }, 'submit')).toThrow(/no testset/);
  });
});
