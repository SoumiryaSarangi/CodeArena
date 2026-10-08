'use client';
import { EXAM_MAX_STRIKES } from '@codearena/contracts';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { warningLine, type ExamReason } from '@/lib/exam';

/** What the contestant agrees to by starting (PRD US-9.3: what is tracked is said up front). */
export const EXAM_RULES: string[] = [
  'Press Finish test when you are done. After that you cannot open the problems or submit again.',
  `Stay in this window. Switching to another tab or app, or leaving full screen, is counted: two warnings, and the ${EXAM_MAX_STRIKES}rd time your test is submitted.`,
  'Submissions you have already sent are still judged and count.',
  'Only the number of times you left the window and the time you finished are recorded. Nothing else from your screen or device is.',
];

/** The entry gate: shown before the test starts and again after a reload (no strike for a reload). */
export function ExamGate({
  title,
  strikes,
  onStart,
  contestHref,
}: {
  title: string;
  strikes: number;
  onStart: () => void;
  contestHref: string;
}) {
  const resuming = strikes > 0;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-8">
      <div className="flex flex-col gap-1">
        <span className="text-13 font-medium text-text-2">Exam mode</span>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">{title}</h1>
      </div>
      <ul className="list-disc pl-5 text-14 text-text-2">
        {EXAM_RULES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {resuming ? (
        <p role="status" className="rounded-md border border-warning px-3 py-2 text-13">
          You have already left the window {strikes} time{strikes === 1 ? '' : 's'}.{' '}
          {EXAM_MAX_STRIKES - strikes} more and your test is submitted.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onStart}>
          {resuming ? 'Resume the test' : 'Start the test'}
        </Button>
        <Button asChild variant="ghost">
          <Link href={contestHref}>Back to the contest page</Link>
        </Button>
      </div>
      <p className="text-13 text-text-3">
        The test opens in full screen where your browser allows it. This is a deterrent, not a
        proctoring tool: a notification or a pop-up can also count as leaving, and the organisers
        can give your test back.
      </p>
    </div>
  );
}

/** A leave was counted: acknowledged with a button, not dismissed by accident. */
export function ExamWarning({
  open,
  strikes,
  onContinue,
}: {
  open: boolean;
  strikes: number;
  onContinue: () => void;
}) {
  const w = warningLine(strikes);
  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent title={w.title} description={w.body} dismissible={false}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <p className="text-14">
            Leaves counted so far: {strikes} of {EXAM_MAX_STRIKES}.
          </p>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={onContinue} autoFocus>
            Continue the test
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Where a finished contestant lands, in the arena and on every reload while the contest runs. */
export function ExamFinished({ reason, slug }: { reason: ExamReason | null; slug: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-12 text-center">
      <CheckCircle2 className="size-6 text-v-ac" aria-hidden />
      <h1 className="text-20 font-semibold">
        {reason === 'left-window' ? 'Your test was submitted' : 'You finished the test'}
      </h1>
      <p className="text-14 text-text-2">
        {reason === 'left-window'
          ? `You left the test window ${EXAM_MAX_STRIKES} times, so it was submitted for you. `
          : ''}
        You cannot open the problems again while the contest runs. Your earlier submissions are
        still judged and count on the scoreboard.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild variant="primary">
          <Link href={`/c/${slug}/board`}>Open the scoreboard</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href={`/c/${slug}`}>Contest page</Link>
        </Button>
      </div>
    </div>
  );
}

/** "Finish test" in the contest bar, with a confirmation: it cannot be undone by the contestant. */
export function FinishTestButton({
  onFinish,
  busy,
  error,
}: {
  onFinish: () => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Finish test
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Finish the test?"
          description="You will not be able to open the problems or submit again."
        >
          <p className="text-14 text-text-2">
            Submissions you have already sent are still judged and count.
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-13 text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Keep working
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                if (await onFinish()) setOpen(false);
              }}
            >
              Finish the test
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
