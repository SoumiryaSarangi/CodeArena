'use client';
import dynamic from 'next/dynamic';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/states';
import type { ApiError } from '@/lib/api';

const CodeEditor = dynamic(() => import('@/components/code-editor'), {
  ssr: false,
  loading: () => <Skeleton className="h-[60vh] w-full" />,
});

export interface Draft {
  statementMd: string;
  editorialMd: string;
}

/** Shared by the Statement and Hints tabs: one draft, one Save that makes a new version. */
export function SaveBar({
  dirty,
  saving,
  error,
  saved,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  error: ApiError | null;
  saved: string | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          disabled={!dirty || saving}
          loading={saving}
          onClick={onSave}
        >
          Save as a new version
        </Button>
        <span className="text-13 text-text-3">
          {dirty ? 'Unsaved changes' : 'Saved'}. Tests and validation stay as they are.
        </span>
      </div>
      <div aria-live="polite" className="text-14">
        {saved ? (
          <p role="status" className="text-v-ac">
            {saved}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="flex flex-col gap-1 text-danger">
            <p>{error.message}</p>
            {error.errors && error.errors.length > 0 ? (
              <ul className="list-disc pl-5">
                {error.errors.map((e, i) => (
                  <li key={`${e.path}:${i}`}>{e.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StatementTab({
  editorKey,
  initial,
  draft,
  onChange,
  bar,
}: {
  editorKey: string;
  initial: string;
  draft: Draft;
  onChange: (statementMd: string) => void;
  bar: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {bar}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-[60vh] min-h-64 overflow-hidden rounded-md border border-border-strong">
          <CodeEditor
            path={`statement:${editorKey}`}
            initialValue={initial}
            onChange={onChange}
            language="markdown"
            label="Statement, Markdown editor"
          />
        </div>
        <section
          aria-label="Statement preview"
          className="h-[60vh] min-h-64 overflow-auto rounded-md border border-border-strong p-4"
        >
          <Markdown source={draft.statementMd} demoteH1 />
        </section>
      </div>
    </div>
  );
}

export function HintsTab({
  editorKey,
  initial,
  onChange,
  bar,
}: {
  editorKey: string;
  initial: string;
  onChange: (editorialMd: string) => void;
  bar: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-14 text-text-2">
        The editorial is private: only setters and admins see it, and the AI Coach is grounded on
        it. Hint avoid-sets (words a hint must not use, per level) arrive with the AI Coach.
      </p>
      {bar}
      <div className="h-[50vh] min-h-64 overflow-hidden rounded-md border border-border-strong">
        <CodeEditor
          path={`editorial:${editorKey}`}
          initialValue={initial}
          onChange={onChange}
          language="markdown"
          label="Editorial, Markdown editor"
        />
      </div>
    </div>
  );
}
