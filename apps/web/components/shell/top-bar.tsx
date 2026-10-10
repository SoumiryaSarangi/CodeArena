'use client';
import { Command, Keyboard } from 'lucide-react';
import localFont from 'next/font/local';
import Link from 'next/link';
import { ThemeToggle } from '../theme-toggle';
import { Button, IconButton } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { useModLabel } from '../shortcut-sheet';
import { Handle } from '../handle';
import { signInHref, useSession } from '@/lib/session';
import { usePathname } from 'next/navigation';
import { usePlatformStatus } from '@/lib/status';

/**
 * The name in the top bar, and only here (UI-15, round 2): Space Grotesk Bold (SIL OFL) cut down to the nine
 * letters of the name (about 1 KB, `scripts/subset-wordmark.sh`), "code" in the blue, "arena" in the text
 * colour, a thin caret bar in the blue. Solid colours from tokens. Everywhere else the name is plain text.
 */
const wordmarkFont = localFont({
  src: '../../app/fonts/wordmark.woff2',
  weight: '700',
  display: 'swap',
  // Not a face the rest of the page uses: no CSS variable, only this element carries the class.
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="codearena"
      className={`hit-44 inline-flex items-center text-20 leading-none tracking-[-0.01em] ${wordmarkFont.className}`}
    >
      <span aria-hidden className="text-wordmark-code">
        code
      </span>
      <span aria-hidden className="text-wordmark-arena">
        arena
      </span>
      <span aria-hidden className="ml-0.5 h-[1em] w-[0.12em] rounded-[1px] bg-wordmark-caret" />
    </Link>
  );
}

const DOT = {
  ok: { word: 'Systems normal', dot: 'bg-success' },
  degraded: { word: 'Degraded performance', dot: 'bg-warning' },
  down: { word: 'Judging is down', dot: 'bg-danger' },
  unknown: { word: 'Status unknown', dot: 'bg-text-3' },
} as const;

/** The system dot of UI_UX §S01: the word beside it, never colour alone; links to the status page. */
function SystemDot() {
  const s = usePlatformStatus(30_000);
  const d = s === null ? null : s === 'error' ? DOT.unknown : DOT[s.overall];
  return (
    <Link
      href="/status"
      className="hit-44 hidden items-center gap-1.5 text-12 text-text-2 hover:text-text sm:inline-flex"
    >
      <span className={`size-2 rounded-full ${d?.dot ?? 'bg-text-3'}`} aria-hidden />
      {d?.word ?? 'Checking status'}
    </Link>
  );
}

/** 48 px bar: wordmark, ⌘K, system dot (word beside the dot, never colour alone), theme, account. */
/** Guests get a Sign in link that returns them here; signed-in users see their handle and Sign out. */
function Account() {
  const { session, signOut } = useSession();
  const path = usePathname();
  if (session.status === 'loading') return <span className="h-8 w-16" aria-hidden />;
  if (session.status === 'guest') {
    return (
      <Button asChild variant="secondary" size="sm">
        <Link href={path === '/signin' ? '/signin' : signInHref(path)}>Sign in</Link>
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Link
        href="/onboarding"
        className="hit-44 max-w-[5.5rem] truncate text-13 text-text-2 hover:text-text sm:max-w-[16rem]"
        title={session.me.handle ?? undefined}
      >
        {session.me.handle ? (
          <Handle handle={session.me.handle} rating={session.me.rating} />
        ) : (
          'Choose a handle'
        )}
      </Link>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </span>
  );
}

export function TopBar({
  onPalette,
  onSheet,
  bare = false,
}: {
  onPalette: () => void;
  onSheet: () => void;
  /** Signed-out landing and sign-in: wordmark, status, theme and Sign in only. */
  bare?: boolean;
}) {
  const mod = useModLabel();
  return (
    <header className="glass sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border-strong px-4 md:px-6">
      <Wordmark />
      <div className="ml-auto flex items-center gap-2">
        {bare ? null : (
          <Button
            variant="secondary"
            size="sm"
            onClick={onPalette}
            aria-label="Open command palette"
          >
            <Command className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Search</span>
            <Kbd className="hidden sm:inline-flex">{mod} K</Kbd>
          </Button>
        )}
        <SystemDot />
        {bare ? null : (
          <IconButton label="Keyboard shortcuts" onClick={onSheet} className="max-sm:hidden">
            <Keyboard className="size-4" aria-hidden />
          </IconButton>
        )}
        <ThemeToggle />
        <Account />
      </div>
    </header>
  );
}
