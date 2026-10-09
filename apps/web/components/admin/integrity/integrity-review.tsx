'use client';
import type { PlagClusterDetail, PlagDecision, PlagRun } from '@codearena/contracts';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionError } from '@/components/admin/problem-errors';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { formatWhen } from '@/lib/contest-time';
import { isLanguage, languageInfo } from '@/lib/languages';
import { CLUSTER_STATUS_TEXT, decideCluster, percent, plagCluster, plagRun } from '@/lib/plag';
import { cn } from '@/lib/cn';

const DiffViewer = dynamic(() => import('./diff-viewer'), {
  ssr: false,
  loading: () => <Skeleton className="h-96 w-full" />,
});

const DECISIONS: { id: PlagDecision; label: string }[] = [
  { id: 'clear', label: 'Clear' },
  { id: 'confirm', label: 'Confirm similar' },
  { id: 'discuss', label: 'Needs discussion' },
];

/**
 * S17 Plagiarism review: clusters on the left, members, pairs and the two-sided code in the middle, advisory signals,
 * and the decision bar. Wording: "similar submissions", never an accusation. A decision is a note for the record; it
 * changes no score and no account (FR-PLAG-05).
 */
export function IntegrityReview({ runId }: { runId: string }) {
  const [run, setRun] = useState<PlagRun | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadRun = useCallback(
    (signal?: AbortSignal) =>
      plagRun(runId, signal)
        .then((r) => {
          setRun(r);
          setSelected((s) => s ?? r.clusters[0]?.id ?? null);
        })
        .catch((e: unknown) => {
          if ((e as Error).name !== 'AbortError') setError(e as ApiError);
        }),
    [runId],
  );
  useEffect(() => {
    const ctl = new AbortController();
    void loadRun(ctl.signal);
    return () => ctl.abort();
  }, [loadRun]);

  if (error) return <ErrorState message={error.message} requestId={error.requestId} />;
  if (!run) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <Link href="/admin/integrity" className="text-13 text-text-2 underline">
          All checks
        </Link>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">Similar submissions</h1>
        <span className="text-13 text-text-2">
          {run.status === 'done'
            ? `Done${run.finishedAt ? ` · ${formatWhen(run.finishedAt)}` : ''}`
            : run.status === 'failed'
              ? 'Failed'
              : run.status === 'running'
                ? 'Checking…'
                : 'Waiting for the job…'}
        </span>
      </div>
      {run.status === 'failed' ? (
        <p role="alert" className="text-14 text-danger">
          The check failed: {String(run.metrics?.error ?? 'no reason given')}. Start it again from
          the list.
        </p>
      ) : run.status !== 'done' ? (
        <div className="flex items-center gap-3 text-14 text-text-2">
          <span>The job picks it up within a minute.</span>
          <Button size="sm" onClick={() => void loadRun()}>
            Refresh
          </Button>
        </div>
      ) : run.clusters.length === 0 ? (
        <EmptyState message="No similar submissions were found." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <nav aria-label="Groups of similar submissions">
            <ul className="flex flex-col gap-1">
              {run.clusters.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={selected === c.id ? 'true' : undefined}
                    onClick={() => setSelected(c.id)}
                    className={cn(
                      'flex w-full flex-col gap-0.5 rounded-md border border-border-strong px-3 py-2 text-left text-14 hover:bg-surface-2',
                      selected === c.id && 'bg-surface-2',
                    )}
                  >
                    <span className="font-medium">{c.problemSlug}</span>
                    <span className="text-13 text-text-2">
                      {c.size} submissions · up to {percent(c.maxScore)}
                    </span>
                    <span className="text-13 text-text-3">{CLUSTER_STATUS_TEXT[c.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {selected ? (
            <ClusterPanel key={selected} id={selected} onDecided={() => void loadRun()} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ClusterPanel({ id, onDecided }: { id: string; onDecided: () => void }) {
  const [detail, setDetail] = useState<PlagClusterDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    plagCluster(id, ctl.signal)
      .then((d) => {
        setDetail(d);
        const top = d.pairs[0];
        setLeftId(top?.subA ?? d.members[0]?.submissionId ?? null);
        setRightId(top?.subB ?? d.members[1]?.submissionId ?? null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [id]);

  const byId = useMemo(
    () => new Map((detail?.members ?? []).map((m) => [m.submissionId, m])),
    [detail],
  );
  if (error) return <ErrorState message={error.message} requestId={error.requestId} />;
  if (!detail) return <Skeleton className="h-96 w-full" />;
  const left = leftId ? byId.get(leftId) : undefined;
  const right = rightId ? byId.get(rightId) : undefined;
  const monaco =
    left && isLanguage(left.language) ? languageInfo(left.language).monaco : 'plaintext';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby="members-h" className="flex flex-col gap-2">
        <h2 id="members-h" className="text-16 font-medium">
          {detail.problemSlug}: {detail.members.length} submissions
        </h2>
        <table className="w-full text-left text-14">
          <thead className="text-13 text-text-2">
            <tr>
              <th className="py-1 pr-3 font-normal">Person</th>
              <th className="py-1 pr-3 font-normal">Language</th>
              <th className="py-1 pr-3 font-normal">Verdict</th>
              <th className="py-1 font-normal">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {detail.members.map((m) => (
              <tr key={m.submissionId} className="border-t border-border-strong">
                <td className="py-1 pr-3">@{m.handle}</td>
                <td className="py-1 pr-3">
                  {isLanguage(m.language) ? languageInfo(m.language).label : m.language}
                </td>
                <td className="py-1 pr-3">{m.verdict ?? 'not judged'}</td>
                <td className="py-1 text-text-2">{formatWhen(m.submittedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="pairs-h" className="flex flex-col gap-2">
        <h2 id="pairs-h" className="text-16 font-medium">
          Pairs, most similar first
        </h2>
        {detail.pairs.length === 0 ? (
          <p className="text-13 text-text-3">No pair scores were stored for this group.</p>
        ) : (
          <table className="w-full text-left text-14">
            <thead className="text-13 text-text-2">
              <tr>
                <th className="py-1 pr-3 font-normal">Pair</th>
                <th className="py-1 pr-3 font-normal">Shared code</th>
                <th className="py-1 pr-3 font-normal">Structure</th>
                <th className="py-1 pr-3 font-normal">Combined</th>
                <th className="py-1 font-normal">
                  <span className="sr-only">Compare</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.pairs.map((p) => {
                const on = p.subA === leftId && p.subB === rightId;
                return (
                  <tr key={`${p.subA}:${p.subB}`} className="border-t border-border-strong">
                    <td className="py-1 pr-3">
                      @{byId.get(p.subA)?.handle} and @{byId.get(p.subB)?.handle}
                    </td>
                    <td className="py-1 pr-3">{percent(p.fpScore)}</td>
                    <td className="py-1 pr-3">{percent(p.embScore)}</td>
                    <td className="py-1 pr-3 font-medium">{percent(p.combined)}</td>
                    <td className="py-1">
                      <Button
                        size="sm"
                        aria-pressed={on}
                        variant={on ? 'primary' : 'secondary'}
                        onClick={() => {
                          setLeftId(p.subA);
                          setRightId(p.subB);
                        }}
                      >
                        {on ? 'Showing' : 'Compare'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="code-h" className="flex flex-col gap-2">
        <h2 id="code-h" className="text-16 font-medium">
          Code side by side
        </h2>
        <div className="flex flex-wrap gap-3 text-13 text-text-2">
          <label className="flex items-center gap-1">
            Left
            <MemberSelect value={leftId} onChange={setLeftId} members={detail.members} />
          </label>
          <label className="flex items-center gap-1">
            Right
            <MemberSelect value={rightId} onChange={setRightId} members={detail.members} />
          </label>
        </div>
        <div className="h-96 overflow-hidden rounded-md border border-border-strong">
          {left && right ? (
            <DiffViewer
              left={left.source}
              right={right.source}
              language={monaco}
              leftLabel={`@${left.handle}`}
              rightLabel={`@${right.handle}`}
            />
          ) : null}
        </div>
        <p className="text-13 text-text-3">
          This is the code as submitted. The normalised view and the matched regions are not shown
          yet.
        </p>
      </section>

      <section
        aria-labelledby="signals-h"
        className="flex flex-col gap-2 rounded-md border border-border-strong p-3"
      >
        <h2 id="signals-h" className="flex items-center gap-2 text-16 font-medium">
          Editor signals
          <span className="rounded-sm border border-border-control px-1.5 text-13 font-normal text-text-2">
            Advisory only
          </span>
        </h2>
        <table className="w-full text-left text-14">
          <thead className="text-13 text-text-2">
            <tr>
              <th className="py-1 pr-3 font-normal">Person</th>
              <th className="py-1 pr-3 font-normal">Pastes over 50 characters</th>
              <th className="py-1 pr-3 font-normal">Left the window</th>
              <th className="py-1 pr-3 font-normal">Minutes to first accepted</th>
              <th className="py-1 pr-3 font-normal">Style change</th>
              <th className="py-1 font-normal">Canary name in code</th>
            </tr>
          </thead>
          <tbody>
            {detail.signals.map((s) => (
              <tr key={s.handle} className="border-t border-border-strong align-top">
                <td className="py-1 pr-3">@{s.handle}</td>
                <td className="py-1 pr-3">
                  {s.pastes.length === 0
                    ? 'none'
                    : s.pastes.map((p) => `${p.size} characters at ${formatWhen(p.at)}`).join('; ')}
                </td>
                <td className="py-1 pr-3">
                  {s.openedAt ? `${s.focusLosses} times` : 'not recorded'}
                </td>
                <td className="py-1 pr-3">{s.timeToAcMinutes ?? 'not available'}</td>
                <td className="py-1 pr-3">{styleText(s.styleShift)}</td>
                <td className="py-1">
                  {s.canary === null
                    ? 'not set for this problem'
                    : s.canary
                      ? 'present (weak signal)'
                      : 'absent'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-13 text-text-3">
          Reported by the contest page and worked out from the code. Many honest people paste their
          own template or switch windows to read: these are never evidence on their own and never
          change a score.
        </p>
      </section>

      <DecisionBar
        detail={detail}
        onSaved={(d) => {
          setDetail(d);
          onDecided();
        }}
      />
    </div>
  );
}

/** 0 to 1 divergence from the person's own earlier programs, in words first. */
function styleText(x: number | null): string {
  if (x === null) return 'not enough earlier code';
  const word =
    x < 0.1 ? 'like their earlier code' : x < 0.25 ? 'somewhat different' : 'very different';
  return `${word} (${x.toFixed(2)})`;
}

function MemberSelect({
  value,
  onChange,
  members,
}: {
  value: string | null;
  onChange: (id: string) => void;
  members: PlagClusterDetail['members'];
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text"
    >
      {members.map((m) => (
        <option key={m.submissionId} value={m.submissionId}>
          @{m.handle}
        </option>
      ))}
    </select>
  );
}

function DecisionBar({
  detail,
  onSaved,
}: {
  detail: PlagClusterDetail;
  onSaved: (d: PlagClusterDetail) => void;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<PlagDecision | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const ready = note.trim().length >= 3;

  const save = async (decision: PlagDecision) => {
    setSaving(decision);
    setFailure(null);
    try {
      onSaved(await decideCluster(detail.id, { decision, note: note.trim() }));
      setNote('');
    } catch (e) {
      setFailure(e as Error);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section aria-labelledby="decide-h" className="flex flex-col gap-2">
      <h2 id="decide-h" className="text-16 font-medium">
        Decision: {CLUSTER_STATUS_TEXT[detail.status]}
      </h2>
      <label className="flex flex-col gap-1 text-13 text-text-2">
        Note for the record (required)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          className="rounded-md border border-border-control bg-surface-1 p-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map((d) => (
          <Button
            key={d.id}
            variant={d.id === 'confirm' ? 'primary' : 'secondary'}
            disabled={!ready || saving !== null}
            loading={saving === d.id}
            onClick={() => void save(d.id)}
          >
            {d.label}
          </Button>
        ))}
      </div>
      <p className="text-13 text-text-3">
        A decision is a note for the record. It changes no score and no account.
      </p>
      {failure ? <ActionError error={failure} /> : null}
      {detail.decisions.length > 0 ? (
        <ol aria-label="Earlier decisions" className="flex flex-col gap-1 text-14">
          {detail.decisions.map((d) => (
            <li key={d.id} className="border-t border-border-strong pt-1">
              <span className="font-medium">{CLUSTER_STATUS_TEXT[d.decision]}</span> by @
              {d.reviewer} · <span className="text-text-2">{formatWhen(d.createdAt)}</span>
              <p className="text-text-2">{d.note}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
