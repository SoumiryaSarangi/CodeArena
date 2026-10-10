'use client';
import type { Language, ProblemDetail } from '@codearena/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ConnectionPill } from '@/components/connection-pill';
import { useSignals } from '@/lib/signals';
import { useModLabel } from '@/components/shortcut-sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { Kbd } from '@/components/ui/kbd';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, apiGet } from '@/lib/api';
import {
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  loadLanguage,
  saveDraft,
  saveLanguage,
} from '@/lib/drafts';
import { isLanguage, languageInfo } from '@/lib/languages';
import { signInHref, useSession } from '@/lib/session';
import {
  ConsoleTab,
  Drawer,
  DRAWER_TABS,
  SubmissionsTab,
  TestsTab,
  type DrawerTab,
} from './drawer';
import { CoachTab } from './coach';
import { EditorPane } from './editor-pane';
import { StatementPane } from './statement-pane';
import { useJudging } from './use-judging';

/** `true` from 1024 px (UI_UX S05); null before the first client render, so no layout is guessed. */
export function useWide(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(min-width: 1024px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => null,
  );
}

const Separator_ = ({ label, vertical }: { label: string; vertical?: boolean }) => (
  <Separator
    aria-label={label}
    className={
      vertical
        ? 'h-1 bg-border-strong hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-[separator=active]:bg-accent'
        : 'w-1 bg-border-strong hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-[separator=active]:bg-accent'
    }
  />
);

function useProblem(slug: string) {
  const [state, setState] = useState<
    | { s: 'loading' }
    | { s: 'ready'; problem: ProblemDetail }
    | { s: 'missing' }
    | { s: 'error'; err: ApiError }
  >({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setState({ s: 'loading' });
    apiGet<ProblemDetail>(`/problems/${encodeURIComponent(slug)}`, c.signal)
      .then((problem) => setState({ s: 'ready', problem }))
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setState(
          e instanceof ApiError && e.status === 404
            ? { s: 'missing' }
            : { s: 'error', err: e as ApiError },
        );
      });
    return () => c.abort();
  }, [slug, attempt]);
  return { state, retry: () => setAttempt((a) => a + 1) };
}

export function Workspace({ slug }: { slug: string }) {
  const { state, retry } = useProblem(slug);
  const wide = useWide();
  if (state.s === 'loading' || wide === null) {
    return <Skeleton className="h-[calc(100dvh-10rem)] min-h-[32rem] w-full" />;
  }
  if (state.s === 'missing') {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-22 font-semibold">Problem not found</h1>
        <p className="text-14 text-text-2">There is no problem called “{slug}”.</p>
        <Button asChild variant="secondary">
          <Link href="/practice">Back to Practice</Link>
        </Button>
      </div>
    );
  }
  if (state.s === 'error')
    return (
      <ErrorState message={state.err.message} requestId={state.err.requestId} onRetry={retry} />
    );
  return <WorkspaceView problem={state.problem} wide={wide} />;
}

export function WorkspaceView({
  problem,
  wide,
  contest,
  canary,
  onVerdict,
  suggestions = true,
  navHidden = false,
}: {
  problem: ProblemDetail;
  wide: boolean;
  /** The bottom navigation is hidden (a contest in full view), so the action bar sits at the screen's edge. */
  navHidden?: boolean;
  /** Contest mode (S09): submissions go to the contest, drafts are kept per contest problem, no Coach. */
  contest?: { slug: string; label: string };
  /** IN-02: the organisers' hidden instruction for automated assistants (contest problems, when switched on). */
  canary?: string | null;
  onVerdict?: () => void;
  /** ED-01: a contest's rules may switch the editor's suggestions off. Practice always has them. */
  suggestions?: boolean;
}) {
  // Drafts, layout and sign-in return paths are keyed by this, so a contest problem and its
  // practice twin never share code.
  const slug = contest ? `${contest.slug}~${contest.label}` : problem.slug;
  const here = contest ? `/c/${contest.slug}/${contest.label}` : `/p/${problem.slug}`;
  const tabs = contest ? DRAWER_TABS.filter((t) => t.id !== 'coach') : DRAWER_TABS;
  const mod = useModLabel();
  const { session } = useSession();
  const signedIn = session.status === 'authed';
  const hasHandle = session.status === 'authed' && !!session.me.handle;
  // IN-01: in a contest only, for a signed-in contestant (the privacy page says what is reported).
  const onPaste = useSignals(contest, !!contest && signedIn);
  const judging = useJudging({
    slug: problem.slug,
    contest,
    onVerdict,
    testsCount: problem.testsCount,
    samples: problem.samples,
    signedIn,
    hasHandle,
  });

  // Language, code and font size. Drafts are per problem and language, saved 500 ms after typing.
  const [language, setLanguage] = useState<Language>('cpp17');
  const [code, setCode] = useState('');
  // What the editor's model for this language starts with, and a counter that forces a Reset.
  const [initial, setInitial] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const sessionLang = session.status === 'authed' ? session.me.defaultLanguage : null;
  useEffect(() => {
    if (session.status === 'loading' || ready) return;
    const stored = loadLanguage(slug, sessionLang ?? 'cpp17');
    const lang = isLanguage(stored) ? stored : 'cpp17';
    const draft = loadDraft(slug, lang);
    setLanguage(lang);
    setCode(draft);
    setInitial(draft);
    try {
      const f = Number(localStorage.getItem('editor-font-size'));
      if (f >= 12 && f <= 20) setFontSize(f);
    } catch {
      // keep the default
    }
    setReady(true);
  }, [session.status, sessionLang, slug, ready]);

  const codeRef = useRef(code);
  useEffect(() => {
    codeRef.current = code;
    if (!ready) return;
    const t = setTimeout(() => saveDraft(slug, language, code), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [code, language, slug, ready]);

  const changeLanguage = (next: Language) => {
    saveDraft(slug, language, codeRef.current); // don't lose the last half second
    saveLanguage(slug, next);
    const draft = loadDraft(slug, next);
    setLanguage(next);
    setCode(draft);
    setInitial(draft);
  };
  const reset = () => {
    if (!window.confirm('Replace your code with the starting template?')) return;
    clearDraft(slug, language);
    const template = languageInfo(language).template;
    setCode(template);
    setInitial(template);
    setResetKey((k) => k + 1);
  };
  const changeFont = (n: number) => {
    setFontSize(n);
    try {
      localStorage.setItem('editor-font-size', String(n));
    } catch {
      // not worth failing over
    }
  };

  // Drawer tab, and Alt+1..4.
  const [tab, setTab] = useState<DrawerTab>('console');
  const [mobileTab, setMobileTab] = useState<'statement' | 'code' | 'console'>('statement');
  const [input, setInput] = useState('');

  const doSubmit = useCallback(() => {
    setTab('tests');
    setMobileTab('console');
    void judging.submit(language, codeRef.current);
  }, [judging, language]);
  const doRun = useCallback(() => {
    setTab('console');
    setMobileTab('console');
    void judging.run(language, codeRef.current, { input });
  }, [judging, language, input]);
  const runSample = (n: number) => {
    setTab('console');
    setMobileTab('console');
    void judging.run(language, codeRef.current, { sampleIds: [n] });
  };
  const runAllSamples = () =>
    void judging.run(language, codeRef.current, {
      sampleIds: problem.samples.map((_, i) => i + 1),
    });

  // Shortcuts outside the editor (inside it Monaco's own commands fire, so skip those events).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const act = useRef({ doSubmit, doRun });
  useEffect(() => {
    act.current = { doSubmit, doRun };
  }, [doSubmit, doRun]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditor = e.target instanceof Element && e.target.closest('.monaco-editor');
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !inEditor) {
        e.preventDefault();
        if (e.shiftKey) act.current.doSubmit();
        else act.current.doRun();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)) {
        const t = tabsRef.current[Number(e.key) - 1];
        if (!t) return;
        e.preventDefault();
        setTab(t.id);
        setMobileTab('console');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const err = judging.error;
  const banner =
    err?.kind === 'signin' ? (
      <>
        Sign in to run and submit code.{' '}
        <Link className="underline" href={signInHref(here)}>
          Sign in
        </Link>
      </>
    ) : err?.kind === 'handle' ? (
      <>
        Choose a handle before you submit.{' '}
        <Link className="underline" href={`/onboarding?returnTo=${encodeURIComponent(here)}`}>
          Choose a handle
        </Link>
      </>
    ) : err?.kind === 'message' ? (
      err.text
    ) : null;

  // The editor mounts only once the draft is known, so its first text is the right one.
  const editor = !ready ? (
    <Skeleton className="size-full min-h-40" />
  ) : (
    <EditorPane
      language={language}
      onLanguage={changeLanguage}
      slug={slug}
      initial={initial}
      resetKey={resetKey}
      onCode={setCode}
      fontSize={fontSize}
      onFontSize={changeFont}
      onReset={reset}
      onRun={doRun}
      onSubmit={doSubmit}
      running={judging.running}
      submitting={judging.submitting}
      retryIn={judging.retryIn}
      hideActions={!wide}
      onPaste={onPaste}
      suggestions={suggestions}
    />
  );
  const statement = (
    <StatementPane problem={problem} onRunSample={runSample} canRun={signedIn} canary={canary} />
  );
  const drawer = (
    <Drawer value={tab} onValue={setTab} tabs={tabs}>
      {{
        console: (
          <ConsoleTab
            runs={judging.runs}
            input={input}
            onInput={setInput}
            onRunInput={doRun}
            onRunSamples={runAllSamples}
            running={judging.running}
            samplesCount={problem.samples.length}
          />
        ),
        tests: (
          <TestsTab
            live={judging.live}
            submitting={judging.submitting}
            connectionHint={
              judging.connection === 'offline'
                ? 'Offline: results will appear when you reconnect.'
                : undefined
            }
          />
        ),
        submissions: <SubmissionsTab items={judging.history} signedIn={signedIn} />,
        coach: contest ? null : (
          <CoachTab
            slug={problem.slug}
            signedIn={signedIn}
            refreshKey={judging.history?.length ?? -1}
          />
        ),
      }}
    </Drawer>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h1 className="text-22 font-semibold tracking-[-0.01em]">
          {contest ? `${contest.label}. ${problem.title}` : problem.title}
        </h1>
        <ConnectionPill state={judging.connection} />
      </div>
      {banner ? (
        <p
          role="alert"
          className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-13"
        >
          {banner}
        </p>
      ) : null}

      {wide ? (
        <div className="h-[calc(100dvh-12rem)] min-h-[30rem] overflow-hidden rounded-lg border border-border-strong">
          <Group orientation="horizontal" id={`ws-${slug}`}>
            <Panel defaultSize="40%" minSize="25%">
              <div className="size-full overflow-auto">{statement}</div>
            </Panel>
            <Separator_ label="Resize statement and editor" />
            <Panel defaultSize="60%" minSize="30%">
              <Group orientation="vertical">
                <Panel defaultSize="65%" minSize="25%">
                  {editor}
                </Panel>
                <Separator_ label="Resize editor and output" vertical />
                <Panel defaultSize="35%" minSize="15%">
                  {drawer}
                </Panel>
              </Group>
            </Panel>
          </Group>
        </div>
      ) : (
        <>
          <Tabs value={mobileTab} onValueChange={(v) => setMobileTab(v as typeof mobileTab)}>
            <TabsList aria-label="Workspace">
              <TabsTrigger value="statement">Statement</TabsTrigger>
              <TabsTrigger value="code">Code</TabsTrigger>
              <TabsTrigger value="console">Console</TabsTrigger>
            </TabsList>
            <TabsContent value="statement">{statement}</TabsContent>
            <TabsContent value="code">
              <div className="h-[60dvh]">{editor}</div>
            </TabsContent>
            <TabsContent value="console">
              <div className="h-[60dvh]">{drawer}</div>
            </TabsContent>
          </Tabs>
          <div className="h-16" aria-hidden />
          {/* Sits on top of the 56 px bottom navigation (h-14 in rail.tsx). */}
          <div
            className={cn(
              'fixed inset-x-0 z-20 flex',
              navHidden
                ? 'bottom-0 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
                : 'bottom-[calc(3.5rem+env(safe-area-inset-bottom))]',
              'gap-2 border-t border-border-strong bg-surface-1 p-2',
            )}
          >
            <Button
              className="flex-1"
              variant="secondary"
              size="lg"
              onClick={doRun}
              loading={judging.running}
            >
              Run
            </Button>
            <Button
              className="flex-1"
              variant="primary"
              size="lg"
              onClick={doSubmit}
              loading={judging.submitting}
              disabled={judging.retryIn > 0}
            >
              {judging.retryIn > 0 ? `You can submit again in ${judging.retryIn} s` : 'Submit'}
            </Button>
          </div>
        </>
      )}
      <p className="hidden text-12 text-text-3 lg:block">
        <Kbd>{mod} ↵</Kbd> runs · <Kbd>{mod} ⇧ ↵</Kbd> submits · <Kbd>Alt 1–{tabs.length}</Kbd>{' '}
        switches tabs · <Kbd>Ctrl M</Kbd> lets Tab leave the editor
      </p>
    </div>
  );
}
