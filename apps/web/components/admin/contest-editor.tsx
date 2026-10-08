'use client';
import type { AdminContestDetail, AdminProblemSummary, ContestRules } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { StateLabel } from '@/components/contests/state-label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';
import { formatWhen, fromLocalInput, localZone, toLocalInput } from '@/lib/contest-time';
import { adminContest, patchContest, putContestProblems } from '@/lib/contests';
import { adminProblems } from '@/lib/admin';
import { ActionError } from './problem-errors';
import { ValidationBadge } from './validation-badge';

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LANGS = ['c', 'cpp17', 'cpp20', 'python3', 'java21', 'node'] as const;

interface Row {
  label: string;
  slug: string;
}

/** Admin → one contest: details and rules, the problem list, and publishing. */
export function ContestEditor({ id }: { id: string }) {
  const [c, setC] = useState<AdminContestDetail | null>(null);
  const [problems, setProblems] = useState<AdminProblemSummary[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [freeze, setFreeze] = useState('0');
  const [rules, setRules] = useState<ContestRules | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  const [busy, setBusy] = useState<'details' | 'problems' | 'publish' | null>(null);
  const [failure, setFailure] = useState<{ where: string; error: Error } | null>(null);
  const [saved, setSaved] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback((d: AdminContestDetail) => {
    setC(d);
    setTitle(d.title);
    setDescription(d.description);
    setStart(toLocalInput(d.startsAt));
    setEnd(toLocalInput(d.endsAt));
    setFreeze(
      d.freezeAt
        ? String(Math.round((Date.parse(d.endsAt) - Date.parse(d.freezeAt)) / 60_000))
        : '0',
    );
    setRules(d.rules);
    setRows(d.problems.map((p) => ({ label: p.label, slug: p.slug })));
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([adminContest(id, ctl.signal), adminProblems(ctl.signal)])
      .then(([d, p]) => {
        load(d);
        setProblems(p.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => ctl.abort();
  }, [id, attempt, load]);

  const run = async (
    which: 'details' | 'problems' | 'publish',
    what: () => Promise<AdminContestDetail>,
    message: string,
  ) => {
    setBusy(which);
    setFailure(null);
    setSaved('');
    try {
      load(await what());
      setSaved(message);
    } catch (e) {
      setFailure({ where: which, error: e as Error });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return error.status === 404 ? (
      <EmptyState message="No such contest." />
    ) : (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!c || !rules) return <Skeleton className="h-96 w-full" />;

  const live = c.state === 'running' || c.state === 'ended' || c.state === 'finalized';
  const link = `${typeof window === 'undefined' ? '' : window.location.origin}/c/${c.slug}`;

  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    const endsAt = fromLocalInput(end);
    const mins = Number(freeze);
    return run(
      'details',
      () =>
        patchContest(c.id, {
          title,
          description,
          endsAt,
          freezeAt: mins > 0 ? new Date(Date.parse(endsAt) - mins * 60_000).toISOString() : null,
          ...(live ? {} : { startsAt: fromLocalInput(start), rules }),
        }),
      'Details saved.',
    );
  };

  const saveProblems = () =>
    run('problems', () => putContestProblems(c.id, { items: rows }), 'Problem list saved.');

  const freeLabel = () => [...LABELS].find((l) => !rows.some((r) => r.label === l)) ?? 'A';

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <StateLabel state={c.state} />
        <h1 className="text-24 font-semibold tracking-[-0.01em]">{c.title}</h1>
        <p className="text-13 text-text-2">
          {formatWhen(c.startsAt)} · {c.registeredCount} registered
        </p>
      </div>

      <section aria-labelledby="publish" className="flex flex-col gap-2">
        <h2 id="publish" className="text-16 font-medium">
          Publishing
        </h2>
        {c.state === 'draft' ? (
          <p className="text-14 text-text-2">
            A draft is visible to admins only. Publishing needs at least one problem, and every
            problem version must be validated.
          </p>
        ) : (
          <div className="flex flex-col gap-1 text-14">
            <span className="text-text-2">Registration link</span>
            <div className="flex flex-wrap items-center gap-2">
              <a href={link} className="font-mono text-14 underline">
                {link}
              </a>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </div>
        )}
        {c.state !== 'draft' ? (
          <p className="text-14">
            <Link href={`/admin/contests/${c.id}/ops`} className="underline">
              Open the operations console
            </Link>{' '}
            <span className="text-text-2">(clarifications and announcements)</span>
          </p>
        ) : null}
        <div>
          {c.state === 'draft' ? (
            <Button
              variant="primary"
              loading={busy === 'publish'}
              onClick={() =>
                run('publish', () => patchContest(c.id, { published: true }), 'Published.')
              }
            >
              Publish
            </Button>
          ) : c.state === 'scheduled' ? (
            <Button
              loading={busy === 'publish'}
              onClick={() =>
                run('publish', () => patchContest(c.id, { published: false }), 'Back to draft.')
              }
            >
              Unpublish (back to draft)
            </Button>
          ) : null}
        </div>
        {failure?.where === 'publish' ? <ActionError error={failure.error} /> : null}
      </section>

      <form onSubmit={saveDetails} className="flex flex-col gap-3" aria-label="Contest details">
        <h2 className="text-16 font-medium">Details</h2>
        <Input
          label="Title"
          value={title}
          required
          minLength={3}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="desc" className="text-13 text-text-2">
            Description (plain text, shown on the contest page)
          </label>
          <textarea
            id="desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="rounded-md border border-border-control bg-surface-1 px-3 py-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Starts"
            type="datetime-local"
            value={start}
            disabled={live}
            required
            onChange={(e) => setStart(e.target.value)}
          />
          <Input
            label="Ends"
            type="datetime-local"
            value={end}
            required
            onChange={(e) => setEnd(e.target.value)}
          />
          <Input
            label="Freeze for the last (minutes, 0 = never)"
            type="number"
            min={0}
            value={freeze}
            onChange={(e) => setFreeze(e.target.value)}
          />
          <Input
            label="Penalty per rejected attempt (minutes)"
            type="number"
            min={0}
            max={120}
            value={rules.penaltyMinutes}
            disabled={live}
            onChange={(e) => setRules({ ...rules, penaltyMinutes: Number(e.target.value) })}
          />
        </div>
        <fieldset className="flex flex-col gap-2" disabled={live}>
          <legend className="text-13 text-text-2">Time-limit multiplier per language</legend>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {LANGS.map((l) => (
              <Input
                key={l}
                label={l}
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={rules.langMultipliers[l] ?? 1}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    langMultipliers: { ...rules.langMultipliers, [l]: Number(e.target.value) },
                  })
                }
              />
            ))}
          </div>
          {(
            [
              ['ceCountsAsAttempt', 'Compile errors count as rejected attempts'],
              ['rated', 'Rated'],
              ['lateRegistration', 'Allow registration while the contest runs'],
              [
                'examMode',
                'Exam mode: one entry, a Finish test button, and leaving the window 3 times submits the test',
              ],
            ] as const
          ).map(([k, text]) => (
            <label key={k} className="flex items-center gap-2 text-14">
              <input
                type="checkbox"
                checked={rules[k]}
                onChange={(e) => setRules({ ...rules, [k]: e.target.checked })}
              />
              {text}
            </label>
          ))}
        </fieldset>
        <p className="text-13 text-text-2">
          Times are in your time zone ({localZone()}).
          {live ? ' The start and the rules are fixed once the contest has begun.' : ''}
        </p>
        {failure?.where === 'details' ? <ActionError error={failure.error} /> : null}
        <div>
          <Button type="submit" variant="primary" loading={busy === 'details'}>
            Save details
          </Button>
        </div>
      </form>

      <section aria-labelledby="problems" className="flex flex-col gap-3">
        <h2 id="problems" className="text-16 font-medium">
          Problems
        </h2>
        <p className="text-13 text-text-2">
          Each problem is pinned at its current version. Once published, only validated versions can
          be added, and the list is fixed when the contest starts.
        </p>
        {rows.length === 0 ? <p className="text-14 text-text-2">No problems yet.</p> : null}
        <ul className="flex flex-col gap-2">
          {rows.map((r, i) => {
            const chosen = c.problems.find((p) => p.slug === r.slug);
            return (
              <li key={i} className="flex flex-wrap items-end gap-2">
                <div className="w-16">
                  <Input
                    label="Label"
                    value={r.label}
                    maxLength={1}
                    disabled={live}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) =>
                          j === i ? { ...x, label: e.target.value.toUpperCase() } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`p${i}`} className="text-13 text-text-2">
                    Problem
                  </label>
                  <select
                    id={`p${i}`}
                    value={r.slug}
                    disabled={live}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, slug: e.target.value } : x)))
                    }
                    className="h-8 min-w-64 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <option value="">Choose a problem…</option>
                    {problems.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.slug} — {p.title}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="pb-1.5">
                  <ValidationBadge
                    status={
                      chosen?.validationStatus ??
                      problems.find((p) => p.slug === r.slug)?.validationStatus ??
                      null
                    }
                  />
                </span>
                {live ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove problem ${r.label}`}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {live ? null : (
          <div className="flex gap-2">
            <Button onClick={() => setRows([...rows, { label: freeLabel(), slug: '' }])}>
              Add problem
            </Button>
            <Button variant="primary" loading={busy === 'problems'} onClick={saveProblems}>
              Save problem list
            </Button>
          </div>
        )}
        {failure?.where === 'problems' ? <ActionError error={failure.error} /> : null}
      </section>

      <p role="status" className="text-13 text-v-ac">
        {saved}
      </p>
    </div>
  );
}
