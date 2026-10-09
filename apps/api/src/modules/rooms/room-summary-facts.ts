/**
 * CP-11 (FR-PAD-16): the facts of a session that the AI summary is written from. Everything here is computed from the
 * database (who typed how much, when, the runs and their verdicts, language changes, restores, silences), so the model is
 * asked to describe and judge data it was given, not to remember or guess. People appear by handle and role only: no
 * e-mail, no id.
 */
export type Role = 'interviewer' | 'candidate' | 'observer';

export interface RunFact {
  at: Date;
  by: string;
  mode: 'run' | 'submit';
  language: string;
  /** The judge's verdict, or null for a plain run without one. */
  verdict: string | null;
  failedTest: number | null;
  /** The code of that run (from its snapshot), or null when none was kept. */
  code: string | null;
}

export interface EventFact {
  at: Date;
  kind: string;
  by: string | null;
  payload: Record<string, unknown> | null;
}

export interface EditStats {
  total: number;
  byUser: { handle: string | null; role: string | null; updates: number }[];
  firstAt: Date | null;
  lastAt: Date | null;
  /** Pauses in the editing of a minute or more, longest first. */
  silences: { startAt: Date; seconds: number }[];
}

export interface SummaryInput {
  room: {
    language: string;
    durationMin: number | null;
    createdAt: Date;
    endedAt: Date;
    problemTitle: string | null;
    problemStatement: string | null;
  };
  members: { handle: string; role: Role }[];
  runs: RunFact[];
  events: EventFact[];
  edits: EditStats;
}

export interface CodeBlock {
  label: string;
  language: string;
  code: string;
}

export interface Facts {
  sessionSeconds: number;
  runs: number;
  submissions: number;
  /** The verdicts in the order they came (plain runs without one are left out). */
  verdicts: string[];
  /** A failing run followed by an accepted one: the fixes. */
  fixes: { fromVerdict: string; at: string }[];
  firstRunAt: string | null;
  languageChanges: number;
  restores: number;
  typingShare: { who: string; percent: number }[];
}

export interface BuiltSummaryInput {
  digest: string;
  codes: CodeBlock[];
  facts: Facts;
}

/** No more than this many code blocks go to the model, each clipped by the prompt. */
export const MAX_CODE_BLOCKS = 4;

/** Characters allowed in a name that goes into a prompt: letters, digits and a few separators, at most 40. */
export const cleanName = (s: string | null | undefined): string =>
  (s ?? 'someone')
    .replace(/[^\p{L}\p{N}_.\- ]/gu, '')
    .trim()
    .slice(0, 40) || 'someone';

/** "mm:ss" from the start of the session (minutes keep counting past 59: the room lasts up to 90). */
export function clock(at: Date, start: Date): string {
  const sec = Math.max(0, Math.round((at.getTime() - start.getTime()) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

/** The failing verdicts that make an accepted one a "fix". */
const isFailing = (v: string | null) => v !== null && v !== 'AC';

export function buildSummaryInput(i: SummaryInput): BuiltSummaryInput {
  const start = i.room.createdAt;
  const t = (d: Date) => clock(d, start);
  const runs = [...i.runs].sort((a, b) => a.at.getTime() - b.at.getTime());
  const sessionSeconds = Math.max(
    0,
    Math.round((i.room.endedAt.getTime() - start.getTime()) / 1000),
  );

  const verdicts = runs.filter((r) => r.verdict !== null).map((r) => r.verdict!);
  const fixes: Facts['fixes'] = [];
  const fixPairs: { before: RunFact; after: RunFact }[] = [];
  let lastJudged: RunFact | null = null;
  for (const r of runs) {
    if (r.verdict === null) continue;
    if (lastJudged && isFailing(lastJudged.verdict) && r.verdict === 'AC') {
      fixes.push({ fromVerdict: lastJudged.verdict!, at: t(r.at) });
      fixPairs.push({ before: lastJudged, after: r });
    }
    lastJudged = r;
  }

  const languageChanges = i.events.filter((e) => e.kind === 'language').length;
  const restores = i.events.filter((e) => e.kind === 'restore').length;
  const totalEdits = i.edits.byUser.reduce((n, u) => n + u.updates, 0);
  const typingShare = [...i.edits.byUser]
    .sort((a, b) => b.updates - a.updates)
    .map((u) => ({
      who: `${cleanName(u.handle)} (${u.role ?? 'unknown'})`,
      percent: pct(u.updates, totalEdits),
    }));

  const facts: Facts = {
    sessionSeconds,
    runs: runs.length,
    submissions: runs.filter((r) => r.mode === 'submit').length,
    verdicts,
    fixes,
    firstRunAt: runs[0] ? t(runs[0].at) : null,
    languageChanges,
    restores,
    typingShare,
  };

  // ---- the code the model sees: the first run, the code before each fix (at most two), the last run
  const codes: CodeBlock[] = [];
  const seen = new Set<string>();
  const add = (label: string, r: RunFact | undefined) => {
    if (!r?.code || seen.has(r.code) || codes.length >= MAX_CODE_BLOCKS) return;
    seen.add(r.code);
    codes.push({ label, language: r.language, code: r.code });
  };
  add(`the first run, at ${runs[0] ? t(runs[0].at) : ''}`, runs[0]);
  for (const f of fixPairs.slice(0, 2))
    add(`before the fix, run at ${t(f.before.at)} (${f.before.verdict})`, f.before);
  const last = runs.at(-1);
  add(`the last run, at ${last ? t(last.at) : ''}`, last);

  // ---- the plain-text digest
  const lines: string[] = [];
  lines.push(
    `SESSION: lasted ${t(i.room.endedAt)}${i.room.durationMin ? ` of a planned ${i.room.durationMin} minutes` : ''}; started in ${i.room.language}.`,
  );
  lines.push(
    `PEOPLE: ${i.members.map((m) => `${cleanName(m.handle)} (${m.role})`).join(', ') || 'none recorded'}.`,
  );
  lines.push(
    `PROBLEM: ${i.room.problemTitle ? cleanName(i.room.problemTitle) : 'no problem was attached (a blank pad)'}.`,
  );
  lines.push(
    i.edits.total === 0
      ? 'EDITING: nobody edited the code.'
      : `EDITING: ${i.edits.total} edits in total. ${typingShare.map((s) => `${s.who} ${s.percent}%`).join(', ')}. First edit at ${i.edits.firstAt ? t(i.edits.firstAt) : '?'}, last at ${i.edits.lastAt ? t(i.edits.lastAt) : '?'}.`,
  );
  if (i.edits.silences.length)
    lines.push(
      `PAUSES in the editing of a minute or more: ${i.edits.silences
        .slice(0, 5)
        .map((s) => `${Math.round(s.seconds)} s from ${t(s.startAt)}`)
        .join('; ')}.`,
    );
  lines.push(
    runs.length === 0
      ? 'RUNS: the code was never run or submitted.'
      : `RUNS (${runs.length}, in order):\n${runs
          .map(
            (r, n) =>
              `  ${n + 1}. ${t(r.at)} ${cleanName(r.by)} ${r.mode === 'submit' ? 'submitted' : 'ran'} ${r.language}: ${
                r.verdict
                  ? `${r.verdict}${r.failedTest ? ` (first failing test ${r.failedTest})` : ''}`
                  : 'no verdict'
              }`,
          )
          .join('\n')}`,
  );
  if (fixes.length)
    lines.push(`FIXES: ${fixes.map((f) => `a ${f.fromVerdict} became AC at ${f.at}`).join('; ')}.`);
  const notable = i.events.filter((e) => ['language', 'restore'].includes(e.kind));
  if (notable.length)
    lines.push(
      `CHANGES: ${notable
        .map((e) =>
          e.kind === 'language'
            ? `language changed to ${String((e.payload as { language?: unknown } | null)?.language ?? '?')} at ${t(e.at)} by ${cleanName(e.by)}`
            : `an earlier version was restored at ${t(e.at)} by ${cleanName(e.by)}`,
        )
        .join('; ')}.`,
    );
  const joins = i.events.filter((e) => e.kind === 'join' || e.kind === 'leave');
  if (joins.length)
    lines.push(
      `PRESENCE: ${joins.map((e) => `${cleanName(e.by)} ${e.kind === 'join' ? 'joined' : 'left'} at ${t(e.at)}`).join('; ')}.`,
    );

  return { digest: lines.join('\n'), codes, facts };
}
