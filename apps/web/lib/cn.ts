import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The type scale uses `text-12 … text-48` (UI_UX §5.2). Without this, tailwind-merge reads them
// as text *colours* and drops a colour class passed alongside (e.g. `text-accent-fg text-14`).
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { 'font-size': [{ text: ['12', '13', '14', '16', '20', '24', '32', '48'] }] },
  },
});

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
