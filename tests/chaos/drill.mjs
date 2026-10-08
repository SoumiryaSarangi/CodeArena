#!/usr/bin/env node
// O-06 failure drills.
//
//   node tests/chaos/drill.mjs local [scenario ...] [--out results.json]
//   node tests/chaos/drill.mjs prod  [scenario ...] [--out results.json]      (see tests/chaos/prod.sh)
//
// Scenarios: kill-worker, freeze-judge, kill-api, restart-redis-graceful, restart-redis-hard, poison.
// Each one judges a real contest of fake users, injects the fault, waits until every accepted submission
// has a verdict and checks the invariants (NFR-REL-01, FR-BOARD-03). Exit status 1 if any drill fails.
import { writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from './scenarios.mjs';

const args = process.argv.slice(2);
const where = args.shift();
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const order = names.length > 0 ? names : Object.keys(SCENARIOS);
if (!['local', 'prod'].includes(where ?? '') || order.some((n) => !SCENARIOS[n])) {
  console.error(
    `usage: drill.mjs <local|prod> [${Object.keys(SCENARIOS).join('|')} ...] [--out FILE]`,
  );
  process.exit(2);
}

const env =
  where === 'local'
    ? await (await import('./env-local.mjs')).localEnv()
    : await (await import('./env-prod.mjs')).prodEnv();
const results = [];
let failed = 0;
const stop = async () => {
  await env.stop?.();
};
process.on('SIGINT', () => stop().finally(() => process.exit(130)));
try {
  console.log(`environment: ${env.name}`);
  await env.start?.();
  for (const name of order) {
    console.log(`\n== ${name}: ${SCENARIOS[name].title}`);
    let r;
    try {
      r = await runScenario(env, name);
    } catch (e) {
      r = {
        scenario: name,
        title: SCENARIOS[name].title,
        environment: env.name,
        pass: false,
        error: String(e.stack ?? e),
        checks: [],
        notes: [],
      };
    }
    results.push(r);
    if (!r.pass) failed++;
    console.log(
      `   ${r.pass ? 'PASS' : 'FAIL'}  detected after ${r.detectSeconds ?? 'no signal'} s, healthy after ${r.healthySeconds ?? '?'} s, all judged after ${r.recoverSeconds ?? '?'} s (${r.tailSeconds ?? '?'} s after the last submit)`,
    );
    if (r.submissions)
      console.log(
        `   submissions: ${r.submissions.accepted} accepted of ${r.submissions.sent}, ${r.submissions.refusedDuringFault} refused during the fault`,
      );
    for (const c of r.checks)
      console.log(`   ${c.ok ? '✓' : '✗'} ${c.name}${c.ok || !c.detail ? '' : `: ${c.detail}`}`);
    for (const n of r.notes ?? []) console.log(`   · ${n}`);
    if (r.error) console.log(`   ! ${r.error.split('\n')[0]}`);
    if (out)
      writeFileSync(
        out,
        JSON.stringify({ at: new Date().toISOString(), environment: env.name, results }, null, 2),
      );
  }
} finally {
  await stop();
}
console.log(`\n${results.length - failed}/${results.length} drills passed`);
process.exit(failed === 0 ? 0 : 1);
