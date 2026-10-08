'use client';
import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { cn } from '@/lib/cn';
import { SessionProvider } from '@/lib/session';
import { useGlobalShortcuts } from '@/lib/use-global-shortcuts';
import { CommandPalette } from '../command-palette';
import { ShortcutSheet } from '../shortcut-sheet';
import { TooltipProvider } from '../ui/tooltip';
import { Rail } from './rail';
import { TopBar } from './top-bar';

const ImmersiveSetter = createContext<(on: boolean) => void>(() => undefined);

/**
 * While `on` is true the rail, top bar and footer are hidden, so a contest problem has the whole
 * window (C-09). The page that asks must offer its own way back (see ContestArena).
 */
export function useImmersive(on: boolean) {
  const set = useContext(ImmersiveSetter);
  useEffect(() => {
    set(on);
    return () => set(false);
  }, [on, set]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [immersive, setImmersive] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const handlers = useMemo(
    () => ({ palette: () => setPalette(true), sheet: () => setSheet(true) }),
    [],
  );
  useGlobalShortcuts(handlers);

  return (
    <SessionProvider>
      <ImmersiveSetter.Provider value={setImmersive}>
        <TooltipProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
          >
            Skip to content
          </a>
          {immersive ? null : (
            <>
              <TopBar onPalette={() => setPalette(true)} onSheet={() => setSheet(true)} />
              <Rail />
            </>
          )}
          <div className={immersive ? undefined : 'pb-12 md:pb-0 md:pl-14 xl:pl-48'}>
            <main
              id="main"
              className={cn(
                'mx-auto max-w-[1440px] px-4 md:px-6',
                immersive ? 'min-h-dvh py-3' : 'min-h-[calc(100dvh-6rem)] py-6',
              )}
            >
              {children}
            </main>
            {/* Same footer position everywhere (WCAG 3.2.6). */}
            {immersive ? null : (
              <footer className="flex gap-4 border-t border-border px-4 py-3 text-12 text-text-3 md:px-6">
                <Link href="/rules" className="hover:text-text">
                  Rules
                </Link>
                <Link href="/status" className="hover:text-text">
                  Status
                </Link>
                <Link href="/privacy" className="hover:text-text">
                  Privacy
                </Link>
                <Link href="/terms" className="hover:text-text">
                  Terms
                </Link>
              </footer>
            )}
          </div>
          <CommandPalette
            open={palette}
            onOpenChange={setPalette}
            onShowShortcuts={() => setSheet(true)}
          />
          <ShortcutSheet open={sheet} onOpenChange={setSheet} />
          <Toaster position="bottom-right" visibleToasts={3} duration={5000} />
        </TooltipProvider>
      </ImmersiveSetter.Provider>
    </SessionProvider>
  );
}
