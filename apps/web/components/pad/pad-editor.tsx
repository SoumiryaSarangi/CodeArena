'use client';
import Editor, { loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/states';
import { currentTheme, defineThemes, themeName, type EditorTheme } from '@/lib/monaco-theme';
import type { Pad } from './use-pad';

loader.config({ paths: { vs: '/monaco/vs' } });

/**
 * The room's code: Monaco bound to `Y.Text('code')` and to the provider's awareness, so edits and named, coloured
 * cursors travel between everyone (y-monaco). Observers get a read-only editor (the server also ignores their edits).
 */
export default function PadEditor({
  pad,
  language,
  readOnly,
  label,
  fontSize = 14,
}: {
  pad: Pad;
  /** Monaco language id. */
  language: string;
  readOnly: boolean;
  label: string;
  fontSize?: number;
}) {
  const [theme, setTheme] = useState<EditorTheme>('dark');
  const binding = useRef<{ destroy: () => void } | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const obs = new MutationObserver(() => setTheme(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // Rebind if the pad is replaced (a new connection); always unbind on the way out.
  useEffect(() => {
    return () => {
      binding.current?.destroy();
      binding.current = null;
    };
  }, [pad]);

  const bind = async (editor: Monaco.editor.IStandaloneCodeEditor) => {
    const { MonacoBinding } = await import('y-monaco');
    const model = editor.getModel();
    if (!model) return;
    binding.current?.destroy();
    binding.current = new MonacoBinding(
      pad.doc.getText('code'),
      model,
      new Set([editor]),
      pad.provider.awareness ?? undefined,
    );
  };

  return (
    <Editor
      language={language}
      theme={themeName(theme)}
      loading={<Skeleton className="size-full min-h-40" />}
      beforeMount={defineThemes}
      onMount={(editor) => {
        editorRef.current = editor;
        void bind(editor);
      }}
      options={{
        ariaLabel: label,
        readOnly,
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        fontSize,
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'off',
        bracketPairColorization: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        padding: { top: 8 },
        cursorBlinking: 'solid',
        smoothScrolling: false,
        renderLineHighlight: 'line',
      }}
    />
  );
}
