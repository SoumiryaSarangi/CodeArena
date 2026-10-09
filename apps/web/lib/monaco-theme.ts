import type * as Monaco from 'monaco-editor';

/**
 * UI_UX §14: the editor's colours, from the design tokens. Monaco takes literal colours (it cannot
 * read CSS variables), so this file is the one place hex values live outside tokens.css.
 */
const PALETTE = {
  dark: {
    bg: '#0A0B0D',
    fg: '#E8EAED',
    line: '#858C97',
    lineActive: '#E8EAED',
    accent: '#8B7FFF',
    keyword: '#B4A9FF',
    string: '#86EFAC',
    number: '#FBBF24',
    comment: '#858C97',
    func: '#93C5FD',
    type: '#67E8F9',
    added: '#22C55E',
    removed: '#F87171',
  },
  light: {
    bg: '#FFFFFF',
    fg: '#0F1114',
    line: '#636A75',
    lineActive: '#0F1114',
    accent: '#5B4BE0',
    keyword: '#4F3FD6',
    string: '#15803D',
    number: '#B45309',
    comment: '#636A75',
    func: '#1D4ED8',
    type: '#0E7490',
    added: '#15803D',
    removed: '#DC2626',
  },
} as const;

export type EditorTheme = keyof typeof PALETTE;
export const themeName = (t: EditorTheme) => `ca-${t}`;

export function defineThemes(monaco: typeof Monaco) {
  for (const t of ['dark', 'light'] as const) {
    const p = PALETTE[t];
    const hex = (c: string) => c.slice(1);
    monaco.editor.defineTheme(themeName(t), {
      base: t === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: hex(p.keyword) },
        { token: 'string', foreground: hex(p.string) },
        { token: 'number', foreground: hex(p.number) },
        { token: 'comment', foreground: hex(p.comment), fontStyle: 'italic' },
        { token: 'identifier.function', foreground: hex(p.func) },
        { token: 'type', foreground: hex(p.type) },
        { token: 'type.identifier', foreground: hex(p.type) },
      ],
      colors: {
        'editor.background': p.bg,
        'editor.foreground': p.fg,
        'editorLineNumber.foreground': p.line,
        'editorLineNumber.activeForeground': p.lineActive,
        // accent at 28% (dark) / 18% (light)
        'editor.selectionBackground': p.accent + (t === 'dark' ? '47' : '2E'),
        'editorCursor.foreground': p.accent,
        // The diff view (S17): --v-ac / --v-wa at low strength, so comments and numbers keep their contrast.
        'diffEditor.insertedLineBackground': p.added + '0A',
        'diffEditor.removedLineBackground': p.removed + '0A',
        'diffEditor.insertedTextBackground': p.added + '14',
        'diffEditor.removedTextBackground': p.removed + '14',
      },
    });
  }
}

export const currentTheme = (): EditorTheme =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
    ? 'light'
    : 'dark';
