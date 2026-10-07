import type { Page, Route } from '@playwright/test';

/**
 * The setter/admin endpoints (UI-04) for UI tests, on top of `stubApi`. It records what the page
 * sent (upload part names, saved statements, downloads) and lets a test pick how a run unfolds.
 */
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });

export const SOLUTIONS = [
  { name: 'alt.py', language: 'python3', expected: 'AC' },
  { name: 'main.cpp', language: 'cpp17', expected: 'AC' },
  { name: 'tle-bellman.cpp', language: 'cpp17', expected: 'TLE' },
  { name: 'wa-dfs-depth.cpp', language: 'cpp17', expected: 'WA' },
] as const;

const STATEMENT =
  '# Hop Distances\n\nA network of $n$ computers.\n\n## Input\n\nTwo integers.\n\n## Output\n\nOne integer.\n\n## Notes\n\nNothing special.\n';

export interface AdminStub {
  uploads: { parts: string[]; slug: string | null }[];
  saves: { statementMd: string; editorialMd: string }[];
  visibility: string[];
  validates: number;
  polls: number;
  downloads: string[];
  /** The version the stub currently serves (a saved statement makes a new one). */
  version: number;
  validationStatus: 'pending' | 'running' | 'passed' | 'failed';
  visibilityNow: string;
  hasRun: boolean;
}

export async function stubAdmin(
  page: Page,
  opts: { uploadError?: boolean; validatorStored?: boolean; failValidatorTest?: boolean } = {},
): Promise<AdminStub> {
  const st: AdminStub = {
    uploads: [],
    saves: [],
    visibility: [],
    validates: 0,
    polls: 0,
    downloads: [],
    version: 1,
    validationStatus: 'pending',
    visibilityNow: 'private',
    hasRun: false,
  };
  let editorial = 'Breadth-first search.';
  let statement = STATEMENT;
  const vid = () => `v-${st.version}`;
  const lastRun = () =>
    st.hasRun
      ? {
          id: 'run-1',
          status: st.validationStatus === 'running' ? 'running' : 'done',
          ok: st.validationStatus === 'passed',
          createdAt: '2026-10-08T10:00:00.000Z',
        }
      : null;

  const detail = () => ({
    slug: 'hop-distances',
    title: 'Hop Distances',
    difficulty: 1300,
    tags: ['bfs', 'graphs'],
    practicePoints: 13,
    visibility: st.visibilityNow,
    mine: true,
    versions: Array.from({ length: st.version }, (_, i) => ({
      id: `v-${st.version - i}`,
      version: st.version - i,
      createdAt: '2026-10-08T09:00:00.000Z',
      testsCount: 10,
      testsetHash: 'a'.repeat(64),
      validationStatus: i === 0 ? st.validationStatus : 'pending',
      validatedAt: null,
    })),
    current: {
      id: vid(),
      version: st.version,
      statementMd: statement,
      editorialMd: editorial,
      limits: { timeMs: 500, memMb: 256, outputKb: 1024 },
      checker: { kind: 'tokens' },
      samples: 2,
      solutions: SOLUTIONS,
      validatorStored: opts.validatorStored ?? true,
      lastRun: lastRun(),
    },
  });

  await page.route('**/api/admin/problems', (r) =>
    json(r, {
      items: [
        {
          slug: 'hop-distances',
          title: 'Hop Distances',
          difficulty: 1300,
          visibility: st.visibilityNow,
          version: st.version,
          testsCount: 10,
          validationStatus: st.validationStatus,
          updatedAt: '2026-10-08T09:00:00.000Z',
          mine: true,
        },
      ],
    }),
  );
  await page.route('**/api/admin/problems/hop-distances', (r) => json(r, detail()));
  await page.route('**/api/admin/problems/packages', (r) => {
    const body = r.request().postDataBuffer()?.toString('latin1') ?? '';
    const parts = [...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
    const slug = /name="slug"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? null;
    st.uploads.push({ parts, slug });
    if (opts.uploadError) {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/invalid-package',
          title: 'Invalid problem package',
          status: 422,
          detail: 'The package has 2 problem(s)',
          code: 'invalid-package',
          errors: [
            { path: 'validator.cpp', message: 'validator.cpp is missing' },
            { path: 'tests/03.in', message: 'tests/03.in has no matching .ans' },
          ],
        },
        422,
      );
    }
    return json(
      r,
      { outcome: 'created', slug: slug ?? 'x', versionId: 'v-1', version: 1, testsCount: 10 },
      201,
    );
  });
  await page.route('**/api/admin/problems/hop-distances/statement', (r) => {
    const body = r.request().postDataJSON() as { statementMd: string; editorialMd: string };
    st.saves.push(body);
    statement = body.statementMd;
    editorial = body.editorialMd;
    st.version += 1;
    return json(r, {
      outcome: 'new-version',
      slug: 'hop-distances',
      versionId: vid(),
      version: st.version,
      testsCount: 10,
    });
  });
  await page.route('**/api/admin/problems/hop-distances/visibility', (r) => {
    const body = r.request().postDataJSON() as { visibility: string };
    st.visibility.push(body.visibility);
    st.visibilityNow = body.visibility;
    return json(r, { slug: 'hop-distances', visibility: body.visibility });
  });
  await page.route('**/api/admin/problem-versions/*/tests', (r) =>
    json(r, {
      items: Array.from({ length: 4 }, (_, i) => ({
        no: i + 1,
        inBytes: 120 * (i + 1),
        ansBytes: 8 * (i + 1),
        sample: i < 2,
      })),
    }),
  );
  await page.route('**/api/admin/problem-versions/*/tests.tar', (r) => {
    st.downloads.push('tests.tar');
    return r.fulfill({
      status: 200,
      contentType: 'application/x-tar',
      headers: {
        'Content-Disposition': 'attachment; filename="tests.tar"',
        'Cache-Control': 'no-store',
      },
      body: 'TAR',
    });
  });
  await page.route('**/api/admin/problem-versions/*/tests/*', (r) => {
    const file = new URL(r.request().url()).pathname.split('/').at(-1)!;
    st.downloads.push(file);
    return r.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: {
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
      body: '6 5\n',
    });
  });

  const item = (
    kind: 'solution' | 'validator',
    name: string,
    language: string,
    expected: string,
    actual: string | null,
    extra: object = {},
  ) => ({
    kind,
    name,
    language,
    expected,
    status: actual === null ? 'queued' : 'done',
    actual,
    timeMs: actual === null ? null : 12,
    memKb: actual === null ? null : 2048,
    failedTests: [],
    ok: actual === null ? null : actual === expected,
    ...extra,
  });
  const run = (phase: 'start' | 'half' | 'done') => {
    const got = (name: string, expected: string, half: boolean) =>
      phase === 'start' || (phase === 'half' && !half)
        ? null
        : name === 'wa-dfs-depth.cpp'
          ? 'AC'
          : expected;
    const solutions = SOLUTIONS.map((s, i) =>
      item('solution', s.name, s.language, s.expected, got(s.name, s.expected, i < 2)),
    );
    const validator =
      phase !== 'done'
        ? item('validator', 'validator.cpp', 'cpp17', 'AC', null)
        : opts.failValidatorTest
          ? item('validator', 'validator.cpp', 'cpp17', 'AC', 'WA', {
              failedTests: [
                { no: 4, verdict: 'WA', message: 'n = 0 violates the range [1, 50000]' },
              ],
            })
          : item('validator', 'validator.cpp', 'cpp17', 'AC', 'AC');
    const items = [...solutions, validator];
    return {
      id: 'run-1',
      versionId: vid(),
      status: phase === 'done' ? 'done' : 'running',
      createdAt: '2026-10-08T10:00:00.000Z',
      finishedAt: phase === 'done' ? '2026-10-08T10:00:05.000Z' : null,
      ok: phase === 'done' ? items.every((i) => i.ok) : null,
      items,
    };
  };
  await page.route('**/api/admin/problem-versions/*/validate', (r) => {
    st.validates += 1;
    st.polls = 0;
    st.hasRun = true;
    st.validationStatus = 'running';
    return json(r, run('start'), 201);
  });
  await page.route('**/api/admin/validation-runs/*', (r) => {
    st.polls += 1;
    const phase = st.validationStatus !== 'running' ? 'done' : st.polls === 1 ? 'half' : 'done';
    if (phase === 'done') st.validationStatus = run('done').ok ? 'passed' : 'failed';
    return json(r, run(phase));
  });
  return st;
}
