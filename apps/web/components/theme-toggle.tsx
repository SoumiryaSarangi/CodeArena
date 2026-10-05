'use client';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { THEME_KEY, type Theme } from '@/lib/theme';
import { IconButton } from './ui/button';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  const flip = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable: the choice just won't persist */
    }
  };

  return (
    <IconButton
      label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      onClick={flip}
    >
      {theme === 'light' ? (
        <Moon className="size-4" aria-hidden />
      ) : (
        <Sun className="size-4" aria-hidden />
      )}
    </IconButton>
  );
}
