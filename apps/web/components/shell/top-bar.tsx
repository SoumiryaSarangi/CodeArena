'use client';
import { Command, Keyboard } from 'lucide-react';
import Link from 'next/link';
import { ThemeToggle } from '../theme-toggle';
import { Button, IconButton } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { useModLabel } from '../shortcut-sheet';

export function Wordmark() {
  return (
    <Link href="/" className="font-mono text-14 font-semibold text-text">
      codearena<span className="text-accent">▍</span>
    </Link>
  );
}

/** 48 px bar: wordmark, ⌘K, system dot (word beside the dot, never colour alone), theme, account. */
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
        {/* Live status arrives with the sys:status SSE topic (Q cards); static "ok" until then. */}
        <span className="hidden items-center gap-1.5 text-12 text-text-2 sm:inline-flex">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          Systems normal
        </span>
        <IconButton label="Keyboard shortcuts" onClick={onSheet}>
          <Keyboard className="size-4" aria-hidden />
        </IconButton>
        <ThemeToggle />
      </div>
    </header>
  );
}
