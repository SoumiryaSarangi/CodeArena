/* global process, console */
// Monaco is served from our own origin (/monaco/vs), not a CDN: it works offline, under a strict
// Content-Security-Policy, and needs no worker bundling inside Next. This copies the package's
// prebuilt `min/vs` into public/ (gitignored) whenever the installed version changes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The package's `exports` hide package.json from require.resolve, so go by the path pnpm links.
const pkgDir = join(root, 'node_modules', 'monaco-editor');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const from = join(pkgDir, 'min', 'vs');
const to = join(root, 'public', 'monaco', 'vs');
const stamp = join(root, 'public', 'monaco', '.version');

if (
  existsSync(stamp) &&
  readFileSync(stamp, 'utf8') === version &&
  existsSync(join(to, 'loader.js'))
) {
  process.exit(0);
}
rmSync(join(root, 'public', 'monaco'), { recursive: true, force: true });
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
writeFileSync(stamp, version);
console.log(`monaco-editor ${version} copied to public/monaco/vs`);
