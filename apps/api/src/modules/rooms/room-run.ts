import {
  ROOM_RUN_OUTPUT_CAP,
  type RoomRunMode,
  type RoomRunView,
  type Verdict,
} from '@codearena/contracts';

/**
 * A pad without a problem still needs a job the judge accepts. "Run" with input never reads the testset
 * (`Runner.executeCustom`), so this version only supplies limits and a well-formed reference.
 */
export const SCRATCH_VERSION = {
  id: 'scratch',
  testsetHash: '0'.repeat(64),
  testsetUri: 's3://scratch/testsets/scratch',
  limits: { timeMs: 2000, memMb: 256, outputKb: 64 },
  checker: { kind: 'exact' },
} as const;

interface RunRow {
  id: string;
  by: string | null;
  language: string;
  input: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  result: unknown;
  createdAt: Date;
}

const cut = (s: string | null) =>
  s === null
    ? { text: null, cut: false }
    : s.length > ROOM_RUN_OUTPUT_CAP
      ? { text: s.slice(0, ROOM_RUN_OUTPUT_CAP), cut: true }
      : { text: s, cut: false };

/** The mode is not stored: a run with input (even empty) is `run`, a submission has none. */
export const modeOf = (input: string | null): RoomRunMode => (input === null ? 'submit' : 'run');

/** What everyone in the room is shown of a run; shared by the live event and the history so they cannot differ. */
export function roomRunView(row: RunRow): RoomRunView {
  const r = (row.result ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const num = (k: string) => (typeof r[k] === 'number' ? Math.trunc(r[k] as number) : null);
  const out = cut(str('output'));
  const err = cut(str('stderr'));
  const log = cut(str('compileLog'));
  const tests = Array.isArray(r.tests) ? (r.tests as Record<string, unknown>[]) : [];
  return {
    runId: row.id,
    mode: modeOf(row.input),
    by: row.by ?? 'unknown',
    language: row.language,
    status: row.status,
    verdict: (str('verdict') as Verdict | null) ?? null,
    timeMs: num('timeMs'),
    memKb: num('memKb'),
    output: out.text,
    stderr: err.text,
    compileLog: log.text,
    truncated: out.cut || err.cut || log.cut,
    // numbers and verdicts only: never the content of a hidden test
    tests: tests.slice(0, 200).map((t) => ({
      no: Number(t.no),
      verdict: t.verdict as Verdict,
      timeMs: Math.trunc(Number(t.timeMs ?? 0)),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}
