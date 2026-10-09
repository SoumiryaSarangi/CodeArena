/**
 * y-monaco does `import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'`, which would bundle a second copy of
 * Monaco (megabytes, plus workers we deliberately self-host instead). `next.config.ts` points that import here, so y-monaco
 * uses the Monaco that `@monaco-editor/react` already loaded from `/monaco/vs`. It only needs `Range`, `Selection` and
 * `SelectionDirection` at run time. Import y-monaco only after an editor has mounted (the pad does).
 */
type MonacoApi = typeof import('monaco-editor');
const api = (globalThis as unknown as { monaco?: MonacoApi }).monaco;
if (!api) throw new Error('Monaco is not loaded yet: import y-monaco after an editor has mounted');

export const Range = api.Range;
export const Selection = api.Selection;
export const SelectionDirection = api.SelectionDirection;
export const editor = api.editor;
