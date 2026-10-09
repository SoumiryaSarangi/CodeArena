import type * as Monaco from 'monaco-editor';
import { COMPLETIONS, LINE_COMMENT, type Entry, type EntryKind } from './data';

/** The editors that want suggestions off (see `enabled.ts`); a model with only such editors gets no suggestions. */
export const suggestionFlags = new WeakMap<Monaco.editor.ICodeEditor, boolean>();

const registered = new WeakSet<object>();

const KIND: Record<EntryKind, keyof typeof Monaco.languages.CompletionItemKind> = {
  keyword: 'Keyword',
  function: 'Function',
  class: 'Class',
  snippet: 'Snippet',
};

/** Whether suggestions are wanted for this model: off only if every editor showing it has them off. */
export function wantsSuggestions(monaco: typeof Monaco, model: Monaco.editor.ITextModel): boolean {
  const editors = monaco.editor.getEditors().filter((e) => e.getModel() === model);
  return editors.length === 0 || editors.some((e) => suggestionFlags.get(e) !== false);
}

/**
 * Keyword, library-name and snippet suggestions for every language we offer. Safe to call more than once. Monaco's own
 * word-based suggestions stay on and are merged with these. Not offered: inside a line comment, and after a `.` (only
 * names that can be members then, never keywords or snippets).
 */
export function registerCompletions(monaco: typeof Monaco): void {
  if (registered.has(monaco)) return;
  registered.add(monaco);
  for (const [language, entries] of Object.entries(COMPLETIONS)) {
    const comment = LINE_COMMENT[language];
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        if (!wantsSuggestions(monaco, model)) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const before = model
          .getLineContent(position.lineNumber)
          .slice(0, Math.max(0, word.startColumn - 1));
        if (comment && before.includes(comment)) return { suggestions: [] };
        const member = before.endsWith('.') || before.endsWith('->');
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const items = (member ? entries.filter((e) => e.kind === 'function') : entries).map(
          (e: Entry) => ({
            label:
              e.kind === 'snippet' && e.detail
                ? { label: e.label, description: e.detail }
                : e.label,
            kind: monaco.languages.CompletionItemKind[KIND[e.kind]],
            insertText: e.insert ?? e.label,
            insertTextRules:
              e.kind === 'snippet'
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            // names and keywords first, snippets after an exact match of the same word
            sortText: `${e.kind === 'snippet' ? '1' : '0'}_${e.label}`,
            filterText: e.label,
            range,
          }),
        );
        return { suggestions: items };
      },
    });
  }
}
