import { describe, expect, it } from 'vitest';
import {
  buildForm,
  draftFromEntries,
  entriesFromDrop,
  entriesFromFileList,
  type PackageFile,
} from '@/lib/package-folder';

const f = (path: string, size = 10): PackageFile => ({
  path,
  file: new File([new Uint8Array(size)], path.split('/').pop()!),
});
const PACKAGE = [
  'problem.yaml',
  'statement.md',
  'editorial.md',
  'validator.cpp',
  'tests/01.in',
  'tests/01.ans',
  'tests/02.in',
  'tests/02.ans',
  'solutions/main.cpp',
  'generators/gen.py',
  'stress/brute.cpp',
];

describe('UI-04: a dropped package folder becomes the upload (FR-PROB-01)', () => {
  it('uses the folder name as the slug and strips it from every path', () => {
    const d = draftFromEntries(PACKAGE.map((p) => f(`chai-bill/${p}`)));
    expect(d.slug).toBe('chai-bill');
    expect(d.files.map((x) => x.path)).toContain('tests/01.in');
    expect(d.files.every((x) => !x.path.startsWith('chai-bill/'))).toBe(true);
  });

  it('keeps only the files a package is made of and counts what it left behind', () => {
    const d = draftFromEntries(PACKAGE.map((p) => f(`x/${p}`)));
    expect(d.files).toHaveLength(9);
    expect(d.skipped).toBe(2); // generators/, stress/
    expect(d.tests).toBe(2);
    expect(d.missing).toEqual([]);
    expect(d.bytes).toBe(90);
  });

  it('reports the required files that are missing', () => {
    const d = draftFromEntries(
      PACKAGE.filter((p) => p !== 'validator.cpp' && p !== 'editorial.md').map((p) => f(`x/${p}`)),
    );
    expect(d.missing).toEqual(['editorial.md', 'validator.cpp']);
  });

  it('loose files (no folder) have no slug: the person types it', () => {
    const d = draftFromEntries(PACKAGE.map((p) => f(p)));
    expect(d.slug).toBeNull();
    expect(d.files).toHaveLength(9);
  });

  it('a folder without a problem.yaml at its top is not treated as the package folder', () => {
    const d = draftFromEntries([f('outer/inner/problem.yaml'), f('outer/inner/statement.md')]);
    expect(d.slug).toBeNull();
    expect(d.files).toHaveLength(0);
    expect(d.skipped).toBe(2);
  });

  it('reads the paths of a picked folder from webkitRelativePath', () => {
    const file = new File(['x'], 'problem.yaml');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'chai-bill/problem.yaml' });
    expect(entriesFromFileList([file])).toEqual([{ path: 'chai-bill/problem.yaml', file }]);
    expect(entriesFromFileList([new File(['x'], 'a.txt')])[0]!.path).toBe('a.txt');
  });

  it('walks a dropped folder, including readers that hand out entries in batches', async () => {
    const file = (name: string): FileSystemFileEntry =>
      ({
        isFile: true,
        isDirectory: false,
        name,
        file: (ok: (f: File) => void) => ok(new File(['x'], name)),
      }) as unknown as FileSystemFileEntry;
    const dir = (name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry => {
      let i = 0;
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => ({
          readEntries: (ok: (e: FileSystemEntry[]) => void) => ok(batches[i++] ?? []),
        }),
      } as unknown as FileSystemDirectoryEntry;
    };
    const root = dir('pkg', [
      [file('problem.yaml'), dir('tests', [[file('01.in')], [file('01.ans')]])],
      [file('statement.md')],
    ]);
    const items = [
      { kind: 'file', webkitGetAsEntry: () => root },
    ] as unknown as DataTransferItemList;
    const out = await entriesFromDrop(items);
    expect(out.map((e) => e.path).sort()).toEqual([
      'pkg/problem.yaml',
      'pkg/statement.md',
      'pkg/tests/01.ans',
      'pkg/tests/01.in',
    ]);
  });

  it('builds a multipart body with a slug part and one part per file named by its path', () => {
    const form = buildForm('chai-bill', [f('problem.yaml'), f('tests/01.in')]);
    expect(form.get('slug')).toBe('chai-bill');
    expect((form.get('tests/01.in') as File).name).toBe('01.in');
    expect([...form.keys()]).toEqual(['slug', 'problem.yaml', 'tests/01.in']);
  });
});
