'use client';
import { useEffect, useState } from 'react';
import { SHORTCUTS } from '@/lib/shortcuts';
import { Dialog, DialogContent } from './ui/dialog';
import { Kbd } from './ui/kbd';

/** `mod` is ⌘ on macOS and Ctrl elsewhere (UI_UX §13). Decided after mount to avoid hydration drift. */
export function useModLabel() {
  const [label, setLabel] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setLabel('⌘');
  }, []);
  return label;
}

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const mod = useModLabel();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="drawer"
        title="Keyboard shortcuts"
        description="Shortcuts are off while you type in a field."
      >
        <table className="w-full text-14">
          <thead className="sr-only">
            <tr>
              <th>Keys</th>
              <th>Action</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action} className="border-t border-border">
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k === 'mod' ? mod : k}</Kbd>
                    ))}
                  </span>
                </td>
                <td className="py-2 pr-3 text-text">{s.action}</td>
                <td className="py-2 text-12 text-text-3">{s.scope}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
