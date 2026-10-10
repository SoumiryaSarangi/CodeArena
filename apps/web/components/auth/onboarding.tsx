'use client';
import {
  HANDLE_RE,
  RESERVED_HANDLES,
  type HandleAvailability,
  type Language,
} from '@codearena/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError, apiFetch } from '@/lib/api';
import { LANGUAGES, isLanguage } from '@/lib/languages';
import { safeReturnTo } from '@/lib/return-to';
import { signInHref, useSession } from '@/lib/session';

const RULES = 'Handles are 3–20 characters: a–z, 0–9, _ and ., starting with a letter.';

/** What to tell the user about a handle, before or after asking the server. Null = looks fine. */
export function handleProblem(h: string): string | null {
  if (!HANDLE_RE.test(h)) return RULES;
  if ((RESERVED_HANDLES as readonly string[]).includes(h)) return 'That handle is reserved.';
  return null;
}

/** `name` → `name_k2` (and so on), cut to fit 20 characters. */
export const suggestHandle = (h: string, n = 2) => `${h.slice(0, 20 - String(n).length - 2)}_k${n}`;

/** S02 second half: pick a handle and a default language, then go where you were going. */
export function Onboarding() {
  const router = useRouter();
  const { session, reload } = useSession();
  const returnTo = safeReturnTo(useSearchParams().get('returnTo'));
  const [handle, setHandle] = useState('');
  const [language, setLanguage] = useState<Language>('cpp17');
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const h = handle.trim().toLowerCase();
  const local = h === '' ? null : handleProblem(h);

  useEffect(() => {
    if (session.status === 'guest') router.replace(signInHref('/onboarding'));
    if (session.status === 'authed' && session.me.handle) router.replace(returnTo);
  }, [session, router, returnTo]);

  // Live availability, a moment after typing stops.
  useEffect(() => {
    setTaken(null);
    if (h === '' || local) return;
    const c = new AbortController();
    const t = setTimeout(() => {
      apiFetch<HandleAvailability>(
        'GET',
        `/handles/${encodeURIComponent(h)}/available`,
        undefined,
        {
          signal: c.signal,
        },
      )
        .then((r) =>
          setTaken(
            r.available
              ? null
              : r.reason === 'reserved'
                ? 'That handle is reserved.'
                : 'That handle is taken.',
          ),
        )
        .catch(() => {}); // the server checks again on save
    }, 300);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [h, local]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (local || !h) return setError(local ?? RULES);
    setSaving(true);
    setError(null);
    try {
      await apiFetch(
        'PATCH',
        '/me',
        { handle: h, defaultLanguage: language },
        { auth: 'required' },
      );
      await reload();
      router.replace(returnTo);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'handle-taken'
          ? `That handle is taken. How about ${suggestHandle(h)}?`
          : err instanceof ApiError
            ? err.message
            : 'Could not save. Try again.',
      );
      setSaving(false);
    }
  };

  const shown = local ?? taken ?? error ?? undefined;
  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4 py-12" noValidate>
      <h1 className="text-28 font-semibold tracking-[-0.01em]">Choose your handle</h1>
      <p className="text-13 text-text-3">{RULES}</p>
      <Input
        label="Handle"
        value={handle}
        onChange={(e) => {
          setHandle(e.target.value);
          setError(null); // a message about the old handle no longer applies
        }}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={20}
        error={shown}
      />
      <Select
        label="Default language"
        value={language}
        onChange={(e) => isLanguage(e.target.value) && setLanguage(e.target.value)}
      >
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </Select>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={saving}
        disabled={!h || !!local || !!taken}
      >
        Let’s go
      </Button>
    </form>
  );
}
