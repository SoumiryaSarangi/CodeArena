'use client';
import { Command, Keyboard } from 'lucide-react';
import Link from 'next/link';
import { ThemeToggle } from '../theme-toggle';
import { Button, IconButton } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { useModLabel } from '../shortcut-sheet';
import { signInHref, useSession } from '@/lib/session';
import { usePathname } from 'next/navigation';
import { usePlatformStatus } from '@/lib/status';

export function Wordmark() {
  return (
    <Link href="/" className="hit-44 font-mono text-14 font-semibold text-text">
      codearena<span className="text-accent">▍</span>
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
      <Link href="/onboarding" className="hit-44 text-13 text-text-2 hover:text-text">
        {session.me.handle ?? 'Choose a handle'}
      </Link>
      <Button variant="ghost" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
    </span>
  );
}

export function TopBar({ onPalette, onSheet }: { onPalette: () => void; onSheet: () => void }) {
  const mod = useModLabel();
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border-strong bg-surface-1 px-4 md:px-6">
      <Wordmark />
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onPalette} aria-label="Open command palette">
          <Command className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">Search</span>
          <Kbd className="hidden sm:inline-flex">{mod} K</Kbd>
        </Button>
        <SystemDot />
        <IconButton label="Keyboard shortcuts" onClick={onSheet}>
          <Keyboard className="size-4" aria-hidden />
        </IconButton>
        <ThemeToggle />
        <Account />
      </div>
    </header>
  );
}
