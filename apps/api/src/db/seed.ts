import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { problemTags, problems, problemVersions, users } from './schema';

const limits = { timeMs: 1000, memMb: 256, outputKb: 64, wallMultiplier: 3 };
const tokens = { kind: 'tokens' } as const;

const SAMPLE_PROBLEMS = [
  {
    slug: 'a-plus-b',
    title: 'A + B',
    difficulty: 800,
    tags: ['math', 'implementation'],
    statement: 'Read two integers `a` and `b` and print `a + b`.',
    samples: [{ input: '1 2\n', output: '3\n' }],
  },
  {
    slug: 'max-of-array',
    title: 'Maximum of an Array',
    difficulty: 900,
    tags: ['implementation'],
    statement: 'Read `n` and then `n` integers. Print the largest one.',
    samples: [{ input: '3\n4 9 2\n', output: '9\n' }],
  },
  {
    slug: 'balanced-brackets',
    title: 'Balanced Brackets',
    difficulty: 1200,
    tags: ['stack', 'strings'],
    statement: 'Given a string of `()[]{}`, print `YES` if it is balanced, otherwise `NO`.',
    samples: [
      { input: '([]{})\n', output: 'YES\n' },
      { input: '(]\n', output: 'NO\n' },
    ],
  },
];

/** Idempotent: safe to run on a database that is already seeded. */
export async function seed(db: Db) {
  await db
    .insert(users)
    .values({ handle: 'admin', name: 'Admin', email: 'admin@codearena.local', role: 'admin' })
    .onConflictDoNothing();
  const [admin] = await db.select().from(users).where(eq(users.handle, 'admin'));
  if (!admin) throw new Error('seed: admin user missing');

  for (const p of SAMPLE_PROBLEMS) {
    const [existing] = await db.select().from(problems).where(eq(problems.slug, p.slug));
    if (existing) continue;
    const [problem] = await db
      .insert(problems)
      .values({
        slug: p.slug,
        title: p.title,
        difficulty: p.difficulty,
        visibility: 'public',
        authorId: admin.id,
        practicePoints: Math.round(p.difficulty / 100),
      })
      .returning();
    const [version] = await db
      .insert(problemVersions)
      .values({
        problemId: problem!.id,
        version: 1,
        statementMd: p.statement,
        limits,
        checker: tokens,
        testsCount: p.samples.length,
        samples: p.samples,
        validationStatus: 'passed',
        createdBy: admin.id,
      })
      .returning();
    await db
      .update(problems)
      .set({ currentVersionId: version!.id })
      .where(eq(problems.id, problem!.id));
    await db.insert(problemTags).values(p.tags.map((tag) => ({ problemId: problem!.id, tag })));
  }
}
