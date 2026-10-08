import type { ChatMessage } from '../types';

/**
 * A versioned prompt template. The version is part of every cache key and every log line, so changing
 * a prompt means bumping its version: old cache entries stop matching and the eval (AI-04) can compare.
 */
export interface Prompt<V> {
  id: string;
  version: number;
  render(vars: V): ChatMessage[];
}

const all = new Map<string, Prompt<never>>();

export function definePrompt<V>(p: Prompt<V>): Prompt<V> {
  const key = `${p.id}@${p.version}`;
  if (all.has(key)) throw new Error(`prompt ${key} is already defined`);
  all.set(key, p as Prompt<never>);
  return p;
}

export const promptId = (p: Pick<Prompt<unknown>, 'id' | 'version'>) => `${p.id}@${p.version}`;
export const listPrompts = () => [...all.keys()].sort();

/**
 * Wraps untrusted text (a contestant's code, comments, a chat message) in a labelled block the system
 * prompt tells the model to treat as data, never as instructions (FR-AI-07). The closing tag cannot be
 * forged from inside the text: any occurrence is broken up.
 */
export function untrusted(label: string, text: string): string {
  const safe = text.replaceAll(`</${label}>`, `<\u200b/${label}>`);
  return `<${label}>\n${safe}\n</${label}>`;
}

/** Keeps the first `maxLines` lines (code sent to a model is trimmed, SD-§12.2 step 4). */
export function clipLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length <= maxLines
    ? text
    : `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines not shown)`;
}
