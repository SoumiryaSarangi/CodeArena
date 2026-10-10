'use client';
import type { ProblemList, ProblemSummary, ProblemTags } from '@codearena/contracts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataTable, type Column } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { ApiError, apiGet } from '@/lib/api';
import {
  DIFFICULTIES,
  STATUSES,
  STATUS_META,
  difficultyLabel,
  hasFilters,
  parseFilters,
  rangeInvalid,
  toQuery,
  type Filters,
} from '@/lib/practice';
import { TagFilter } from './tag-filter';

const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface Loaded {
  items: ProblemSummary[];
  next: string | null;
}

function StatusCell({ p }: { p: ProblemSummary }) {
  const m = STATUS_META[p.status ?? 'guest'];
  return (
    <span
      role="img"
      aria-label={m.label}
      className={p.status === 'solved' ? 'text-v-ac' : 'text-text-3'}
    >
      {m.glyph}
    </span>
  );
}

/** The word is always shown; the colour only repeats it (tokens: difficulty aliases of success, warning, danger). */
const DIFFICULTY_TONE: Record<string, string> = {
  Easy: 'text-diff-easy',
  Medium: 'text-diff-medium',
  Hard: 'text-diff-hard',
  Expert: 'text-diff-hard',
};

const COLUMNS: Column<ProblemSummary>[] = [
  { key: 'status', header: 'Status', cell: (p) => <StatusCell p={p} /> },
  {
    key: 'title',
    header: 'Title',
    sortValue: (p) => p.title.toLowerCase(),
    cell: (p) => (
      <>
        <Link href={`/p/${p.slug}`} className="break-words font-medium text-text hover:underline">
          {p.title}
        </Link>
        {/* Phones drop the other columns; what they said moves under the title. */}
        <span className="mt-0.5 block text-12 text-text-3 md:hidden">
          <span className={DIFFICULTY_TONE[difficultyLabel(p.difficulty)]}>
            {difficultyLabel(p.difficulty)}
          </span>{' '}
          <span className="font-mono">{p.difficulty}</span>
          {p.acceptance === null ? '' : ` · ${p.acceptance}% accepted`}
        </span>
      </>
    ),
  },
  {
    key: 'difficulty',
    header: 'Difficulty',
    hideOnPhone: true,
    sortValue: (p) => p.difficulty,
    cell: (p) => (
      <span>
        <span className={DIFFICULTY_TONE[difficultyLabel(p.difficulty)]}>
          {difficultyLabel(p.difficulty)}
        </span>{' '}
        <span className="font-mono text-text-3">{p.difficulty}</span>
      </span>
    ),
  },
  {
    key: 'tags',
    header: 'Tags',
    hideOnPhone: true,
    cell: (p) => (
      <span className="flex flex-wrap gap-1">
        {p.tags.slice(0, 3).map((t) => (
          <span key={t} className="rounded-sm bg-surface-3 px-1.5 text-12 text-text-2">
            {t}
          </span>
        ))}
        {p.tags.length > 3 ? (
          <span className="text-12 text-text-3" title={p.tags.slice(3).join(', ')}>
            +{p.tags.length - 3}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'acceptance',
    header: 'Acceptance',
    hideOnPhone: true,
    align: 'right',
    mono: true,
    sortValue: (p) => p.acceptance ?? -1,
    cell: (p) => (p.acceptance === null ? '—' : `${p.acceptance}%`),
  },
];

export function PracticeList() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const query = toQuery(filters);

  // The search box types ahead of the URL; the URL is updated after a short pause.
  const [text, setText] = useState(filters.q);
  const lastUrlQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== lastUrlQ.current) {
      lastUrlQ.current = filters.q;
      setText(filters.q); // back/forward or "Clear filters"
    }
  }, [filters.q]);

  // What the controls show. It leads the URL: a click is visible at once, and two quick changes
  // (min then max difficulty) both survive because each is applied on top of the newest value.
  // The URL is still the source of truth for the data and for back/forward and reloads.
  const [view, setView] = useState(filters);
  const latest = useRef(filters);
  const pushed = useRef<string[]>([]);
  useEffect(() => {
    const i = pushed.current.indexOf(query);
    if (i >= 0) {
      // The URL caught up with one of our own changes; newer ones may still be on their way.
      pushed.current.splice(0, i + 1);
      if (pushed.current.length > 0) return;
    } else {
      pushed.current = []; // back/forward or a pasted link: the URL wins
    }
    latest.current = filters;
    setView(filters);
  }, [filters, query]);

  const apply = useCallback(
    (patch: Partial<Filters>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setView(next);
      const qs = toQuery(next);
      pushed.current.push(qs);
      router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    },
    [router, path],
  );
  useEffect(() => {
    if (text.trim() === latest.current.q.trim()) return;
    const t = setTimeout(() => {
      lastUrlQ.current = text.trim();
      apply({ q: text });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, apply]);

  const [tags, setTags] = useState<ProblemTags['items']>([]);
  useEffect(() => {
    const c = new AbortController();
    apiGet<ProblemTags>('/problems/tags', c.signal)
      .then((r) => setTags(r.items))
      .catch(() => {}); // the filter still works with the tags already selected
    return () => c.abort();
  }, []);

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const invalid = rangeInvalid(filters);

  useEffect(() => {
    if (invalid) return;
    const c = new AbortController();
    setData(null);
    setError(null);
    const qs = new URLSearchParams(query);
    qs.set('limit', String(PAGE));
    apiGet<ProblemList>(`/problems?${qs}`, c.signal)
      .then((r) => setData({ items: r.items, next: r.nextCursor }))
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => c.abort();
  }, [query, invalid, attempt]);

  const more = async () => {
    if (!data?.next) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams(query);
      qs.set('limit', String(PAGE));
      qs.set('cursor', data.next);
      const r = await apiGet<ProblemList>(`/problems?${qs}`);
      setData({ items: [...data.items, ...r.items], next: r.nextCursor });
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoadingMore(false);
    }
  };

  const clear = () => {
    setText('');
    lastUrlQ.current = '';
    apply({ q: '', tags: [], minDiff: undefined, maxDiff: undefined, status: undefined });
  };
  const diffOptions = (placeholder: string) => (
    <>
      <option value="">{placeholder}</option>
      {DIFFICULTIES.map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </>
  );
  const num = (v: string) => (v === '' ? undefined : Number(v));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-28 font-semibold tracking-[-0.01em]">Practice</h1>

      <form
        role="search"
        aria-label="Filter problems"
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-wrap items-end gap-3"
      >
        <Input
          label="Search"
          type="search"
          data-search
          placeholder="Title"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={100}
          className="w-56"
        />
        <Select
          label="Min difficulty"
          value={view.minDiff ?? ''}
          onChange={(e) => apply({ minDiff: num(e.target.value) })}
        >
          {diffOptions('Any')}
        </Select>
        <Select
          label="Max difficulty"
          value={view.maxDiff ?? ''}
          onChange={(e) => apply({ maxDiff: num(e.target.value) })}
        >
          {diffOptions('Any')}
        </Select>
        <TagFilter options={tags} selected={view.tags} onChange={(t) => apply({ tags: t })} />
        <Select
          label="Status"
          value={view.status ?? ''}
          onChange={(e) => apply({ status: STATUSES.find((s) => s === e.target.value) })}
        >
          <option value="">All</option>
          <option value="solved">Solved</option>
          <option value="attempted">Attempted</option>
          <option value="new">New</option>
        </Select>
        {hasFilters(view) ? (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </form>

      {invalid ? (
        <p role="alert" className="text-13 text-danger">
          The minimum difficulty is above the maximum, so nothing can match.
        </p>
      ) : null}

      <div aria-live="polite" aria-busy={!data && !error && !invalid}>
        {error ? (
          error.status === 401 ? (
            <EmptyState
              message="Sign in to filter by your progress."
              action={
                <Button variant="secondary" onClick={() => apply({ status: undefined })}>
                  Show all problems
                </Button>
              }
            />
          ) : (
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            />
          )
        ) : data === null && !invalid ? (
          <div className="flex flex-col gap-1" aria-label="Loading problems">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState
            message="No problems match."
            action={
              <Button variant="secondary" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : data ? (
          <>
            <p className="mb-2 text-13 text-text-3">
              {data.items.length} problem{data.items.length === 1 ? '' : 's'}
              {data.next ? ' shown' : ''}
              {data.items.some((p) => p.status !== undefined && p.status !== null)
                ? ` · ${data.items.filter((p) => p.status === 'solved').length} solved`
                : ''}
            </p>
            <DataTable
              caption="Practice problems"
              columns={COLUMNS}
              rows={data.items}
              rowKey={(p) => p.slug}
              onOpen={(p) => router.push(`/p/${p.slug}`)}
            />
            {data.next ? (
              <div className="mt-3 flex justify-center">
                <Button variant="secondary" loading={loadingMore} onClick={more}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
