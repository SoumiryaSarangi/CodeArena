import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Checker, HealthSchema, JudgeJob, JudgeProgress, JudgeResult, Verdict } from './index';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('contracts', () => {
  it('hello: health schema accepts ok payload', () => {
    expect(HealthSchema.parse({ status: 'ok', service: 'api' }).status).toBe('ok');
  });

  it('F-03: fixtures parse', () => {
    expect(JudgeJob.parse(fixture('judge-job')).lane).toBe('contest');
    expect(JudgeProgress.parse(fixture('judge-progress')).phase).toBe('running');
    expect(JudgeResult.parse(fixture('judge-result')).tests).toHaveLength(2);
  });

  it('F-03: unknown fields are rejected', () => {
    const job = fixture('judge-job') as Record<string, unknown>;
    expect(JudgeJob.safeParse({ ...job, extra: 1 }).success).toBe(false);
  });

  it('FR-SUB-01: source over 64 KB is rejected', () => {
    const job = fixture('judge-job') as Record<string, unknown>;
    expect(JudgeJob.safeParse({ ...job, source: 'x'.repeat(65 * 1024) }).success).toBe(false);
    expect(JudgeJob.safeParse({ ...job, source: 'x'.repeat(64 * 1024) }).success).toBe(true);
  });

  it('FR-JUDGE-05: verdicts are exactly the eight codes', () => {
    expect(Verdict.options).toEqual(['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RE', 'CE', 'SE']);
  });

  it('FR-JUDGE-06: float needs eps and testlib needs binaryUri', () => {
    expect(Checker.safeParse({ kind: 'float' }).success).toBe(false);
    expect(Checker.safeParse({ kind: 'float', eps: 1e-6 }).success).toBe(true);
    expect(Checker.safeParse({ kind: 'testlib' }).success).toBe(false);
    expect(Checker.safeParse({ kind: 'tokens' }).success).toBe(true);
  });

  it('F-03: malformed traceparent is rejected', () => {
    const job = fixture('judge-job') as Record<string, unknown>;
    expect(JudgeJob.safeParse({ ...job, traceparent: 'nope' }).success).toBe(false);
  });
});
