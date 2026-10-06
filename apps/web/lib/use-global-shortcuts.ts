'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { GO_ROUTES } from './shortcuts';

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** ⌘K / Ctrl+K, `?`, `/` (focus search) and the `g` navigation sequences (UI_UX §13). Ignored while typing. */
export function useGlobalShortcuts(handlers: { palette: () => void; sheet: () => void }) {
  const router = useRouter();
  useEffect(() => {
    let armedAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.palette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === '/') {
        // UI_UX §13: focus the page's search box, if it has one.
        const search = document.querySelector<HTMLElement>('[data-search]');
        if (search) {
          e.preventDefault();
          search.focus();
        }
      } else if (e.key === '?') {
        e.preventDefault();
        handlers.sheet();
      } else if (e.key === 'g') {
        armedAt = Date.now();
      } else if (Date.now() - armedAt < 1000 && GO_ROUTES[e.key]) {
        armedAt = 0;
        router.push(GO_ROUTES[e.key]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, router]);
}
