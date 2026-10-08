'use client';
import type { ExamAdminList } from '@codearena/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { examList, reopenParticipant } from '@/lib/contests';
import { ActionError } from './problem-errors';

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Ops console (S16), exam-mode contests only: who left the test window and whose test is over,
 * with Reopen for the false positives (a notification, a dropped connection). C-10, FR-EXAM-05.
 */
export function ExamPanel({ id }: { id: string }) {
  const [data, setData] = useState<ExamAdminList | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      examList(id, signal).then(setData, (e: unknown) => {
        if ((e as Error).name !== 'AbortError') setFailure(e as Error);
      }),
    [id],
  );
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const t = setInterval(() => void load(), 10_000);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [load]);

  const reopen = async (userId: string) => {
    setBusy(userId);
    setFailure(null);
    try {
      await reopenParticipant(id, userId);
      await load();
    } catch (e) {
      setFailure(e as Error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="exam" className="flex flex-col gap-3">
      <h2 id="exam" className="text-16 font-medium">
        Exam mode{' '}
        <span className="font-normal text-text-2">
          (who left the test window or finished; Reopen gives the test back)
        </span>
      </h2>
      {failure ? <ActionError error={failure} /> : null}
      {!data || data.items.length === 0 ? (
        <EmptyState message="Nobody has left the window or finished yet." />
      ) : (
        <table className="w-full text-14">
          <caption className="sr-only">Participants who left the test window or finished</caption>
          <thead>
            <tr className="text-left text-13 text-text-2">
              <th scope="col" className="py-1 pr-3 font-medium">
                Handle
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Left the window
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Test
              </th>
              <th scope="col" className="py-1 font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.userId} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono">{i.handle ?? i.userId.slice(0, 8)}</td>
                <td className="py-1.5 pr-3">{i.leaveCount}×</td>
                <td className="py-1.5 pr-3">
                  {i.finishedAt
                    ? `${i.finishReason === 'left-window' ? 'Submitted after leaving' : 'Finished'} at ${when(i.finishedAt)}`
                    : 'In progress'}
                </td>
                <td className="py-1.5 text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === i.userId}
                    onClick={() => void reopen(i.userId)}
                    aria-label={`Reopen the test of ${i.handle ?? i.userId}`}
                  >
                    Reopen
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
