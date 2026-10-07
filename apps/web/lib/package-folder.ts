/**
 * Turns what a person drops or picks (a package folder) into what the upload endpoint takes: the
 * package's own files with their package-relative paths. Pure and DOM-light so it can be tested.
 * The server is the authority on what a valid package is; this only keeps the upload small and
 * tells the person early when the folder is plainly not a package.
 */

/** The files the API reads (everything else a folder holds, such as generators, stays behind). */
export const PACKAGE_PATH =
  /^(problem\.yaml|statement\.md|editorial\.md|validator\.cpp|checker\.cpp|tests\/[^/]+|solutions\/[^/]+)$/;
const REQUIRED = ['problem.yaml', 'statement.md', 'editorial.md', 'validator.cpp'] as const;
export const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

export interface PackageFile {
  /** Relative path, forward slashes; may start with the dropped folder's name. */
  path: string;
  file: File;
}

export interface PackageDraft {
  /** The folder's name when one was dropped or picked (the problem's slug); null for loose files. */
  slug: string | null;
  files: PackageFile[];
  bytes: number;
  tests: number;
  /** Files in the folder that are not part of a package and will not be sent. */
  skipped: number;
  /** Required files that are not there (the server checks again and lists every problem). */
  missing: string[];
}

export function draftFromEntries(entries: PackageFile[]): PackageDraft {
  const paths = entries.map((e) => e.path.replace(/\\/g, '/').replace(/^\.?\//, ''));
  // A dropped folder arrives as `<name>/problem.yaml`, `<name>/tests/01.in`, ...
  const top = paths[0]?.split('/')[0];
  const wrapped =
    paths.length > 0 &&
    paths.every((p) => p.split('/').length > 1 && p.split('/')[0] === top) &&
    paths.includes(`${top}/problem.yaml`);
  const files: PackageFile[] = [];
  let skipped = 0;
  let bytes = 0;
  entries.forEach((e, i) => {
    const path = wrapped ? paths[i]!.slice(top!.length + 1) : paths[i]!;
    if (!PACKAGE_PATH.test(path)) {
      skipped++;
      return;
    }
    bytes += e.file.size;
    files.push({ path, file: e.file });
  });
  const have = new Set(files.map((f) => f.path));
  return {
    slug: wrapped ? top! : null,
    files,
    bytes,
    tests: files.filter((f) => f.path.startsWith('tests/') && f.path.endsWith('.in')).length,
    skipped,
    missing: REQUIRED.filter((r) => !have.has(r)),
  };
}

/** `<input type=file webkitdirectory>`: every file knows its path inside the picked folder. */
export function entriesFromFileList(list: FileList | File[]): PackageFile[] {
  return Array.from(list).map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
}

const readFile = (e: FileSystemFileEntry) => new Promise<File>((ok, no) => e.file(ok, no));

async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // A reader hands out entries in batches; an empty batch means the end.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, prefix: string, out: PackageFile[]): Promise<void> {
  if (entry.isFile) {
    out.push({
      path: `${prefix}${entry.name}`,
      file: await readFile(entry as FileSystemFileEntry),
    });
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry as FileSystemDirectoryEntry)) {
      await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** A drop: walks every dropped folder (or file) and returns the files with their paths. */
export async function entriesFromDrop(items: DataTransferItemList): Promise<PackageFile[]> {
  // The entries must be taken synchronously: the list is emptied once the event handler returns.
  const roots = Array.from(items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  const out: PackageFile[] = [];
  for (const root of roots) await walk(root, '', out);
  return out;
}

/** The multipart body: a `slug` part, then one part per file named by its package-relative path. */
export function buildForm(slug: string, files: PackageFile[]): FormData {
  const form = new FormData();
  form.append('slug', slug);
  for (const f of files) form.append(f.path, f.file, f.path.split('/').pop());
  return form;
}
