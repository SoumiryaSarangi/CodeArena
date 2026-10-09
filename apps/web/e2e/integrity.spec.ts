import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { stubApi } from './stub-api';

const RUN = '22222222-2222-4222-8222-222222222222';
const CL = '33333333-3333-4333-8333-333333333333';
const S1 = '44444444-4444-4444-8444-444444444441';
const S2 = '44444444-4444-4444-8444-444444444442';
const S3 = '44444444-4444-4444-8444-444444444443';
const CONTEST = '55555555-5555-4555-8555-555555555555';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function detail(decisions: object[] = [], status = 'open') {
  return {
    id: CL,
    runId: RUN,
    contestId: CONTEST,
    problemId: '66666666-6666-4666-8666-666666666666',
    problemSlug: 'chai-bill',
    maxScore: 0.91,
    status,
    members: [
      {
        submissionId: S1,
        handle: 'asha',
        language: 'cpp17',
        verdict: 'AC',
        submittedAt: '2026-10-10T13:40:00Z',
        source: 'int main() { return 0; }\n',
      },
      {
        submissionId: S2,
        handle: 'ben',
        language: 'cpp17',
        verdict: 'AC',
        submittedAt: '2026-10-10T13:50:00Z',
        source: 'int main() { return 0; } // b\n',
      },
      {
        submissionId: S3,
        handle: 'chen',
        language: 'python3',
        verdict: 'WA',
        submittedAt: '2026-10-10T14:00:00Z',
        source: 'print(1)\n',
      },
    ],
    pairs: [
      { subA: S1, subB: S2, fpScore: 0.91, embScore: 0.95, combined: 0.91 },
      { subA: S1, subB: S3, fpScore: 0.5, embScore: 0.6, combined: 0.55 },
    ],
    signals: [
      {
        handle: 'asha',
        pastes: [{ size: 800, at: '2026-10-10T13:41:00Z' }],
        focusLosses: 3,
        openedAt: '2026-10-10T13:35:00Z',
        timeToAcMinutes: 28,
        styleShift: 0.41,
      },
      {
        handle: 'ben',
        pastes: [],
        focusLosses: 0,
        openedAt: null,
        timeToAcMinutes: null,
        styleShift: null,
      },
      {
        handle: 'chen',
        pastes: [],
        focusLosses: 1,
        openedAt: '2026-10-10T13:50:00Z',
        timeToAcMinutes: null,
        styleShift: 0.05,
      },
    ],
    decisions,
  };
}

async function setup(page: Page) {
  await stubApi(page, { role: 'admin' });
  const posts: { decision: string; note: string }[] = [];
  const decisions: object[] = [];
  let status = 'open';
  await page.route(`**/api/admin/plag/runs/${RUN}`, (r) =>
    json(r, {
      id: RUN,
      contestId: CONTEST,
      status: 'done',
      params: {},
      metrics: {},
      startedAt: '2026-10-10T15:00:00Z',
      finishedAt: '2026-10-10T15:05:00Z',
      clusters: [
        {
          id: CL,
          problemId: '66666666-6666-4666-8666-666666666666',
          problemSlug: 'chai-bill',
          size: 3,
          maxScore: 0.91,
          status,
        },
      ],
    }),
  );
  await page.route(`**/api/admin/plag/clusters/${CL}`, (r) => json(r, detail(decisions, status)));
  await page.route(`**/api/admin/plag/clusters/${CL}/decisions`, (r) => {
    const body = r.request().postDataJSON() as { decision: string; note: string };
    posts.push(body);
    status = body.decision;
    decisions.push({
      id: `77777777-7777-4777-8777-77777777777${decisions.length}`,
      decision: body.decision,
      note: body.note,
      reviewer: 'ayush',
      createdAt: '2026-10-10T16:00:00Z',
    });
    return json(r, detail(decisions, status), 201);
  });
  return { posts };
}

test.describe('PL-04: plagiarism review (FR-PLAG-04, FR-PLAG-05)', () => {
  test('FR-PLAG-04: the screen lists the group, its people and pairs, the code side by side, and labels signals advisory', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/admin/integrity/${RUN}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Similar submissions' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /chai-bill/ })).toContainText('Not reviewed');
    await expect(page.getByRole('heading', { name: 'chai-bill: 3 submissions' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '@asha and @ben' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '91%' }).first()).toBeVisible();
    await expect(page.getByText('Advisory only')).toBeVisible();
    const signalRow = page.getByRole('row', { name: /@asha 800 characters/ });
    await expect(signalRow).toContainText('3 times');
    await expect(signalRow).toContainText('28');
    await expect(signalRow).toContainText('very different (0.41)');
    await expect(page.getByRole('row', { name: /@ben none/ })).toContainText(
      'not enough earlier code',
    );
    await expect(page.getByText('never evidence on their own')).toBeVisible();
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 60_000 });
    // picking another pair changes what is compared
    await page
      .getByRole('row', { name: /@asha and @chen/ })
      .getByRole('button', { name: 'Compare' })
      .click();
    await expect(page.getByRole('combobox', { name: 'Right' })).toHaveValue(S3);
    // never an accusation
    await expect(page.locator('#main')).not.toContainText(/cheat/i);
  });

  test('FR-PLAG-05: a decision needs a note; saving shows the decision, the reviewer and the note', async ({
    page,
  }) => {
    const { posts } = await setup(page);
    await page.goto(`/admin/integrity/${RUN}`);
    const confirm = page.getByRole('button', { name: 'Confirm similar' });
    await expect(confirm).toBeDisabled();
    await page.getByLabel('Note for the record (required)').fill('ab');
    await expect(confirm).toBeDisabled();
    await page.getByLabel('Note for the record (required)').fill('Same odd variable names');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole('heading', { name: 'Decision: Confirmed similar' })).toBeVisible();
    expect(posts).toEqual([{ decision: 'confirm', note: 'Same odd variable names' }]);
    await expect(page.getByRole('list', { name: 'Earlier decisions' })).toContainText('@ayush');
    await expect(page.getByRole('list', { name: 'Earlier decisions' })).toContainText(
      'Same odd variable names',
    );
    await expect(page.getByRole('button', { name: /chai-bill/ })).toContainText(
      'Confirmed similar',
    );
    await expect(page.getByLabel('Note for the record (required)')).toHaveValue('');
  });

  test('starting a check from the list opens it', async ({ page }) => {
    await stubApi(page, { role: 'admin' });
    await page.route('**/api/admin/plag/runs', (r) => {
      if (r.request().method() === 'POST') {
        return json(
          r,
          {
            id: RUN,
            contestId: CONTEST,
            status: 'queued',
            params: {},
            metrics: null,
            startedAt: null,
            finishedAt: null,
            clusters: [],
          },
          201,
        );
      }
      return json(r, { items: [] });
    });
    await page.route('**/api/admin/contests', (r) =>
      json(r, {
        serverNow: '2026-10-10T16:00:00Z',
        items: [
          {
            id: CONTEST,
            slug: 'warm-up-1',
            title: 'CodeArena Warm-up #1',
            startsAt: '2026-10-10T13:30:00Z',
            endsAt: '2026-10-10T15:30:00Z',
            freezeAt: null,
            state: 'ended',
            status: 'scheduled',
            registered: false,
            problemCount: 3,
          },
        ],
      }),
    );
    await page.route(`**/api/admin/plag/runs/${RUN}`, (r) =>
      json(r, {
        id: RUN,
        contestId: CONTEST,
        status: 'queued',
        params: {},
        metrics: null,
        startedAt: null,
        finishedAt: null,
        clusters: [],
      }),
    );
    await page.goto('/admin/integrity');
    const start = page.getByRole('button', { name: 'Start check' });
    await expect(start).toBeDisabled();
    await page
      .getByRole('combobox', { name: 'Contest' })
      .selectOption({ label: 'CodeArena Warm-up #1' });
    await start.click();
    await expect(page).toHaveURL(new RegExp(`/admin/integrity/${RUN}$`));
    await expect(page.getByText('The job picks it up within a minute.')).toBeVisible();
  });

  test('accessible, and fits a 390px phone without sideways scrolling', async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/admin/integrity/${RUN}`);
    await expect(page.getByRole('heading', { name: 'chai-bill: 3 submissions' })).toBeVisible();
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 60_000 });
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(wide).toBe(false);
    const results = await new AxeBuilder({ page }).include('#main').analyze();
    expect(results.violations).toEqual([]);
  });
});
