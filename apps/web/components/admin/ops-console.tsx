'use client';
import type { AdminContestDetail, DlqList, OpsSummary, Rejudge } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import {
  dlqList,
  dlqRequeue,
  extendContest,
  opsSummary,
  rebuildBoard,
  rejudge,
  setProblemHidden,
} from '@/lib/contests';
import { ActionError } from './problem-errors';

const POLL_MS = 5000;
/** UI_UX S16: a heartbeat older than this is shown as a problem. */
const STALE_MS = 10_000;

const ms = (n: number | null) =>
  n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;

function Tile({ label, children, tone }: { label: string; children: ReactNode; tone?: 'danger' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border-strong px-3 py-2">
      <dt className="text-12 text-text-3">{label}</dt>
      <dd className={cn('font-mono text-16 tabular-nums', tone === 'danger' && 'text-danger')}>
        {children}
      </dd>
    </div>
  );
}

/**
 * S16 (C-07): queue and judge health, and the actions an organiser needs mid-contest: extend,
 * hide a problem, rejudge, rebuild the board, put dead-lettered jobs back. Polls every 5 s.
 */
export function OpsConsole({
  contest,
  onChanged,
}: {
  contest: AdminContestDetail;
  onChanged: () => void;
}) {
  const [sum, setSum] = useState<OpsSummary | null>(null);
  const [dlq, setDlq] = useState<DlqList['items']>([]);
  const [msg, setMsg] = useState('');
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, d] = await Promise.all([opsSummary(signal), dlqList(signal)]);
      setSum(s);
      setDlq(d.items);
    } catch {
      // keep the last numbers; the next poll tries again
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const t = setInterval(() => void load(ctl.signal), POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setFailure(null);
    try {
      setMsg(await fn());
      void load();
      onChanged();
    } catch (e) {
      setFailure(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const over = contest.state === 'ended' || contest.state === 'finalized';

  return (
    <section aria-labelledby="ops" className="flex flex-col gap-4">
      <h2 id="ops" className="text-16 font-medium">
        Queue and judges
      </h2>
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-5" aria-label="Queue statistics">
        <Tile label="Submissions / min">{sum ? sum.submissionsPerMin : '—'}</Tile>
        <Tile label="Waiting in queue">
          {sum ? sum.lanes.reduce((n, l) => n + l.depth, 0) : '—'}
        </Tile>
        <Tile label="Time to verdict p50 / p95">
          {sum ? `${ms(sum.p50Ms)} / ${ms(sum.p95Ms)}` : '—'}
        </Tile>
        <Tile label="Judges alive">{sum ? sum.workers.length : '—'}</Tile>
        <Tile label="Dead letters" tone={sum && sum.dlq > 0 ? 'danger' : undefined}>
          {sum ? sum.dlq : '—'}
        </Tile>
      </dl>
      {sum ? (
        <p className="text-13 text-text-2">
          Lanes:{' '}
          {sum.lanes.map((l, i) => (
            <span key={l.lane}>
              {i > 0 ? ' · ' : ''}
              {l.lane} <span className="font-mono">{l.depth}</span>
            </span>
          ))}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-14">
          <caption className="sr-only">Judge workers</caption>
          <thead>
            <tr className="text-left text-12 text-text-3">
              <th scope="col" className="py-1 pr-4 font-medium">
                Worker
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Busy
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Lanes
              </th>
              <th scope="col" className="py-1 font-medium">
                Last heartbeat
              </th>
            </tr>
          </thead>
          <tbody>
            {(sum?.workers ?? []).map((w) => {
              const stale = w.ageMs > STALE_MS;
              return (
                <tr key={w.id} className="border-t border-border-strong/60">
                  <th scope="row" className="py-1 pr-4 text-left font-mono font-medium">
                    {w.id}
                  </th>
                  <td className={cn('py-1 pr-4', stale && 'text-danger')}>
                    {stale ? 'Unhealthy' : w.busy > 0 ? 'Busy' : 'Idle'}
                  </td>
                  <td className="py-1 pr-4 font-mono tabular-nums">
                    {w.busy}/{w.concurrency}
                  </td>
                  <td className="py-1 pr-4 text-13 text-text-2">{w.lanes.join(', ')}</td>
                  <td className={cn('py-1 font-mono tabular-nums', stale && 'text-danger')}>
                    {(w.ageMs / 1000).toFixed(1)} s ago
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sum && sum.workers.length === 0 ? (
          <p role="alert" className="py-2 text-13 text-danger">
            No judge is reporting. Submissions will wait.
          </p>
        ) : null}
      </div>

      <h2 className="text-16 font-medium">Actions</h2>
      <p role="status" className="text-13 text-v-ac">
        {msg}
      </p>
      {failure ? <ActionError error={failure} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-13 text-text-2">Extend by</span>
        {[5, 10, 15].map((m) => (
          <Button
            key={m}
            variant="secondary"
            size="sm"
            disabled={over || busy !== null}
            loading={busy === `extend${m}`}
            onClick={() =>
              run(`extend${m}`, async () => {
                const r = await extendContest(contest.id, m);
                return `Extended by ${m} minutes; the contest now ends at ${new Date(r.endsAt).toLocaleTimeString()}. Contestants were told.`;
              })
            }
          >
            +{m} min
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Rejudge…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'rebuild'}
          disabled={busy !== null}
          onClick={() =>
            run('rebuild', async () => {
              await rebuildBoard(contest.id);
              return 'The board was rebuilt from the database.';
            })
          }
        >
          Rebuild board
        </Button>
        {over ? (
          <Button asChild variant="secondary" size="sm">
            <Link href={`/c/${contest.slug}/board?present=1`}>Open resolver</Link>
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-14 font-medium">Problems</h3>
        <ul className="flex flex-col gap-1" aria-label="Problem visibility">
          {contest.problems.map((p) => (
            <li key={p.label} className="flex items-center gap-3 text-14">
              <span className="font-mono">{p.label}</span>
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              <span className={cn('text-13', p.hidden ? 'text-warning' : 'text-text-2')}>
                {p.hidden ? 'Hidden from contestants' : 'Visible'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                loading={busy === `hide${p.label}`}
                aria-label={`${p.hidden ? 'Show' : 'Hide'} problem ${p.label}`}
                onClick={() =>
                  run(`hide${p.label}`, async () => {
                    await setProblemHidden(contest.id, p.label, !p.hidden);
                    return p.hidden
                      ? `Problem ${p.label} is visible again.`
                      : `Problem ${p.label} is hidden and off the board.`;
                  })
                }
              >
                {p.hidden ? 'Show' : 'Hide'}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-14 font-medium">Dead letters</h3>
        {dlq.length === 0 ? (
          <p className="text-13 text-text-2">Nothing parked.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Dead letters">
            {dlq.map((d) => (
              <li
                key={d.entryId}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border-strong px-3 py-2 text-14"
              >
                <span className="font-mono text-12">
                  {d.submissionId?.slice(0, 8) ?? 'unreadable'}
                </span>
                <span className="text-text-2">{d.reason}</span>
                <span className="min-w-0 flex-1 truncate text-13 text-text-3">{d.error}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null || d.submissionId === null}
                  loading={busy === `dlq${d.entryId}`}
                  aria-label={`Re-queue ${d.submissionId?.slice(0, 8) ?? 'job'}`}
                  onClick={() =>
                    run(`dlq${d.entryId}`, async () => {
                      const r = await dlqRequeue(d.entryId);
                      return `Put back on the ${r.lane} lane.`;
                    })
                  }
                >
                  Re-queue
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RejudgeDialog contest={contest} open={open} onOpenChange={setOpen} onDone={setMsg} />
    </section>
  );
}

function RejudgeDialog({
  contest,
  open,
  onOpenChange,
  onDone,
}: {
  contest: AdminContestDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: (m: string) => void;
}) {
  const [scope, setScope] = useState<Rejudge['scope']>('contest');
  const [subId, setSubId] = useState('');
  const [problemId, setProblemId] = useState(contest.problems[0]?.problemId ?? '');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);

  const id = scope === 'contest' ? contest.id : scope === 'problem' ? problemId : subId.trim();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const r = await rejudge({ scope, id, urgent });
      onDone(
        `Rejudge: ${r.queued} queued, ${r.skipped} skipped${r.truncated ? ' (more remain: run it again)' : ''}.`,
      );
      onOpenChange(false);
    } catch (err) {
      setFailure(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Rejudge"
        description="Runs the stored solutions again. Verdicts change only when the new results arrive."
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-13 text-text-2">What to rejudge</legend>
            {(
              [
                ['contest', 'Every submission in this contest'],
                ['problem', 'Every submission of one problem'],
                ['submission', 'One submission'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-14">
                <input
                  type="radio"
                  name="scope"
                  checked={scope === v}
                  onChange={() => setScope(v)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {scope === 'problem' ? (
            <label className="flex flex-col gap-1 text-13 text-text-2">
              Problem
              <select
                value={problemId}
                onChange={(e) => setProblemId(e.target.value)}
                className="h-9 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text"
              >
                {contest.problems.map((p) => (
                  <option key={p.label} value={p.problemId}>
                    {p.label} · {p.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {scope === 'submission' ? (
            <label className="flex flex-col gap-1 text-13 text-text-2">
              Submission id
              <input
                value={subId}
                onChange={(e) => setSubId(e.target.value)}
                className="h-9 rounded-md border border-border-control bg-surface-1 px-2 font-mono text-14 text-text"
              />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-14">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            Urgent: use the contest lane (ahead of practice)
          </label>
          {failure ? <ActionError error={failure} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={id === ''}>
              Rejudge
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
