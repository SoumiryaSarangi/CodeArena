'use client';
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;

interface PanelProps {
  title: string;
  description?: string;
  children: ReactNode;
  /** `drawer` slides in from the right at 420 px (clarifications, shortcut sheet). */
  variant?: 'dialog' | 'drawer';
  className?: string;
  /** False: no close button, and Esc or a click outside does nothing (the buttons inside decide). */
  dismissible?: boolean;
}

/** Focus is trapped, Esc closes, focus returns to the trigger (Radix). */
export function DialogContent({
  title,
  description,
  children,
  variant = 'dialog',
  className,
  dismissible = true,
}: PanelProps) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-bg/70" />
      <D.Content
        onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
        onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
        className={cn(
          'fixed z-50 border border-border-strong bg-surface-1 shadow-[var(--shadow-overlay)]',
          variant === 'drawer'
            ? 'inset-y-0 right-0 w-full max-w-[420px] overflow-y-auto p-6'
            : 'left-1/2 top-1/2 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg p-6',
          className,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="text-20 font-semibold tracking-[-0.01em]">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-14 text-text-2">{description}</D.Description>
            ) : null}
          </div>
          {dismissible ? (
            <D.Close
              aria-label="Close"
              className="inline-flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text"
            >
              <X className="size-4" aria-hidden />
            </D.Close>
          ) : null}
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
