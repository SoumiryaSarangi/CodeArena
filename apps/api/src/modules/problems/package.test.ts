import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePackage, readPackageDirectory, type PackageFiles } from './package';
import { buildTestset } from './testset';

const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const load = (slug: string) => readPackageDirectory(`${root}${slug}`);
const clone = (f: PackageFiles) => new Map(f);
const errorsOf = (slug: string, files: PackageFiles) => {
  const r = parsePackage(slug, files);
  if (r.ok) throw new Error('expected the package to be rejected');
  return r.errors.map((e) => `${e.path}: ${e.message}`);
};
const text = (f: PackageFiles, p: string) => f.get(p)!.toString('utf8');
const put = (f: PackageFiles, p: string, s: string) => f.set(p, Buffer.from(s));

describe('FR-PROB-01: package structure', () => {
  it('all 20 repository packages are accepted', () => {
    const slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(slugs).toHaveLength(20);
    for (const slug of slugs) {
      const r = parsePackage(slug, load(slug));
      expect(r.ok, slug + (r.ok ? '' : ': ' + JSON.stringify(r.errors))).toBe(true);
    }
  });

  it('reads the fields a version needs', () => {
    const r = parsePackage('matching-pair', load('matching-pair'));
    if (!r.ok) throw new Error('rejected');
    expect(r.pkg.checker).toEqual({ kind: 'testlib' });
    expect(r.pkg.checkerSource).toBeDefined();
    expect(r.pkg.samples.length).toBeGreaterThan(0);
    expect(r.pkg.solutions.some((s) => s.expected === 'AC')).toBe(true);
    const f = parsePackage('fractional-loot', load('fractional-loot'));
    if (!f.ok) throw new Error('rejected');
    expect(f.pkg.checker).toEqual({ kind: 'float', eps: 1e-6 });
  });

  it('reports every problem at once, not just the first', () => {
    const f = clone(load('sum-two-numbers'));
    f.delete('editorial.md');
    f.delete('tests/03.ans');
    f.delete('solutions/main.cpp');
    put(f, 'statement.md', '# T\n\n## Input\n\nx\n');
    const errs = errorsOf('sum-two-numbers', f);
    expect(errs.join('\n')).toMatch(/editorial\.md is missing/);
    expect(errs.join('\n')).toMatch(/tests\/03\.in has no matching \.ans/);
    expect(errs.join('\n')).toMatch(/'## Output' section/);
    expect(errs.join('\n')).toMatch(/'## Notes' section/);
    expect(errs.join('\n')).toMatch(/main\.cpp is declared but missing/);
    expect(errs.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a numbering gap, a stray test file and an undeclared solution', () => {
    const f = clone(load('sum-two-numbers'));
    f.set('tests/99.in', Buffer.from('1 2\n'));
    f.set('tests/99.ans', Buffer.from('3\n'));
    f.set('tests/notes.txt', Buffer.from('x'));
    f.set('solutions/extra.py', Buffer.from('print(1)'));
    const errs = errorsOf('sum-two-numbers', f).join('\n');
    expect(errs).toMatch(/numbering has a gap/);
    expect(errs).toMatch(/tests\/notes\.txt is not a regular NN\.in or NN\.ans file/);
    expect(errs).toMatch(/solutions\/extra\.py has no expected verdict/);
  });

  it('rejects bad metadata: rating, points, limits, tags, eps, unknown keys', () => {
    const f = clone(load('sum-two-numbers'));
    put(
      f,
      'problem.yaml',
      text(f, 'problem.yaml')
        .replace('rating: 800', 'rating: 850')
        .replace('practicePoints: 8', 'practicePoints: 3')
        .replace('timeMs: 1000', 'timeMs: 5')
        .replace('tags: [implementation, math]', 'tags: []')
        .replace('checker: {kind: tokens}', 'checker: {kind: tokens, eps: 0.1}') + 'bogus: 1\n',
    );
    const errs = errorsOf('sum-two-numbers', f).join('\n');
    expect(errs).toMatch(/bogus|Unrecognized key/);
    // unknown keys stop the parse; fix that and see the rest
    put(f, 'problem.yaml', text(f, 'problem.yaml').replace('bogus: 1\n', ''));
    const rest = errorsOf('sum-two-numbers', f).join('\n');
    expect(rest).toMatch(/rating must be a multiple of 100/);
    expect(rest).toMatch(/practicePoints must be rating\/100/);
    expect(rest).toMatch(/limits out of range/);
    expect(rest).toMatch(/at least one tag/);
    expect(rest).toMatch(/eps is only for the float checker/);
  });

  it('rejects a bad slug, a missing problem.yaml and invalid YAML', () => {
    expect(errorsOf('Bad_Slug', load('sum-two-numbers')).join()).toMatch(/not a slug/);
    const none = clone(load('sum-two-numbers'));
    none.delete('problem.yaml');
    expect(errorsOf('sum-two-numbers', none).join()).toMatch(/problem\.yaml is missing/);
    const bad = clone(load('sum-two-numbers'));
    put(bad, 'problem.yaml', 'title: [unclosed');
    expect(errorsOf('sum-two-numbers', bad).join()).toMatch(/not valid YAML/);
  });

  it('requires checker.cpp exactly for the testlib checker', () => {
    const f = clone(load('matching-pair'));
    f.delete('checker.cpp');
    expect(errorsOf('matching-pair', f).join()).toMatch(/checker\.cpp is missing/);
    const g = clone(load('sum-two-numbers'));
    g.set('checker.cpp', Buffer.from('int main(){}'));
    expect(errorsOf('sum-two-numbers', g).join()).toMatch(/checker\.cpp exists but/);
  });

  it('FR-PROB-07: raw HTML and script in a statement are refused, maths with < is fine', () => {
    for (const evil of [
      '<script>alert(1)</script>',
      '<IFRAME src="x"></IFRAME>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
    ]) {
      const f = clone(load('sum-two-numbers'));
      put(f, 'statement.md', text(f, 'statement.md') + `\n${evil}\n`);
      expect(errorsOf('sum-two-numbers', f).join(), evil).toMatch(/raw HTML or script/);
    }
    const ok = clone(load('sum-two-numbers'));
    put(
      ok,
      'statement.md',
      text(ok, 'statement.md') + '\nWe need $a<b$ and $1 \\le x \\le 10^9$.\n',
    );
    expect(parsePackage('sum-two-numbers', ok).ok).toBe(true);
  });

  it('rejects tests over 50 MB in total', () => {
    const f = clone(load('sum-two-numbers'));
    f.set('tests/01.in', Buffer.alloc(51 * 1024 * 1024, 49));
    expect(errorsOf('sum-two-numbers', f).join()).toMatch(/over the 50 MB limit/);
  });
});

describe('FR-PROB-03: testset archive', () => {
  // Hashes printed by the Go tool (problempkg.Package.Tar), which the judge verifies against.
  const goHash: Record<string, string> = {
    'sum-two-numbers': '494fc476115c8322f62cf6ed570556cf8d166cfac7db5d2afc1412bcfd33fb9c',
    'matching-pair': 'dc9e386916d50d305008187b7f146863668b95a4127571bd553d3bd32013ef1a',
    'hall-of-fame': '2cd14277e0aeb7e97cfb388182d1459e12d7672512155f53dac3debffb0beeee',
  };
  for (const [slug, want] of Object.entries(goHash)) {
    it(`${slug}: byte-identical to the Go archive (same SHA-256)`, () => {
      const r = parsePackage(slug, load(slug));
      if (!r.ok) throw new Error('rejected');
      expect(buildTestset(r.pkg.tests).hash).toBe(want);
    });
  }

  it('is reproducible and changes when a byte changes', () => {
    const t = [{ no: 1, in: Buffer.from('1\n'), ans: Buffer.from('2\n') }];
    expect(buildTestset(t).hash).toBe(buildTestset(t).hash);
    const t2 = [{ no: 1, in: Buffer.from('1\n'), ans: Buffer.from('3\n') }];
    expect(buildTestset(t2).hash).not.toBe(buildTestset(t).hash);
  });
});
