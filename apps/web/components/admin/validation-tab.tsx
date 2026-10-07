'use client';
import type { AdminProblemDetail, ValidationItem, ValidationRun } from '@codearena/contracts';
import { Check, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DataTable, type Column } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { VerdictBadge } from '@/components/verdict-badge';
import { startValidation, validationRun } from '@/lib/admin';
import type { ApiError } from '@/lib/api';
import { formatMs } from '@/lib/format';
import { ValidationBadge } from './validation-badge';

const POLL_MS = 1500;
type Current = NonNullable<AdminProblemDetail['current']>;

/** What the table shows before any run: the package's own declarations. */
function declared(current: Current): ValidationItem[] {
  const base = {
    status: 'queued' as const,
    actual: null,
    timeMs: null,
    memKb: null,
    failedTests: [],
    ok: null,
  };
  return [
    ...current.solutions.map((s) => ({
      ...base,
      kind: 'solution' as const,
      name: s.name,
      language: s.language,
      expected: s.expected,
    })),
    {
      ...base,
      kind: 'validator' as const,
      name: 'validator.cpp',
      language: 'cpp17',
      expected: 'AC' as const,
    },
  ];
}

export function ValidationTab({
  current,
  validationStatus,
  onFinished,
}: {
  current: Current;
  validationStatus: 'pending' | 'running' | 'passed' | 'failed';
  /** Called when a run ends, so the page can refresh the version's status. */
  onFinished: () => void;
}) {
  const [run, setRun] = useState<ValidationRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  // After a reload, show the last run of this version.
  const lastRunId = current.lastRun?.id;
  useEffect(() => {
    if (!lastRunId) return;
    const c = new AbortController();
    validationRun(lastRunId, c.signal)
      .then(setRun)
      .catch(() => {}); // the table still shows what the package declares
    return () => c.abort();
  }, [lastRunId]);

  const running = run !== null && (run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!running || !run) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      validationRun(run.id, c.signal)
        .then((r) => {
          setRun(r);
          if (r.status !== 'queued' && r.status !== 'running') finished.current();
        })
        .catch((e: unknown) => {
          if ((e as Error).name !== 'AbortError') setError(e as ApiError);
        });
    }, POLL_MS);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [running, run]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      setRun(await startValidation(current.id));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setStarting(false);
    }
  }, [current.id]);

  const items = run?.items ?? declared(current);
  const done = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const wrong = items.filter((i) => i.ok === false);
  const summary = !run
    ? 'Not run yet.'
    : running
      ? `Judging ${items.length} jobs… ${done} done.`
      : run.ok
        ? `All ${items.length} behave as expected.`
        : `${wrong.length} of ${items.length} do not match what the package declares.`;

  const columns: Column<ValidationItem>[] = [
    {
      key: 'name',
      header: 'Solution',
      cell: (i) => (
        <span className="font-mono">
          {i.name}
          {i.kind === 'validator' ? (
            <span className="font-sans text-text-3"> (validator)</span>
          ) : null}
        </span>
      ),
    },
    { key: 'lang', header: 'Language', cell: (i) => i.language },
    { key: 'expected', header: 'Expected', cell: (i) => <VerdictBadge verdict={i.expected} /> },
    {
      key: 'actual',
      header: 'Actual',
      cell: (i) =>
        i.actual !== null ? (
          <VerdictBadge verdict={i.actual} />
        ) : run && i.status === 'failed' ? (
          <span className="text-danger">not judged</span>
        ) : run ? (
          <VerdictBadge verdict="pending" />
        ) : (
          <span className="text-text-3">—</span>
        ),
    },
    {
      key: 'time',
      header: 'Time',
      align: 'right',
      mono: true,
      cell: (i) => (i.timeMs === null ? '—' : formatMs(i.timeMs)),
    },
    {
      key: 'ok',
      header: 'Result',
      cell: (i) =>
        i.ok === true ? (
          <span className="inline-flex items-center gap-1 text-v-ac">
            <Check className="size-3.5" aria-hidden /> as expected
          </span>
        ) : i.ok === false ? (
          <span className="inline-flex items-center gap-1 text-v-wa">
            <X className="size-3.5" aria-hidden /> differs
          </span>
        ) : (
          <span className="text-text-3">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="primary"
          loading={starting}
          disabled={starting || running || !current.validatorStored}
          onClick={start}
        >
          Validate
        </Button>
        <span className="text-14 text-text-2">
          Version {current.version}: <ValidationBadge status={validationStatus} />
        </span>
      </div>
      {!current.validatorStored ? (
        <p className="text-14 text-warning">
          This version was imported before validators were stored. Upload the package again
          (Overview tab) to validate it.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-14 text-text-2">
        {summary}
      </p>
      {error ? (
        <p role="alert" className="text-14 text-danger">
          {error.message}
        </p>
      ) : null}
      <DataTable
        caption="Solutions and validation"
        columns={columns}
        rows={items}
        rowKey={(i) => `${i.kind}:${i.name}`}
      />
      {wrong.length > 0 && !running ? (
        <section aria-label="What differs" className="flex flex-col gap-2">
          <h3 className="text-14 font-medium">What differs</h3>
          <ul className="flex flex-col gap-2 text-13 text-text-2">
            {wrong.map((i) => (
              <li key={`${i.kind}:${i.name}`}>
                <span className="font-mono text-text">{i.name}</span>: expected {i.expected}
                {i.actual ? `, got ${i.actual}` : ', not judged'}.
                {i.failedTests.length > 0 ? (
                  <ul className="ml-4 list-disc">
                    {i.failedTests.map((t) => (
                      <li key={t.no}>
                        test {t.no}: {t.verdict}
                        {t.message ? ` — ${t.message}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {i.message ? (
                  <pre className="mt-1 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-12">
                    {i.message}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
