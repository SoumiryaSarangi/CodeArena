import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The two content widths of DIRECTION.md. Screens pick one: `Workbench` (dense working screens,
 * full width up to the shell's cap) or `Stage` (screens people watch together: a centred, roomy column).
 */
export function Workbench({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full', className)}>{children}</div>;
}

export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1120px]', className)}>{children}</div>;
}
