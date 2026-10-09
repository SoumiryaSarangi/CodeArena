import { describe, expect, it } from 'vitest';
import { COMPLETIONS } from '@/lib/completions/data';
import { applySuggestions, SUGGESTION_OPTIONS } from '@/lib/completions/enabled';
import { registerCompletions, suggestionFlags } from '@/lib/completions/register';
import { LANGUAGES } from '@/lib/languages';

/** The smallest stand-in for Monaco that the completion code touches. */
function fakeMonaco() {
  const providers = new Map<
    string,
    { provideCompletionItems: (model: unknown, pos: unknown) => { suggestions: Item[] } }
  >();
  const editors: unknown[] = [];
  const monaco = {
    languages: {
      registerCompletionItemProvider: (lang: string, p: never) => providers.set(lang, p),
      CompletionItemKind: { Keyword: 17, Function: 1, Class: 5, Snippet: 27 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
    editor: { getEditors: () => editors },
    KeyMod: { CtrlCmd: 2048, WinCtrl: 256, Alt: 512 },
    KeyCode: { Space: 10, KeyI: 39, Escape: 9 },
  };
  return { monaco: monaco as never, providers, editors };
}
interface Item {
  label: string | { label: string };
  kind: number;
  insertText: string;
  insertTextRules?: number;
  sortText: string;
}
const model = (line: string) => ({
  getWordUntilPosition: () => {
    const m = /[A-Za-z_]*$/.exec(line)!;
    return { word: m[0], startColumn: line.length - m[0].length + 1, endColumn: line.length + 1 };
  },
  getLineContent: () => line,
});
const labelOf = (i: Item) => (typeof i.label === 'string' ? i.label : i.label.label);
const suggest = (lang: string, line: string, ed?: ReturnType<typeof fakeMonaco>) => {
  const f = ed ?? fakeMonaco();
  registerCompletions(f.monaco);
  const m = model(line);
  f.editors.push({ getModel: () => m });
  return {
    f,
    m,
    items: f.providers
      .get(lang)!
      .provideCompletionItems(m, { lineNumber: 1, column: line.length + 1 }).suggestions,
  };
};

describe('FR-EDIT-01: keyword, library and snippet suggestions for every language we offer', () => {
  it('FR-EDIT-01: every language of the platform has a provider', () => {
    const f = fakeMonaco();
    registerCompletions(f.monaco);
    for (const l of LANGUAGES) expect(f.providers.has(l.monaco), l.id).toBe(true);
  });

  it('FR-EDIT-01: the basics are there for each language: for, while, if, a main or entry point', () => {
    for (const l of LANGUAGES) {
      const labels = new Set((COMPLETIONS[l.monaco] ?? []).map((e) => e.label));
      for (const w of ['for', 'while', 'if']) expect(labels.has(w), `${l.id}: ${w}`).toBe(true);
    }
    const has = (lang: string, label: string) =>
      (COMPLETIONS[lang] ?? []).some((e) => e.label === label);
    expect(has('cpp', 'return')).toBe(true);
    expect(has('cpp', 'vector')).toBe(true);
    expect(has('cpp', 'main')).toBe(true);
    expect(has('python', 'def')).toBe(true);
    expect(has('python', 'range')).toBe(true);
    expect(has('java', 'ArrayList')).toBe(true);
    expect(has('javascript', 'console.log')).toBe(true);
  });

  it('FR-EDIT-01: no word is listed twice in a language, and a snippet replaces a keyword of the same name', () => {
    for (const [lang, entries] of Object.entries(COMPLETIONS)) {
      const labels = entries.map((e) => e.label);
      expect(new Set(labels).size, lang).toBe(labels.length);
      const forEntry = entries.filter((e) => e.label === 'for');
      expect(forEntry).toHaveLength(1);
      expect(forEntry[0]!.kind).toBe('snippet');
    }
  });

  it('FR-EDIT-01: snippets are well formed: tab stops count from 1, every ${ closes, and each has a description', () => {
    for (const [lang, entries] of Object.entries(COMPLETIONS)) {
      for (const e of entries.filter((x) => x.kind === 'snippet')) {
        const body = e.insert ?? '';
        const stops = [...body.matchAll(/\$\{(\d+)[:}]|\$(\d)/g)].map((m) => Number(m[1] ?? m[2]));
        const positive = stops.filter((n) => n > 0);
        if (positive.length) expect(Math.min(...positive), `${lang} ${e.label}`).toBe(1);
        expect((body.match(/\$\{/g) ?? []).length, `${lang} ${e.label}`).toBe(
          (body.match(/\$\{\d+(:[^}]*)?\}/g) ?? []).length,
        );
        expect(e.detail, `${lang} ${e.label} needs a description`).toBeTruthy();
      }
    }
  });

  it('FR-EDIT-01: typing "wh" offers the while snippet as a snippet with tab stops', () => {
    const { items } = suggest('cpp', '    wh');
    const w = items.find((i) => labelOf(i) === 'while')!;
    expect(w.kind).toBe(27);
    expect(w.insertTextRules).toBe(4);
    expect(w.insertText).toContain('${1:condition}');
    const kw = items.find((i) => labelOf(i) === 'return')!;
    expect(kw.kind).toBe(17);
    expect(kw.insertTextRules).toBeUndefined();
  });

  it('FR-EDIT-01: names sort before snippets of the same word, and the replaced range is the word being typed', () => {
    const { items } = suggest('cpp', '  vec');
    const vector = items.find((i) => labelOf(i) === 'vector')!;
    const vecSnippet = items.find((i) => labelOf(i) === 'vec')!;
    expect(vector.sortText < vecSnippet.sortText).toBe(true);
    expect((vector as never as { range: { startColumn: number } }).range.startColumn).toBe(3);
  });

  it('FR-EDIT-01: nothing is offered inside a line comment; # is a comment in Python but not in C++', () => {
    expect(suggest('cpp', '  // fo').items).toHaveLength(0);
    expect(suggest('python', '  x = 1  # fo').items).toHaveLength(0);
    expect(suggest('python', '  fo').items.length).toBeGreaterThan(0);
    expect(suggest('cpp', '#inc').items.length).toBeGreaterThan(0); // a preprocessor line is code
  });

  it('FR-EDIT-01: after a dot only names that can be members are offered, never keywords or snippets', () => {
    const { items } = suggest('cpp', '  v.pu');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === 1)).toBe(true);
    expect(items.some((i) => labelOf(i) === 'push_back')).toBe(true);
  });

  it('FR-EDIT-01: registering twice adds nothing', () => {
    const f = fakeMonaco();
    registerCompletions(f.monaco);
    const first = new Map(f.providers);
    registerCompletions(f.monaco);
    expect(f.providers.size).toBe(Object.keys(COMPLETIONS).length);
    for (const [lang, p] of first) expect(f.providers.get(lang)).toBe(p); // none replaced
  });
});

describe('FR-EDIT-02/03: suggestions can be switched off', () => {
  const fakeEditor = () => {
    const calls = {
      options: [] as object[],
      commands: [] as { key: number; context: string | undefined }[],
      key: undefined as boolean | undefined,
    };
    const editor = {
      updateOptions: (o: object) => calls.options.push(o),
      createContextKey: () => ({ set: (v: boolean) => (calls.key = v) }),
      addCommand: (key: number, _h: unknown, context?: string) =>
        calls.commands.push({ key, context }),
    };
    return { editor: editor as never, calls };
  };

  it('FR-EDIT-02: off sets exactly the off options, on restores the on options', () => {
    const { monaco } = fakeMonaco();
    const { editor, calls } = fakeEditor();
    applySuggestions(editor, monaco, false);
    expect(calls.options.at(-1)).toEqual(SUGGESTION_OPTIONS.off);
    expect(SUGGESTION_OPTIONS.off).toMatchObject({
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      snippetSuggestions: 'none',
      tabCompletion: 'off',
      suggest: { showWords: false },
    });
    applySuggestions(editor, monaco, true);
    expect(calls.options.at(-1)).toEqual(SUGGESTION_OPTIONS.on);
    expect(SUGGESTION_OPTIONS.on.quickSuggestions).toMatchObject({ other: true, strings: false });
  });

  it('FR-EDIT-02: while off, every manual trigger is bound to nothing; they are registered once and follow the flag', () => {
    const { monaco } = fakeMonaco();
    const { editor, calls } = fakeEditor();
    applySuggestions(editor, monaco, false);
    applySuggestions(editor, monaco, true);
    applySuggestions(editor, monaco, false);
    expect(calls.commands).toHaveLength(4); // Ctrl/⌘+Space, Ctrl+Space (mac), ⌘+I, Alt+Esc
    expect(calls.commands.every((c) => c.context === 'caSuggestionsOff')).toBe(true);
    expect(calls.key).toBe(true);
    applySuggestions(editor, monaco, true);
    expect(calls.key).toBe(false);
  });

  it('FR-EDIT-02: a model shown only in editors that have suggestions off gets none from our providers', () => {
    const f = fakeMonaco();
    registerCompletions(f.monaco);
    const m = model('  fo');
    const ed = { getModel: () => m };
    f.editors.push(ed);
    const ask = () =>
      f.providers.get('cpp')!.provideCompletionItems(m, { lineNumber: 1, column: 5 }).suggestions
        .length;
    suggestionFlags.set(ed as never, true);
    expect(ask()).toBeGreaterThan(0);
    suggestionFlags.set(ed as never, false);
    expect(ask()).toBe(0);
    // another editor on the same model that still wants them keeps them
    const other = { getModel: () => m };
    f.editors.push(other);
    suggestionFlags.set(other as never, true);
    expect(ask()).toBeGreaterThan(0);
  });
});
