import { languageInfo } from './languages';

/** One draft per problem and language (UI_UX S05), saved to localStorage a moment after typing. */
export const DRAFT_DEBOUNCE_MS = 500;
const key = (slug: string, language: string) => `draft:${slug}:${language}`;
const MAX_DRAFT_CHARS = 64 * 1024;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Storage can be missing or throw (private mode, blocked site data): everything degrades to "no draft". */
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadDraft(slug: string, language: string, s: Store | null = store()): string {
  try {
    return s?.getItem(key(slug, language)) ?? languageInfo(language).template;
  } catch {
    return languageInfo(language).template;
  }
}

export function saveDraft(slug: string, language: string, code: string, s: Store | null = store()) {
  try {
    if (code.length > MAX_DRAFT_CHARS) return;
    s?.setItem(key(slug, language), code);
  } catch {
    // a full or blocked disk is not worth interrupting someone who is typing
  }
}

export function clearDraft(slug: string, language: string, s: Store | null = store()) {
  try {
    s?.removeItem(key(slug, language));
  } catch {
    // see above
  }
}

/** The language last used on this problem, so reopening it lands where you left off. */
const langKey = (slug: string) => `lang:${slug}`;
export function loadLanguage(slug: string, fallback: string, s: Store | null = store()): string {
  try {
    return s?.getItem(langKey(slug)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveLanguage(slug: string, language: string, s: Store | null = store()) {
  try {
    s?.setItem(langKey(slug), language);
  } catch {
    // see above
  }
}
