'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { GO_ROUTES } from './shortcuts';

// Monaco takes its input through its own element (a textarea, or an edit-context div that is not
// `contenteditable`), so anything inside an editor counts as typing too.
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ||
    el.closest('.monaco-editor, [role="textbox"]') !== null);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** ⌘K / Ctrl+K, `?`, `/` (focus search) and the `g` navigation sequences (UI_UX §13). Ignored while typing. */
export function useGlobalShortcuts(
  handlers: { palette: () => void; sheet: () => void },
  enabled = true,
) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
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
      } else if (!MODIFIER_KEYS.has(e.key)) {
        // `g` then the next key: any other key cancels the sequence, so "g ... p" typed a moment
        // apart is not "g p".
        armedAt = 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, router, enabled]);
}
