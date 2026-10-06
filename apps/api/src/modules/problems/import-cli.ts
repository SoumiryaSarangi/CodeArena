/**
 * `pnpm problem:import [--publish] <dir>...`: imports problem packages (SRS §3.1.6).
 * A directory with a problem.yaml is one package; otherwise each subdirectory that has one is.
 * Reads DATABASE_URL and S3_* from the environment (dev defaults match docker-compose.yml).
 * Run `pnpm problems:validate` first: this checks structure, the judge checks the solutions.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../../config/config';
import { connect } from '../../db/client';
import { PackageReadError, parsePackage, readPackageDirectory, slugOf } from './package';
import { ProblemImporter } from './problems.import';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length === 0) {
  console.error('usage: pnpm problem:import [--publish] <package-dir | dir-of-packages>...');
  process.exit(2);
}

// pnpm runs this from apps/api; relative paths mean relative to where the command was typed.
const base = process.env.INIT_CWD ?? process.cwd();
const packages = dirs.flatMap((d) => {
  const dir = resolve(base, d);
  if (!existsSync(dir)) {
    console.error(`${dir} does not exist`);
    process.exit(2);
  }
  if (existsSync(join(dir, 'problem.yaml'))) return [dir];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'problem.yaml')));
});
if (packages.length === 0) {
  console.error('no problem packages found');
  process.exit(2);
}

const config = loadConfig({ ...process.env, NODE_ENV: 'development' });
const { pool, db } = connect(config.DATABASE_URL);
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const importer = new ProblemImporter(db, s3, config);

let failed = 0;
for (const dir of packages) {
  const slug = slugOf(dir);
  try {
    const parsed = parsePackage(slug, readPackageDirectory(dir));
    if (!parsed.ok) {
      failed++;
      console.error(`✗ ${slug}: invalid package`);
      for (const e of parsed.errors) console.error(`    ${e.path}: ${e.message}`);
      continue;
    }
    const r = await importer.import(parsed.pkg, publish ? { visibility: 'public' } : {});
    console.log(
      `✓ ${slug}: ${r.outcome} (version ${r.version}, ${r.testsCount} tests, ${r.testsetHash.slice(0, 12)})`,
    );
  } catch (err) {
    failed++;
    console.error(
      `✗ ${slug}: ${err instanceof PackageReadError ? err.problems.join('; ') : (err as Error).message}`,
    );
  }
}
s3.destroy();
await pool.end();
process.exit(failed > 0 ? 1 : 0);
