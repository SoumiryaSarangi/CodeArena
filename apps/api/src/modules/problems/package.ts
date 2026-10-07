import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { Verdict } from '@codearena/contracts';
import { parse } from 'yaml';
import { z } from 'zod';

/** SRS §3.1.6 limits. */
export const MAX_TESTS_BYTES = 50 * 1024 * 1024;
export const MAX_TESTS = 99;
/** A whole package, before it is even parsed (SRS: package ≤ 100 MB). */
export const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TEST_FILE = /^tests\/([0-9]{2})\.(in|ans)$/;
const SECTION = /^## (Input|Output|Notes)\s*$/gm;
const SOLUTION_LANGUAGE: Record<string, string> = {
  '.c': 'c',
  '.cpp': 'cpp17',
  '.py': 'python3',
  '.java': 'java21',
  '.js': 'node',
};
/** FR-PROB-07: the web renders Markdown with a sanitiser; these are refused at import as well. */
const UNSAFE_HTML =
  /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|base|form|svg)\b|\son[a-z]+\s*=|javascript\s*:/i;

const Meta = z
  .object({
    title: z.string(),
    rating: z.number().int(),
    practicePoints: z.number().int(),
    tags: z.array(z.string()),
    limits: z.object({ timeMs: z.number(), memMb: z.number(), outputKb: z.number() }).strict(),
    checker: z
      .object({ kind: z.enum(['exact', 'tokens', 'float', 'testlib']), eps: z.number().optional() })
      .strict(),
    samples: z.array(z.string()),
    avoidSet: z.record(z.string(), z.array(z.string())).default({}),
    generator: z.string().optional(),
    solutions: z.array(z.object({ file: z.string(), expected: z.string() }).strict()),
  })
  .strict();

export interface PackageSolution {
  name: string;
  language: string;
  expected: Verdict;
  source: Buffer;
}

export interface ProblemPackage {
  slug: string;
  title: string;
  rating: number;
  practicePoints: number;
  tags: string[];
  limits: { timeMs: number; memMb: number; outputKb: number };
  checker: { kind: 'exact' | 'tokens' | 'float' | 'testlib'; eps?: number };
  samples: { in: string; out: string }[];
  avoidSet: Record<string, string[]>;
  statementMd: string;
  editorialMd: string;
  checkerSource?: Buffer;
  validatorSource: Buffer;
  solutions: PackageSolution[];
  tests: { no: number; in: Buffer; ans: Buffer }[];
}

export type PackageFiles = Map<string, Buffer>;

/**
 * The rules for a statement (FR-PROB-01, FR-PROB-07), shared by the package check and the
 * statement editor: a title heading, the Input / Output / Notes sections, no raw HTML or script.
 */
export function checkStatement(statementMd: string): string[] {
  const out: string[] = [];
  if (!statementMd.trim().startsWith('# '))
    out.push("statement.md must start with a '# Title' heading");
  const found = new Set([...statementMd.matchAll(SECTION)].map((m) => m[1]));
  for (const s of ['Input', 'Output', 'Notes'])
    if (!found.has(s)) out.push(`statement.md has no '## ${s}' section`);
  if (UNSAFE_HTML.test(statementMd))
    out.push('statement contains raw HTML or script (only Markdown and KaTeX are allowed)');
  return out;
}

export class PackageReadError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

/** Files of a package directory, keyed by forward-slash relative path. Only regular files are taken. */
export function readPackageDirectory(dir: string): PackageFiles {
  const root = resolve(dir);
  const files: PackageFiles = new Map();
  const odd: string[] = [];
  let total = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        total += st.size;
        if (total > MAX_PACKAGE_BYTES) throw new Error('package is larger than 100 MB');
        files.set(path, readFileSync(join(root, path)));
      } else odd.push(path);
    }
  };
  walk('');
  if (odd.length > 0)
    throw new PackageReadError(odd.map((p) => `${p} is not a regular file or directory`));
  return files;
}

/**
 * Checks a package and returns every problem at once (FR-PROB-01), or the parsed package.
 * `slug` is the package directory name. Running the solutions and the validator is the
 * judge's job (`scripts/validate-problem`, FR-PROB-04); this is the structural half.
 */
export function parsePackage(
  slug: string,
  files: PackageFiles,
): { ok: true; pkg: ProblemPackage } | { ok: false; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const text = (path: string) => files.get(path)?.toString('utf8');

  if (!SLUG.test(slug)) err('slug', `${slug} is not a slug (lowercase words joined by '-')`);

  const rawMeta = text('problem.yaml');
  if (rawMeta === undefined) {
    err('problem.yaml', 'problem.yaml is missing');
    return { ok: false, errors };
  }
  let meta: z.infer<typeof Meta>;
  try {
    const parsed = Meta.safeParse(parse(rawMeta));
    if (!parsed.success) {
      for (const i of parsed.error.issues) err(`problem.yaml:${i.path.join('.')}`, i.message);
      return { ok: false, errors };
    }
    meta = parsed.data;
  } catch (e) {
    err('problem.yaml', `not valid YAML: ${(e as Error).message}`);
    return { ok: false, errors };
  }

  if (meta.title.trim() === '' || meta.title.length > 100)
    err('problem.yaml:title', 'title must be 1-100 characters');
  if (meta.rating < 800 || meta.rating > 3500 || meta.rating % 100 !== 0)
    err(
      'problem.yaml:rating',
      `rating must be a multiple of 100 between 800 and 3500, got ${meta.rating}`,
    );
  if (meta.practicePoints !== Math.floor(meta.rating / 100))
    err(
      'problem.yaml:practicePoints',
      `practicePoints must be rating/100: want ${Math.floor(meta.rating / 100)}, got ${meta.practicePoints}`,
    );
  if (meta.tags.length === 0) err('problem.yaml:tags', 'at least one tag is required');
  if (new Set(meta.tags).size !== meta.tags.length) err('problem.yaml:tags', 'tags must be unique');
  for (const t of meta.tags)
    if (!/^[a-z0-9][a-z0-9 +.-]{0,29}$/.test(t))
      err(
        'problem.yaml:tags',
        `tag ${JSON.stringify(t)} is not 1-30 lowercase letters, digits, spaces, '+', '.' or '-'`,
      );
  const l = meta.limits;
  if (
    l.timeMs < 100 ||
    l.timeMs > 10000 ||
    l.memMb < 16 ||
    l.memMb > 1024 ||
    l.outputKb < 1 ||
    l.outputKb > 65536
  )
    err(
      'problem.yaml:limits',
      'limits out of range (timeMs 100-10000, memMb 16-1024, outputKb 1-65536)',
    );
  if (meta.checker.kind === 'float') {
    if (!(meta.checker.eps !== undefined && meta.checker.eps > 0))
      err('problem.yaml:checker', 'the float checker needs a positive eps');
  } else if (meta.checker.eps !== undefined)
    err('problem.yaml:checker', 'eps is only for the float checker');
  for (const lvl of Object.keys(meta.avoidSet))
    if (lvl !== '1' && lvl !== '2')
      err('problem.yaml:avoidSet', `avoidSet has level ${lvl}; only 1 and 2 exist`);

  for (const f of ['statement.md', 'editorial.md', 'validator.cpp'])
    if (!files.has(f)) err(f, `${f} is missing`);
  const statementMd = text('statement.md') ?? '';
  if (files.has('statement.md'))
    for (const m of checkStatement(statementMd)) err('statement.md', m);
  if (meta.checker.kind === 'testlib' && !files.has('checker.cpp'))
    err('checker.cpp', 'checker kind is testlib but checker.cpp is missing');
  if (meta.checker.kind !== 'testlib' && files.has('checker.cpp'))
    err('checker.cpp', `checker.cpp exists but the checker kind is ${meta.checker.kind}`);

  // Tests: NN.in / NN.ans, no gaps, ≤ 99, ≤ 50 MB.
  const ins = new Map<number, Buffer>();
  const anss = new Map<number, Buffer>();
  let testBytes = 0;
  for (const [path, body] of files) {
    if (!path.startsWith('tests/')) continue;
    const m = TEST_FILE.exec(path);
    if (!m) {
      err(path, `${path} is not a regular NN.in or NN.ans file`);
      continue;
    }
    testBytes += body.length;
    (m[2] === 'in' ? ins : anss).set(Number(m[1]), body);
  }
  if (testBytes > MAX_TESTS_BYTES)
    err('tests', `tests are ${testBytes} bytes, over the 50 MB limit`);
  const nos = [...ins.keys()].sort((a, b) => a - b);
  if (nos.length === 0) err('tests', 'tests/ has no tests');
  if (nos.length > MAX_TESTS) err('tests', `more than ${MAX_TESTS} tests`);
  const tests: ProblemPackage['tests'] = [];
  for (const [i, n] of nos.entries()) {
    if (n !== i + 1) {
      err('tests', `test numbering has a gap: expected ${pad(i + 1)}, found ${pad(n)}`);
      break;
    }
    const ans = anss.get(n);
    if (!ans) err(`tests/${pad(n)}.in`, `tests/${pad(n)}.in has no matching .ans`);
    else tests.push({ no: n, in: ins.get(n)!, ans });
  }
  for (const n of anss.keys())
    if (!ins.has(n)) err(`tests/${pad(n)}.ans`, `tests/${pad(n)}.ans has no matching .in`);

  // Samples are the first tests, in order.
  const samples: ProblemPackage['samples'] = [];
  if (meta.samples.length === 0) err('problem.yaml:samples', 'at least one sample is required');
  meta.samples.forEach((s, i) => {
    if (s !== pad(i + 1))
      err(
        'problem.yaml:samples',
        `samples must be the first tests in order (01, 02, ...); sample ${i + 1} is ${JSON.stringify(s)}`,
      );
  });
  if (meta.samples.length > tests.length)
    err('problem.yaml:samples', 'samples lists more tests than exist');
  for (const t of tests.slice(0, meta.samples.length))
    samples.push({ in: t.in.toString('utf8'), out: t.ans.toString('utf8') });

  // Solutions: each declared with an expected verdict, at least one AC, none undeclared.
  const solutions: PackageSolution[] = [];
  const declared = new Set<string>();
  let hasAC = false;
  for (const s of meta.solutions) {
    const where = `solutions/${s.file}`;
    if (s.file === '' || /[/\\]/.test(s.file) || s.file === '.' || s.file === '..') {
      err(
        'problem.yaml:solutions',
        `solution ${JSON.stringify(s.file)}: file must be a plain name inside solutions/`,
      );
      continue;
    }
    const verdict = Verdict.safeParse(s.expected);
    if (!verdict.success || !['AC', 'WA', 'TLE', 'MLE', 'RE', 'OLE', 'CE'].includes(s.expected)) {
      err(
        where,
        `solution ${s.file}: expected verdict ${JSON.stringify(s.expected)} is not one of AC WA TLE MLE RE OLE CE`,
      );
      continue;
    }
    if (declared.has(s.file)) {
      err(where, `solution ${s.file} is declared twice`);
      continue;
    }
    declared.add(s.file);
    const language = SOLUTION_LANGUAGE[extname(s.file).toLowerCase()];
    if (!language) err(where, `solution ${s.file}: unknown language extension`);
    const source = files.get(where);
    if (!source) err(where, `solution ${s.file} is declared but missing`);
    if (language && source)
      solutions.push({ name: s.file, language, expected: verdict.data, source });
    hasAC ||= s.expected === 'AC';
  }
  if (!hasAC) err('problem.yaml:solutions', 'solutions: at least one must be expected AC');
  for (const path of files.keys())
    if (path.startsWith('solutions/') && !declared.has(path.slice('solutions/'.length)))
      err(path, `${path} has no expected verdict in problem.yaml`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    pkg: {
      slug,
      title: meta.title.trim(),
      rating: meta.rating,
      practicePoints: meta.practicePoints,
      tags: meta.tags,
      limits: meta.limits,
      checker:
        meta.checker.kind === 'float'
          ? { kind: 'float', eps: meta.checker.eps! }
          : { kind: meta.checker.kind },
      samples,
      avoidSet: meta.avoidSet,
      statementMd,
      editorialMd: text('editorial.md')!,
      checkerSource: files.get('checker.cpp'),
      validatorSource: files.get('validator.cpp')!,
      solutions,
      tests,
    },
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const slugOf = (dir: string) => basename(resolve(dir));
