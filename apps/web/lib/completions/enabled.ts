import type * as Monaco from 'monaco-editor';
import { suggestionFlags } from './register';

const ON = {
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  // per editor, unlike `wordBasedSuggestions`, which is global and would switch every editor on the page
  suggest: { showWords: true },
  snippetSuggestions: 'inline',
  tabCompletion: 'on',
  parameterHints: { enabled: true },
  inlineSuggest: { enabled: true },
} as const satisfies Monaco.editor.IEditorOptions;

const OFF = {
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  suggest: { showWords: false },
  snippetSuggestions: 'none',
  tabCompletion: 'off',
  parameterHints: { enabled: false },
  inlineSuggest: { enabled: false },
} as const satisfies Monaco.editor.IEditorOptions;

export const SUGGESTION_OPTIONS = { on: ON, off: OFF } as const;

const contextKeys = new WeakMap<Monaco.editor.ICodeEditor, Monaco.editor.IContextKey<boolean>>();

/**
 * ED-01 (FR-EDIT-02/03): turn an editor's suggestions on or off, now and on later changes. Off means no typing
 * suggestions, no word suggestions, no snippets and no manual trigger either (Ctrl/⌘+Space, ⌘+I, Alt+Esc are bound to
 * nothing while off), which also silences JavaScript's built-in language service. A convenience the browser applies:
 * it is not an integrity control.
 */
export function applySuggestions(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  on: boolean,
): void {
  suggestionFlags.set(editor, on);
  let key = contextKeys.get(editor);
  if (!key) {
    key = editor.createContextKey('caSuggestionsOff', false);
    contextKeys.set(editor, key);
    const { KeyMod, KeyCode } = monaco;
    for (const binding of [
      KeyMod.CtrlCmd | KeyCode.Space,
      KeyMod.WinCtrl | KeyCode.Space,
      KeyMod.CtrlCmd | KeyCode.KeyI,
      KeyMod.Alt | KeyCode.Escape,
    ])
      editor.addCommand(binding, () => undefined, 'caSuggestionsOff');
  }
  key.set(!on);
  editor.updateOptions(on ? ON : OFF);
}
