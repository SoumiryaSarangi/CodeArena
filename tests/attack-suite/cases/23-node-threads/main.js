// Attack case 23: Node worker flood.
// Spawns many worker threads that sit parked. The process limit (16 for
// Node) must stop creation: workers fail to start and we report BLOCKED, or
// the box kills the process. All of them starting is a failure.
const { Worker } = require('worker_threads');

const WANTED = 100;
const parked = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);';
let failed = 0;
let created = 0;

for (let i = 0; i < WANTED; i++) {
  try {
    const w = new Worker(parked, { eval: true });
    w.on('error', () => {
      failed++;
    });
    created++;
  } catch (e) {
    failed++;
  }
}

setTimeout(() => {
  if (failed > 0) {
    console.log(`BLOCKED ${failed} of ${WANTED} workers failed to start`);
  } else {
    console.log(`ESCAPED started ${created} workers`);
  }
  process.exit(0);
}, 800);
