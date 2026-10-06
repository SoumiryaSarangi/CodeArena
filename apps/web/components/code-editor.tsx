'use client';
import Editor, { loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/states';
import { currentTheme, defineThemes, themeName, type EditorTheme } from '@/lib/monaco-theme';

// Self-hosted (copied to public/ by scripts/copy-monaco.mjs): no CDN, no worker bundling in Next.
loader.config({ paths: { vs: '/monaco/vs' } });

export interface CodeEditorProps {
  /**
   * Identifies the text: Monaco keeps one model per path, so switching language and back keeps
   * what was typed. The editor owns its text while you type; React only hears about changes.
   * (A controlled `value` races fast typing: a render with slightly old text would overwrite the
   * newest keystrokes.)
   */
  path: string;
  /** The text a model starts with, when it is first created for `path`. */
  initialValue: string;
  /** Bump to replace the current text with `initialValue` (Reset). */
  resetKey?: number;
  onChange: (value: string) => void;
  /** Monaco language id (`cpp`, `python`, …). */
  language: string;
  /** Accessible name, e.g. "Code editor, C++". */
  label: string;
  fontSize?: number;
  onRun?: () => void;
  onSubmit?: () => void;
  readOnly?: boolean;
}

/**
 * Monaco in our theme (UI_UX §7, §14): Geist Mono, no minimap, line numbers, no word wrap, no
 * bracket colours. Ctrl/⌘+Enter runs and Ctrl/⌘+Shift+Enter submits, overriding Monaco's own use of
 * Enter (§13). Callbacks go through refs so the commands registered once never go stale.
 */
export default function CodeEditor({
  path,
  initialValue,
  resetKey = 0,
  onChange,
  language,
  label,
  fontSize = 14,
  onRun,
  onSubmit,
  readOnly,
}: CodeEditorProps) {
  const [theme, setTheme] = useState<EditorTheme>('dark');
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const initial = useRef(initialValue);
  const run = useRef(onRun);
  const submit = useRef(onSubmit);
  useEffect(() => {
    run.current = onRun;
    submit.current = onSubmit;
  }, [onRun, onSubmit]);

  useEffect(() => {
    initial.current = initialValue;
  }, [initialValue]);
  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (resetKey === lastReset.current) return;
    lastReset.current = resetKey;
    editorRef.current?.setValue(initial.current);
  }, [resetKey]);

  // Follow the app theme, including later toggles.
  useEffect(() => {
    setTheme(currentTheme());
    const obs = new MutationObserver(() => setTheme(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return (
    <Editor
      path={path}
      defaultValue={initialValue}
      language={language}
      theme={themeName(theme)}
      onChange={(v) => onChange(v ?? '')}
      loading={<Skeleton className="size-full min-h-40" />}
      beforeMount={defineThemes}
      onMount={(editor, monaco: typeof Monaco) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run.current?.());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
          submit.current?.(),
        );
      }}
      options={{
        ariaLabel: label,
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        fontSize,
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'off',
        bracketPairColorization: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        readOnly,
        padding: { top: 8 },
        // Reduced motion: no animated caret or smooth scrolling.
        cursorBlinking: 'solid',
        smoothScrolling: false,
        renderLineHighlight: 'line',
      }}
    />
  );
}
