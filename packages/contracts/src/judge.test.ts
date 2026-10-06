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

  it('FR-JUDGE-06: float needs eps and testlib needs sourceUri', () => {
    expect(Checker.safeParse({ kind: 'float' }).success).toBe(false);
    expect(Checker.safeParse({ kind: 'float', eps: 1e-6 }).success).toBe(true);
    expect(Checker.safeParse({ kind: 'testlib' }).success).toBe(false);
    expect(
      Checker.safeParse({ kind: 'testlib', sourceUri: 's3://codearena/checkers/c.cpp' }).success,
    ).toBe(true);
    expect(Checker.safeParse({ kind: 'testlib', binaryUri: 's3://x/y' }).success).toBe(false);
    expect(Checker.safeParse({ kind: 'tokens' }).success).toBe(true);
  });

  it('FR-SUB-05: custom-run output and stderr are optional and capped at 64 KB', () => {
    const r = fixture('judge-result') as Record<string, unknown>;
    expect(JudgeResult.safeParse(r).success).toBe(true);
    expect(
      JudgeResult.safeParse({ ...r, output: 'x'.repeat(64 * 1024), stderr: 'e' }).success,
    ).toBe(true);
    expect(JudgeResult.safeParse({ ...r, output: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(JudgeResult.safeParse({ ...r, stderr: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
  });

  it('Q-01: the testset hash and URI must be what the judge accepts, so the API cannot enqueue a job the worker would reject', () => {
    const job = fixture('judge-job') as { problem: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const withProblem = (patch: Record<string, unknown>) => ({
      ...job,
      problem: { ...job.problem, ...patch },
    });
    expect(JudgeJob.safeParse(job).success).toBe(true);
    for (const bad of [
      'sha256:abc123',
      'ABCDEF'.repeat(11).slice(0, 64),
      'a'.repeat(63),
      'g'.repeat(64),
    ]) {
      expect(JudgeJob.safeParse(withProblem({ testsetHash: bad })).success).toBe(false);
    }
    for (const bad of [
      's3://codearena/tests/x.tar',
      's3://codearena/testsets/',
      'https://codearena/testsets/x.tar',
      's3://codearena/testsets/x.tar?versionId=1',
      's3:///testsets/x.tar',
    ]) {
      expect(JudgeJob.safeParse(withProblem({ testsetUri: bad })).success).toBe(false);
    }
  });

  it('Q-01: a testlib checker source must live under checkers/', () => {
    expect(Checker.safeParse({ kind: 'testlib', sourceUri: 's3://b/checkers/c.cpp' }).success).toBe(
      true,
    );
    expect(Checker.safeParse({ kind: 'testlib', sourceUri: 's3://b/testsets/c.cpp' }).success).toBe(
      false,
    );
    expect(Checker.safeParse({ kind: 'testlib', sourceUri: 's3://b/checkers/' }).success).toBe(
      false,
    );
  });

  it('F-03: malformed traceparent is rejected', () => {
    const job = fixture('judge-job') as Record<string, unknown>;
    expect(JudgeJob.safeParse({ ...job, traceparent: 'nope' }).success).toBe(false);
  });
});
