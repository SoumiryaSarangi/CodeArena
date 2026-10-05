import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/** Skeletons must match the final layout; size them with className (no layout shift). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-judging rounded-md bg-surface-3', className)} />;
}

/** Icon + one line + one action (UI_UX §7 / §10.4). */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <Inbox className="size-5 text-text-3" aria-hidden />
      <p className="text-14 text-text-2">{message}</p>
      {action}
    </div>
  );
}

/** What happened + retry + request id (UI_UX §10.3). */
export function ErrorState({
  message = 'Something went wrong on our side. Try again.',
  requestId,
  onRetry,
}: {
  message?: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <AlertTriangle className="size-5 text-danger" aria-hidden />
      <p className="text-14 text-text">
        {message}
        {requestId ? <span className="font-mono text-text-3"> (Ref: {requestId})</span> : null}
      </p>
      {onRetry ? (
        <Button onClick={onRetry} variant="secondary">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
