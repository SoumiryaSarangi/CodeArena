'use client';
import type { HintItem, HintResult, HintState } from '@codearena/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/states';
import { ApiError, apiFetch } from '@/lib/api';
import { cn } from '@/lib/cn';

const NAMES = { 1: 'Concept', 2: 'Approach', 3: 'Next step' } as const;

const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';

/** The hint ladder (UI_UX HintLadder, S05 Coach tab; FR-AI-01, FR-AI-04, FR-AI-05). */
export function CoachTab({
  slug,
  signedIn,
  refreshKey = 0,
}: {
  slug: string;
  signedIn: boolean;
  /** Changes after each verdict, so "you have an attempt now" is picked up without reopening the tab. */
  refreshKey?: number;
}) {
  const [state, setState] = useState<HintState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<{ level: number; text: string } | null>(null);
  const [asking, setAsking] = useState<1 | 2 | 3 | null>(null);
  const [confirm, setConfirm] = useState<HintItem | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setState(
        await apiFetch<HintState>(
          'GET',
          `/hints?problemSlug=${encodeURIComponent(slug)}`,
          undefined,
          {
            auth: 'required',
          },
        ),
      );
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, [slug]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load, refreshKey]);

  const unlock = async (item: HintItem) => {
    setConfirm(null);
    setAsking(item.level);
    setNudge(null);
    setError(null);
    try {
      const res = await apiFetch<HintResult>(
        'POST',
        '/hints',
        { problemSlug: slug, level: item.level },
        { auth: 'required' },
      );
      if (res.nudge) setNudge({ level: item.level, text: res.nudge });
      else setNotice(`Level ${item.level} hint ready`);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setAsking(null);
    }
  };

  const rate = async (item: HintItem, helpful: boolean) => {
    if (!item.hintId) return;
    setState(
      (s) =>
        s && {
          ...s,
          levels: s.levels.map((l) => (l.level === item.level ? { ...l, helpful } : l)),
        },
    );
    try {
      await apiFetch('POST', `/hints/${item.hintId}/rating`, { helpful }, { auth: 'required' });
      setNotice('Thanks for the feedback');
    } catch (err) {
      setError(messageOf(err));
      await load();
    }
  };

  if (!signedIn) return <EmptyState message="Sign in to ask the Coach for a hint." />;
  if (!state && !error) return <p className="p-3 text-13 text-text-3">Loading…</p>;
  if (!state)
    return (
      <p role="alert" className="p-3 text-13 text-danger">
        {error}
      </p>
    );

  const off = !state.enabled;
  return (
    <div className="flex flex-col gap-3 p-3">
      <h2 className="sr-only">Hints</h2>
      {off ? (
        <p
          role="status"
          className="rounded-md border border-border-strong bg-surface-2 p-3 text-14"
        >
          {state.disabledReason}
        </p>
      ) : (
        <p className="text-13 text-text-2">
          Hints get more specific at each level and lower this problem&apos;s practice points.
          {state.practicePoints !== null ? (
            <>
              {' '}
              <span className="font-mono tabular-nums" data-testid="points">
                {state.penaltyPercent > 0
                  ? `${state.practicePoints} → ${state.effectivePoints} points`
                  : `${state.practicePoints} points`}
              </span>
              .
            </>
          ) : null}{' '}
          {state.remainingThisHour} hint request{state.remainingThisHour === 1 ? '' : 's'} left this
          hour.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-13 text-danger">
          {error}
        </p>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {notice}
      </span>

      <ol className="flex flex-col gap-3">
        {state.levels.map((item) => (
          <li key={item.level}>
            <section
              aria-label={`Level ${item.level}: ${NAMES[item.level]}`}
              className={cn(
                'rounded-lg border p-3',
                item.status === 'delivered' ? 'border-border-strong' : 'border-border',
              )}
            >
              <h3 className="flex flex-wrap items-center gap-2 text-14 font-medium">
                Level {item.level} · {NAMES[item.level]}
                <span className="text-12 font-normal text-text-3">−{item.costPercent}% points</span>
              </h3>
              {item.status === 'delivered' ? (
                <div className="mt-2 flex flex-col gap-2">
                  <Markdown source={item.text ?? ''} className="text-14" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-13 text-text-2">Was this helpful?</span>
                    <Button
                      size="sm"
                      variant={item.helpful === true ? 'secondary' : 'ghost'}
                      aria-pressed={item.helpful === true}
                      onClick={() => void rate(item, true)}
                    >
                      Helpful
                    </Button>
                    <Button
                      size="sm"
                      variant={item.helpful === false ? 'secondary' : 'ghost'}
                      aria-pressed={item.helpful === false}
                      onClick={() => void rate(item, false)}
                    >
                      Not helpful
                    </Button>
                  </div>
                </div>
              ) : item.status === 'available' ? (
                <div className="mt-2 flex flex-col gap-2">
                  {item.level > 1 && !state.hasAttempt ? (
                    <p className="text-13 text-text-2">
                      This level looks at your code. Submit an attempt for this problem first, then
                      come back.
                    </p>
                  ) : null}
                  {nudge?.level === item.level ? (
                    <p role="status" className="text-13 text-text">
                      {nudge.text}
                    </p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    disabled={off || asking !== null || (item.level > 1 && !state.hasAttempt)}
                    onClick={() => setConfirm(item)}
                  >
                    {asking === item.level ? 'Writing the hint…' : `Unlock level ${item.level}`}
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-13 text-text-3">Unlock level {item.level - 1} first.</p>
              )}
            </section>
          </li>
        ))}
      </ol>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        {confirm ? (
          <DialogContent
            title={`Unlock level ${confirm.level}: ${NAMES[confirm.level]}?`}
            description={`This lowers this problem's practice points by ${confirm.costPercent}%. Only the highest level you use counts, the levels do not add up.`}
          >
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button onClick={() => void unlock(confirm)}>Unlock level {confirm.level}</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
