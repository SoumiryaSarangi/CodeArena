'use client';
import Editor, { loader } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/states';
import { currentTheme, defineThemes, themeName, type EditorTheme } from '@/lib/monaco-theme';

loader.config({ paths: { vs: '/monaco/vs' } });

/** The replayed code: read-only Monaco showing whatever the player says the document was at that moment. */
export default function ReplayEditor({ value, language }: { value: string; language: string }) {
  const [theme, setTheme] = useState<EditorTheme>('dark');
  useEffect(() => {
    setTheme(currentTheme());
    const obs = new MutationObserver(() => setTheme(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return (
    <Editor
      value={value}
      language={language}
      theme={themeName(theme)}
      loading={<Skeleton className="size-full min-h-40" />}
      beforeMount={defineThemes}
      options={{
        readOnly: true,
        domReadOnly: true,
        ariaLabel: 'Replayed code, read-only',
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        fontSize: 14,
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'off',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8 },
        cursorBlinking: 'solid',
        smoothScrolling: false,
        renderLineHighlight: 'none',
      }}
    />
  );
}
