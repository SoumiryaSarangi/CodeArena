'use client';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { useGlobalShortcuts } from '@/lib/use-global-shortcuts';
import { CommandPalette } from '../command-palette';
import { ShortcutSheet } from '../shortcut-sheet';
import { TooltipProvider } from '../ui/tooltip';
import { Rail } from './rail';
import { TopBar } from './top-bar';

export function AppShell({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const handlers = useMemo(
    () => ({ palette: () => setPalette(true), sheet: () => setSheet(true) }),
    [],
  );
  useGlobalShortcuts(handlers);

  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>
      <TopBar onPalette={() => setPalette(true)} onSheet={() => setSheet(true)} />
      <Rail />
      <div className="pb-12 md:pb-0 md:pl-14 xl:pl-48">
        <main
          id="main"
          className="mx-auto min-h-[calc(100dvh-6rem)] max-w-[1440px] px-4 py-6 md:px-6"
        >
          {children}
        </main>
        {/* Same footer position everywhere (WCAG 3.2.6). */}
        <footer className="flex gap-4 border-t border-border px-4 py-3 text-12 text-text-3 md:px-6">
          <Link href="/rules" className="hover:text-text">
            Rules
          </Link>
          <Link href="/status" className="hover:text-text">
            Status
          </Link>
        </footer>
      </div>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        onShowShortcuts={() => setSheet(true)}
      />
      <ShortcutSheet open={sheet} onOpenChange={setSheet} />
      <Toaster position="bottom-right" visibleToasts={3} duration={5000} />
    </TooltipProvider>
  );
}
