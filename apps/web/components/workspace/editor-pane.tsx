'use client';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import dynamic from 'next/dynamic';
import type { Language } from '@codearena/contracts';
import { Button, IconButton } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/states';
import { useModLabel } from '@/components/shortcut-sheet';
import { SubmissionWire } from '@/components/submission-wire';
import { VerdictBadge } from '@/components/verdict-badge';
import type { LiveSubmission } from '@/lib/live-submission';
import { LANGUAGES, isLanguage, languageInfo } from '@/lib/languages';

// Monaco loads after the statement has painted (UI_UX §15), with a skeleton of the same size.
const CodeEditor = dynamic(() => import('@/components/code-editor'), {
  ssr: false,
  loading: () => <Skeleton className="size-full min-h-40" />,
});

export const FONT_SIZES = [12, 13, 14, 16, 18, 20];

/** Right side of S05: toolbar over the editor. */
/** One word for the strip; the full queue line (position, judge, tests done) is in the Tests tab. */
const PHASE_WORD: Record<LiveSubmission['phase'], string> = {
  queued: 'In the queue',
  claimed: 'Being judged',
  compiling: 'Compiling',
  running: 'Running the tests',
  done: 'Done',
};

export function EditorPane({
  language,
  onLanguage,
  slug,
  initial,
  resetKey,
  onCode,
  fontSize,
  onFontSize,
  onReset,
  onRun,
  onSubmit,
  running,
  submitting,
  live,
  retryIn,
  hideActions,
  onPaste,
  suggestions = true,
}: {
  language: Language;
  onLanguage: (l: Language) => void;
  slug: string;
  /** What a model for this language starts with (the saved draft or the template). */
  initial: string;
  resetKey: number;
  onCode: (c: string) => void;
  fontSize: number;
  onFontSize: (n: number) => void;
  onReset: () => void;
  onRun: () => void;
  onSubmit: () => void;
  running: boolean;
  submitting: boolean;
  /** The submission being followed (the wire and the strip under the editor show it). */
  live?: LiveSubmission | null;
  retryIn: number;
  /** Narrow screens show Run and Submit in a fixed bar instead (UI_UX S05). */
  hideActions?: boolean;
  /** Contest signals (IN-01): characters pasted into the editor. */
  onPaste?: (chars: number) => void;
  /** Code suggestions (ED-01); a contest may switch them off. */
  suggestions?: boolean;
}) {
  const mod = useModLabel();
  const info = languageInfo(language);
  const i = FONT_SIZES.indexOf(fontSize);
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="Editor"
        className="relative flex flex-wrap items-end gap-2 border-b border-border-strong bg-surface-1 px-3 py-2"
      >
        <Select
          label="Language"
          value={language}
          onChange={(e) => isLanguage(e.target.value) && onLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-1">
          <IconButton
            label="Smaller font"
            disabled={i <= 0}
            onClick={() => onFontSize(FONT_SIZES[i - 1]!)}
          >
            <Minus className="size-4" aria-hidden />
          </IconButton>
          <span
            className="w-8 text-center font-mono text-12 text-text-2"
            aria-label={`Font size ${fontSize}`}
          >
            {fontSize}
          </span>
          <IconButton
            label="Larger font"
            disabled={i >= FONT_SIZES.length - 1}
            onClick={() => onFontSize(FONT_SIZES[i + 1]!)}
          >
            <Plus className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Reset code to the template" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden />
          </IconButton>
        </div>
        <div className={hideActions ? 'hidden' : 'ml-auto flex items-center gap-2'}>
          <Button variant="secondary" onClick={onRun} loading={running}>
            Run <Kbd>{mod} ↵</Kbd>
          </Button>
          <Button variant="primary" onClick={onSubmit} loading={submitting} disabled={retryIn > 0}>
            {retryIn > 0 ? `You can submit again in ${retryIn} s` : 'Submit'}
            {retryIn > 0 ? null : <Kbd>{mod} ⇧ ↵</Kbd>}
          </Button>
        </div>
        {live || submitting ? (
          <SubmissionWire
            live={live}
            submitting={submitting}
            className="absolute inset-x-0 -bottom-px"
          />
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <CodeEditor
          path={`${slug}.${language}`}
          initialValue={initial}
          resetKey={resetKey}
          onChange={onCode}
          language={info.monaco}
          label={`Code editor, ${info.label}`}
          fontSize={fontSize}
          onRun={onRun}
          onSubmit={onSubmit}
          onPaste={onPaste}
          suggestions={suggestions}
        />
      </div>
      {/* The editor's status strip: what is being edited, and the judging of the last submit in one line.
          The Tests tab already announces the same thing, so this one is not read out twice. */}
      <div
        aria-hidden
        className="flex items-center gap-3 border-t border-border bg-surface-1 px-3 py-1.5 text-12 text-text-2"
      >
        <span className="font-mono">{info.label}</span>
        <span className="font-mono">{fontSize} px</span>
        <span className="ml-auto flex items-center gap-2">
          {live?.verdict ? (
            <>
              <VerdictBadge verdict={live.verdict} test={live.failedTest ?? undefined} />
              {live.timeMs != null ? (
                <span className="font-mono tabular-nums">{live.timeMs} ms</span>
              ) : null}
            </>
          ) : live ? (
            <span>{PHASE_WORD[live.phase]}</span>
          ) : submitting ? (
            <span>Submitting…</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
