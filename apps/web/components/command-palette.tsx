'use client';
import * as D from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { Code, Home, Keyboard, Moon, Trophy, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { THEME_KEY } from '@/lib/theme';

const item =
  'flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-14 text-text-2 data-[selected=true]:bg-surface-3 data-[selected=true]:text-text';

/**
 * cmdk palette. Groups follow UI_UX §7; Problems/Contests/Submissions fill in as those screens
 * land, so today it carries Navigation and Actions only.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const router = useRouter();
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  const row = (icon: ReactNode, label: string, run: () => void, keywords?: string[]) => (
    <Command.Item value={label} keywords={keywords} onSelect={run} className={item}>
      {icon}
      {label}
    </Command.Item>
  );

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <D.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[15vh] z-50 w-[calc(100%-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-[var(--shadow-overlay)]"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">
            Type to jump to a page or run an action.
          </D.Description>
          <Command label="Command palette">
            <Command.Input
              placeholder="Type a command or search…"
              className="h-11 w-full border-b border-border-strong bg-transparent px-3 text-14 text-text placeholder:text-text-3 focus:outline-none"
            />
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center text-14 text-text-3">
                Nothing found.
              </Command.Empty>
              <Command.Group
                heading="Navigation"
                className="text-12 text-text-3 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {row(<Home className="size-4" aria-hidden />, 'Home', () => go('/home'))}
                {row(<Code className="size-4" aria-hidden />, 'Practice', () => go('/practice'))}
                {row(<Trophy className="size-4" aria-hidden />, 'Contests', () => go('/contests'))}
                {row(<Users className="size-4" aria-hidden />, 'Interview', () => go('/interview'))}
              </Command.Group>
              <Command.Group
                heading="Actions"
                className="text-12 text-text-3 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {row(<Keyboard className="size-4" aria-hidden />, 'Keyboard shortcuts', () => {
                  onOpenChange(false);
                  onShowShortcuts();
                })}
                {row(
                  <Moon className="size-4" aria-hidden />,
                  'Toggle theme',
                  () => {
                    const next =
                      document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
                    document.documentElement.dataset.theme = next;
                    try {
                      localStorage.setItem(THEME_KEY, next);
                    } catch {
                      /* not persisted */
                    }
                    onOpenChange(false);
                  },
                  ['dark', 'light'],
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
