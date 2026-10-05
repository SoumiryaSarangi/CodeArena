import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface-3 px-1 font-mono text-12 text-text-2',
        className,
      )}
      {...props}
    />
  );
}
