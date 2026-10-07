'use client';
import type { TestsList } from '@codearena/contracts';
import { useEffect, useState } from 'react';
import { DataTable, type Column } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { downloadTests, listTests } from '@/lib/admin';
import type { ApiError } from '@/lib/api';

const size = (b: number) =>
  b < 1024
    ? `${b} B`
    : b < 1024 * 1024
      ? `${(b / 1024).toFixed(1)} KB`
      : `${(b / 1048576).toFixed(1)} MB`;

type Row = TestsList['items'][number];

export function TestsTab({ versionId }: { versionId: string }) {
  const [data, setData] = useState<TestsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    setData(null);
    listTests(versionId, c.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => c.abort();
  }, [versionId, attempt]);

  const save = async (file: string) => {
    setSaving(file);
    setSaveError(null);
    try {
      await downloadTests(versionId, file);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const pad = (n: number) => String(n).padStart(2, '0');
  const columns: Column<Row>[] = [
    {
      key: 'no',
      header: 'No',
      align: 'right',
      mono: true,
      sortValue: (t) => t.no,
      cell: (t) => pad(t.no),
    },
    { key: 'in', header: 'Input', align: 'right', mono: true, cell: (t) => size(t.inBytes) },
    { key: 'ans', header: 'Answer', align: 'right', mono: true, cell: (t) => size(t.ansBytes) },
    { key: 'sample', header: 'Sample', cell: (t) => (t.sample ? 'sample' : '') },
    {
      key: 'get',
      header: 'Download',
      cell: (t) => (
        <span className="flex gap-1">
          {(['in', 'ans'] as const).map((ext) => (
            <Button
              key={ext}
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving !== null}
              onClick={() => save(`${pad(t.no)}.${ext}`)}
              aria-label={`Download test ${pad(t.no)} ${ext === 'in' ? 'input' : 'answer'}`}
            >
              .{ext}
            </Button>
          ))}
        </span>
      ),
    },
  ];

  if (error)
    return (
      <ErrorState
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  if (data === null) return <Skeleton className="h-48 w-full" />;
  if (data.items.length === 0) return <EmptyState message="This version has no tests." />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={saving !== null}
          loading={saving === 'tests.tar'}
          onClick={() => save('tests.tar')}
        >
          Download all (tests.tar)
        </Button>
        <span className="text-13 text-text-3">
          {data.items.length} tests. Only you and admins can download them.
        </span>
      </div>
      {saveError ? (
        <p role="alert" className="text-14 text-danger">
          {saveError}
        </p>
      ) : null}
      <DataTable caption="Tests" columns={columns} rows={data.items} rowKey={(t) => String(t.no)} />
    </div>
  );
}
