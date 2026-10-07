import type { JobMode, JudgeJob, Lane, Language } from '@codearena/contracts';
import type { EnqueueInput } from './queue.service';

/** The parts of a problem version a judge job needs. */
export interface JudgeableVersion {
  id: string;
  testsetHash: string | null;
  testsetUri: string | null;
  limits: unknown;
  checker: unknown;
}

/**
 * Turns a stored submission (or custom run) plus its problem version into the job a worker
 * claims. The one place that decides what a job looks like: the submit endpoint, `POST /runs`
 * and the reconciler (Q-03b) all call it, so a re-enqueued job is the same as the first one.
 * `stopOnFirstFailure` is on only in the contest lane (first failing test decides); practice
 * runs every test so the verdict grid is complete.
 */
export function buildJob(
  item: {
    id: string;
    language: string;
    source: string;
    lane: Lane;
    runVersion?: number;
    customInput?: string;
  },
  version: JudgeableVersion,
  mode: JobMode,
): EnqueueInput {
  if (!version.testsetHash || !version.testsetUri) {
    throw new Error(`problem version ${version.id} has no testset`);
  }
  return {
    submissionId: item.id,
    runVersion: item.runVersion ?? 1,
    lane: item.lane,
    language: item.language as Language,
    source: item.source,
    problem: {
      versionId: version.id,
      testsetHash: version.testsetHash,
      testsetUri: version.testsetUri,
      checker: version.checker as JudgeJob['problem']['checker'],
      limits: version.limits as JudgeJob['problem']['limits'],
    },
    mode,
    ...(item.customInput === undefined ? {} : { customInput: item.customInput }),
    stopOnFirstFailure: item.lane === 'contest',
  };
}
