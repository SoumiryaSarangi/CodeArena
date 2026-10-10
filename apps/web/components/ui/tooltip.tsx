'use client';
import * as T from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={400} skipDelayDuration={300}>
    {children}
  </T.Provider>
);

/** Shows on hover and keyboard focus after 400 ms (UI_UX §7). */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={6}
          className="z-50 rounded-md border border-border-strong bg-surface-3 px-2 py-1 text-12 text-text shadow-[var(--shadow-overlay)]"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
