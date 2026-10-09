'use client';
import { DiffEditor, loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/states';
import { currentTheme, defineThemes, themeName, type EditorTheme } from '@/lib/monaco-theme';

// Same self-hosted Monaco as the code editor.
loader.config({ paths: { vs: '/monaco/vs' } });

/** Two submissions side by side, read-only, in our editor theme. Differences are Monaco's own diff. */
export default function DiffViewer({
  left,
  right,
  language,
  leftLabel,
  rightLabel,
}: {
  left: string;
  right: string;
  language: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const [theme, setTheme] = useState<EditorTheme>('dark');
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  // The names follow the pair being shown, not only the one it was mounted with.
  useEffect(() => {
    editor.current?.getOriginalEditor().updateOptions({ ariaLabel: `Code of ${leftLabel} (left)` });
    editor.current
      ?.getModifiedEditor()
      .updateOptions({ ariaLabel: `Code of ${rightLabel} (right)` });
  }, [leftLabel, rightLabel]);
  useEffect(() => {
    setTheme(currentTheme());
    const obs = new MutationObserver(() => setTheme(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return (
    <DiffEditor
      original={left}
      modified={right}
      language={language}
      theme={themeName(theme)}
      loading={<Skeleton className="size-full min-h-40" />}
      beforeMount={defineThemes}
      onMount={(ed) => {
        editor.current = ed;
        ed.getOriginalEditor().updateOptions({ ariaLabel: `Code of ${leftLabel} (left)` });
        ed.getModifiedEditor().updateOptions({ ariaLabel: `Code of ${rightLabel} (right)` });
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8 },
        smoothScrolling: false,
      }}
    />
  );
}
