'use client';
import type { UploadResult } from '@codearena/contracts';
import { FolderUp } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { uploadPackage } from '@/lib/admin';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  MAX_PACKAGE_BYTES,
  draftFromEntries,
  entriesFromDrop,
  entriesFromFileList,
  type PackageDraft,
} from '@/lib/package-folder';

const mb = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * S15 upload: drag a package folder onto the area, or press "Choose folder" (the single-pointer
 * alternative to dragging, WCAG 2.5.7). Shows what will be sent before sending; the server's
 * itemised errors are listed with their file paths.
 */
export function UploadZone({
  fixedSlug,
  onUploaded,
}: {
  /** Uploading a new version of this problem: the folder's own name no longer matters. */
  fixedSlug?: string;
  onUploaded: (r: UploadResult) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const slugId = useId();
  const [draft, setDraft] = useState<PackageDraft | null>(null);
  const [slug, setSlug] = useState(fixedSlug ?? '');
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<UploadResult | null>(null);

  const accept = (d: PackageDraft) => {
    setDraft(d);
    setError(null);
    setDone(null);
    if (!fixedSlug && d.slug) setSlug(d.slug);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    setReading(true);
    try {
      accept(draftFromEntries(await entriesFromDrop(e.dataTransfer.items)));
    } finally {
      setReading(false);
    }
  };

  const tooBig = draft !== null && draft.bytes > MAX_PACKAGE_BYTES;
  const send = async () => {
    if (!draft) return;
    setUploading(true);
    setError(null);
    try {
      const r = await uploadPackage(fixedSlug ?? slug.trim(), draft.files);
      setDone(r);
      setDraft(null);
      onUploaded(r);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setUploading(false);
    }
  };

  return (
    <section aria-label="Upload a package" className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-2 rounded-md border border-dashed border-border-control px-4 py-6 text-center',
          over && 'border-accent bg-surface-2',
        )}
      >
        <FolderUp className="size-5 text-text-3" aria-hidden />
        <p className="text-14 text-text-2">
          {reading ? 'Reading the folder…' : 'Drag a problem package folder here, or'}
        </p>
        <Button
          type="button"
          onClick={() => input.current?.click()}
          disabled={reading || uploading}
        >
          Choose folder
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="folder-input"
          {...({ webkitdirectory: '', directory: '' } as object)}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              accept(draftFromEntries(entriesFromFileList(e.target.files)));
            }
            e.target.value = '';
          }}
        />
      </div>

      <div aria-live="polite" className="flex flex-col gap-2 text-14">
        {draft ? (
          <div className="flex flex-col gap-2" data-testid="upload-summary">
            <p className="text-text">
              {draft.files.length} files, {draft.tests} tests, {mb(draft.bytes)}
              {draft.skipped > 0 ? (
                <span className="text-text-3"> ({draft.skipped} other files will not be sent)</span>
              ) : null}
            </p>
            {draft.missing.length > 0 ? (
              <p className="text-warning">Missing: {draft.missing.join(', ')}.</p>
            ) : null}
            {tooBig ? <p className="text-danger">The package is larger than 100 MB.</p> : null}
            {!fixedSlug ? (
              <Input
                id={slugId}
                label="Problem slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="chai-bill"
                className="w-64 font-mono"
                spellCheck={false}
                autoCapitalize="none"
              />
            ) : null}
            <div>
              <Button
                type="button"
                variant="primary"
                loading={uploading}
                disabled={uploading || tooBig || (!fixedSlug && slug.trim() === '')}
                onClick={send}
              >
                {fixedSlug ? 'Upload as a new version' : 'Upload package'}
              </Button>
            </div>
          </div>
        ) : null}
        {done ? (
          <p role="status" className="text-v-ac">
            {done.outcome === 'unchanged'
              ? `${done.slug}: nothing changed (version ${done.version}).`
              : `${done.slug}: ${done.outcome === 'created' ? 'created' : 'new version'}, version ${done.version} with ${done.testsCount} tests.`}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="flex flex-col gap-1 text-danger">
            <p>{error.message}</p>
            {error.errors && error.errors.length > 0 ? (
              <ul className="list-disc pl-5">
                {error.errors.map((e, i) => (
                  <li key={`${e.path}:${i}`}>
                    <span className="font-mono">{e.path}</span>: {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
