'use client';
import type { AdminProblemList, AdminProblemSummary } from '@codearena/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DataTable, type Column } from '@/components/data-table';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { adminProblems } from '@/lib/admin';
import type { ApiError } from '@/lib/api';
import { UploadZone } from './upload-zone';
import { ValidationBadge } from './validation-badge';

const COLUMNS: Column<AdminProblemSummary>[] = [
  {
    key: 'slug',
    header: 'Problem',
    sortValue: (p) => p.slug,
    cell: (p) => (
      <Link href={`/admin/problems/${p.slug}`} className="font-mono text-text hover:underline">
        {p.slug}
      </Link>
    ),
  },
  { key: 'title', header: 'Title', sortValue: (p) => p.title, cell: (p) => p.title },
  {
    key: 'rating',
    header: 'Rating',
    align: 'right',
    mono: true,
    sortValue: (p) => p.difficulty,
    cell: (p) => p.difficulty,
  },
  {
    key: 'visibility',
    header: 'Visibility',
    sortValue: (p) => p.visibility,
    cell: (p) => p.visibility,
  },
  {
    key: 'version',
    header: 'Version',
    align: 'right',
    mono: true,
    cell: (p) => (p.version === null ? '—' : `v${p.version}`),
  },
  { key: 'tests', header: 'Tests', align: 'right', mono: true, cell: (p) => p.testsCount },
  {
    key: 'validation',
    header: 'Validation',
    cell: (p) => <ValidationBadge status={p.validationStatus} />,
  },
];

export function ProblemList() {
  const router = useRouter();
  const [data, setData] = useState<AdminProblemList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const c = new AbortController();
    adminProblems(c.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => c.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Problems</h1>
      <div className="flex flex-col gap-2">
        <h2 className="text-16 font-medium">Upload a package</h2>
        <UploadZone onUploaded={reload} />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-16 font-medium">Your problems</h2>
        {error ? (
          <ErrorState message={error.message} requestId={error.requestId} onRetry={reload} />
        ) : data === null ? (
          <Skeleton className="h-40 w-full" />
        ) : data.items.length === 0 ? (
          <EmptyState message="No problems yet. Upload a package folder above." />
        ) : (
          <DataTable
            caption="Problems"
            columns={COLUMNS}
            rows={data.items}
            rowKey={(p) => p.slug}
            onOpen={(p) => router.push(`/admin/problems/${p.slug}`)}
          />
        )}
      </div>
    </div>
  );
}
