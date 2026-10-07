'use client';
import type { AdminProblemDetail, AdminVersionSummary } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DataTable, type Column } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { adminProblem, saveStatement, setVisibility } from '@/lib/admin';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { HintsTab, SaveBar, StatementTab, type Draft } from './statement-tab';
import { TestsTab } from './tests-tab';
import { UploadZone } from './upload-zone';
import { ValidationBadge } from './validation-badge';
import { ValidationTab } from './validation-tab';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : '—');

const VERSION_COLUMNS: Column<AdminVersionSummary>[] = [
  {
    key: 'v',
    header: 'Version',
    align: 'right',
    mono: true,
    sortValue: (v) => v.version,
    cell: (v) => `v${v.version}`,
  },
  { key: 'at', header: 'Created', cell: (v) => when(v.createdAt) },
  { key: 'tests', header: 'Tests', align: 'right', mono: true, cell: (v) => v.testsCount },
  {
    key: 'val',
    header: 'Validation',
    cell: (v) => <ValidationBadge status={v.validationStatus} />,
  },
  { key: 'on', header: 'Validated', cell: (v) => when(v.validatedAt) },
];

export function ProblemSetter({ slug }: { slug: string }) {
  const { session } = useSession();
  const isAdmin = session.status === 'authed' && session.me.role === 'admin';
  const [detail, setDetail] = useState<AdminProblemDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const c = new AbortController();
    adminProblem(slug, c.signal)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setError(e as ApiError);
      });
    return () => c.abort();
  }, [slug, attempt]);

  // The text being edited, shared by the Statement and Hints tabs.
  const current = detail?.current ?? null;
  const [draft, setDraft] = useState<Draft>({ statementMd: '', editorialMd: '' });
  const currentId = current?.id;
  useEffect(() => {
    if (current) setDraft({ statementMd: current.statementMd, editorialMd: current.editorialMd });
    // Only a different version replaces the draft; a reload of the same one keeps what was typed.
  }, [currentId]);
  const dirty =
    current !== null &&
    (draft.statementMd !== current.statementMd || draft.editorialMd !== current.editorialMd);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const r = await saveStatement(slug, draft);
      setSaved(r.outcome === 'unchanged' ? 'Nothing changed.' : `Saved as version ${r.version}.`);
      reload();
    } catch (e) {
      setSaveError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };

  const [visibility, setVis] = useState<'private' | 'contest' | 'public'>('private');
  const [visSaved, setVisSaved] = useState<string | null>(null);
  const [visError, setVisError] = useState<string | null>(null);
  useEffect(() => {
    if (detail) setVis(detail.visibility);
  }, [detail]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <Link href="/admin/problems" className="text-14 text-text-2 hover:underline">
          ← Problems
        </Link>
        <ErrorState message={error.message} requestId={error.requestId} onRetry={reload} />
      </div>
    );
  }
  if (detail === null) return <Skeleton className="h-64 w-full" />;

  const bar = (
    <SaveBar dirty={dirty} saving={saving} error={saveError} saved={saved} onSave={save} />
  );
  const status = detail.versions.find((v) => v.id === current?.id)?.validationStatus ?? 'pending';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link href="/admin/problems" className="text-14 text-text-2 hover:underline">
          ← Problems
        </Link>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">{detail.title}</h1>
        <p className="flex flex-wrap items-center gap-x-3 text-14 text-text-2">
          <span className="font-mono">{detail.slug}</span>
          <span>{detail.visibility}</span>
          {current ? <span className="font-mono">v{current.version}</span> : null}
          {current ? <ValidationBadge status={status} /> : null}
        </p>
      </div>

      {current === null ? (
        <>
          <EmptyState message="This problem has no version yet. Upload a package." />
          <UploadZone fixedSlug={detail.slug} onUploaded={reload} />
        </>
      ) : (
        <Tabs defaultValue="overview">
          <TabsList aria-label="Problem sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="statement">Statement</TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
            <TabsTrigger value="validation">Solutions &amp; Validation</TabsTrigger>
            <TabsTrigger value="hints">Hints</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4 flex flex-col gap-6">
            <dl className="grid max-w-2xl grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-14">
              <dt className="text-text-2">Rating</dt>
              <dd className="font-mono">{detail.difficulty}</dd>
              <dt className="text-text-2">Practice points</dt>
              <dd className="font-mono">{detail.practicePoints ?? '—'}</dd>
              <dt className="text-text-2">Tags</dt>
              <dd>{detail.tags.join(', ')}</dd>
              <dt className="text-text-2">Limits</dt>
              <dd className="font-mono">
                {current.limits.timeMs} ms · {current.limits.memMb} MB · {current.limits.outputKb}{' '}
                KB output
              </dd>
              <dt className="text-text-2">Checker</dt>
              <dd className="font-mono">
                {current.checker.kind}
                {current.checker.eps !== undefined ? ` (eps ${current.checker.eps})` : ''}
              </dd>
              <dt className="text-text-2">Samples</dt>
              <dd className="font-mono">{current.samples}</dd>
              <dt className="text-text-2">Solutions</dt>
              <dd className="font-mono">{current.solutions.length}</dd>
            </dl>

            {isAdmin ? (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setVisError(null);
                  setVisSaved(null);
                  try {
                    await setVisibility(detail.slug, visibility);
                    setVisSaved(`Visibility is now ${visibility}.`);
                    reload();
                  } catch (err) {
                    setVisError((err as Error).message);
                  }
                }}
              >
                <Select
                  label="Visibility"
                  value={visibility}
                  onChange={(e) => setVis(e.target.value as typeof visibility)}
                >
                  <option value="private">private (only setters and admins)</option>
                  <option value="contest">contest (hidden until its contest starts)</option>
                  <option value="public">public (in practice)</option>
                </Select>
                <Button type="submit" disabled={visibility === detail.visibility}>
                  Apply
                </Button>
                <span aria-live="polite" className="text-14">
                  {visSaved ? <span className="text-v-ac">{visSaved}</span> : null}
                  {visError ? <span className="text-danger">{visError}</span> : null}
                </span>
              </form>
            ) : null}

            <div className="flex flex-col gap-2">
              <h2 className="text-16 font-medium">Versions</h2>
              <DataTable
                caption="Versions"
                columns={VERSION_COLUMNS}
                rows={detail.versions}
                rowKey={(v) => v.id}
              />
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-16 font-medium">Upload a new version</h2>
              <UploadZone fixedSlug={detail.slug} onUploaded={reload} />
            </div>
          </TabsContent>

          <TabsContent value="statement" className="mt-4">
            <StatementTab
              editorKey={`${detail.slug}:${current.version}`}
              initial={draft.statementMd}
              draft={draft}
              onChange={(statementMd) => setDraft((d) => ({ ...d, statementMd }))}
              bar={bar}
            />
          </TabsContent>

          <TabsContent value="tests" className="mt-4">
            <TestsTab versionId={current.id} />
          </TabsContent>

          <TabsContent value="validation" className="mt-4">
            <ValidationTab current={current} validationStatus={status} onFinished={reload} />
          </TabsContent>

          <TabsContent value="hints" className="mt-4">
            <HintsTab
              editorKey={`${detail.slug}:${current.version}`}
              initial={draft.editorialMd}
              onChange={(editorialMd) => setDraft((d) => ({ ...d, editorialMd }))}
              bar={bar}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
