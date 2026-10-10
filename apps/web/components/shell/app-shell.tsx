'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Toaster } from 'sonner';
import { cn } from '@/lib/cn';
import { SessionProvider, useSession } from '@/lib/session';
import { useGlobalShortcuts } from '@/lib/use-global-shortcuts';
import { CommandPalette } from '../command-palette';
import { ShortcutSheet } from '../shortcut-sheet';
import { TooltipProvider } from '../ui/tooltip';
import { Rail } from './rail';
import { TopBar } from './top-bar';

const ImmersiveSetter = createContext<(on: boolean, lock: boolean) => void>(() => undefined);

/**
 * While `on` is true the rail, top bar and footer are hidden, so a contest problem has the whole
 * window (C-09). The page that asks must offer its own way back (see ContestArena).
 * With `lock` (a running exam) the search palette and the keyboard navigation are off as well, so
 * nothing but the page itself can take the contestant elsewhere.
 */
export function useImmersive(on: boolean, lock = false) {
  const set = useContext(ImmersiveSetter);
  useEffect(() => {
    set(on, on && lock);
    return () => set(false, false);
  }, [on, lock, set]);
}

/** Pages that introduce the product to someone who has not signed in: no app rail, a short top bar. */
const BARE_PATHS = new Set(['/', '/signin']);

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Frame>{children}</Frame>
    </SessionProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const path = usePathname();
  const bare = session.status !== 'authed' && BARE_PATHS.has(path);
  const [immersive, setImmersive] = useState(false);
  const [locked, setLocked] = useState(false);
  const setMode = useCallback((on: boolean, lock: boolean) => {
    setImmersive(on);
    setLocked(lock);
  }, []);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const handlers = useMemo(
    () => ({ palette: () => setPalette(true), sheet: () => setSheet(true) }),
    [],
  );
  useGlobalShortcuts(handlers, !locked);

  return (
    <>
      <ImmersiveSetter.Provider value={setMode}>
        <TooltipProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg"
          >
            Skip to content
          </a>
          {immersive ? null : (
            <>
              <TopBar
                bare={bare}
                onPalette={() => setPalette(true)}
                onSheet={() => setSheet(true)}
              />
              {bare ? null : <Rail />}
            </>
          )}
          <div
            className={
              immersive || bare
                ? undefined
                : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-14 xl:pl-48'
            }
          >
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
              <footer className="flex gap-1 border-t border-border px-2 py-1 text-12 text-text-3 md:px-4">
                <Link href="/rules" className="rounded-md px-2 py-2.5 hover:text-text md:py-1.5">
                  Rules
                </Link>
                <Link href="/status" className="rounded-md px-2 py-2.5 hover:text-text md:py-1.5">
                  Status
                </Link>
                <Link href="/privacy" className="rounded-md px-2 py-2.5 hover:text-text md:py-1.5">
                  Privacy
                </Link>
                <Link href="/terms" className="rounded-md px-2 py-2.5 hover:text-text md:py-1.5">
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
    </>
  );
}
