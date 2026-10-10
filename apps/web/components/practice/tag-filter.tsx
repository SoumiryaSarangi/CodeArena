'use client';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tags as a multi-select combobox: a button opens a panel with a search box and checkboxes (native
 * inputs, so keyboard and screen readers work). Escape or clicking outside closes it and returns
 * focus to the button.
 */
export function TagFilter({
  options,
  selected,
  onChange,
}: {
  options: { tag: string; count: number }[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // A selected tag that is not in the list (e.g. from a pasted URL) must still be removable.
  const all = [
    ...options,
    ...selected.filter((t) => !options.some((o) => o.tag === t)).map((tag) => ({ tag, count: 0 })),
  ];
  const shown = all.filter((o) => o.tag.includes(text.trim().toLowerCase()));
  const toggle = (tag: string) =>
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);

  return (
    <div
      ref={root}
      className="relative flex flex-col gap-1"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <span className="text-13 text-text-2">Tags</span>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-8 min-w-36 items-center justify-between gap-2 rounded-md border border-border-control bg-surface-1 px-3 text-14 text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        {selected.length === 0 ? 'Any tag' : `${selected.length} selected`}
        <ChevronDown className="size-4 text-text-3" aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Filter by tags"
          className="absolute left-0 top-full z-20 mt-1 flex max-h-72 w-64 flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2 shadow-[var(--shadow-overlay)]"
        >
          <input
            type="search"
            aria-label="Search tags"
            placeholder="Search tags"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            className="h-8 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text placeholder:text-text-3 focus-visible:outline-2 focus-visible:outline-focus"
          />
          <ul className="flex flex-col overflow-y-auto">
            {shown.length === 0 ? (
              <li className="px-2 py-1 text-13 text-text-3">No such tag</li>
            ) : (
              shown.map((o) => (
                <li key={o.tag}>
                  <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-14 hover:bg-surface-3">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.tag)}
                      onChange={() => toggle(o.tag)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    <span className="flex-1">{o.tag}</span>
                    {o.count > 0 ? (
                      <span className="font-mono text-12 text-text-3">{o.count}</span>
                    ) : null}
                  </label>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
