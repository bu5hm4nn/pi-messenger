/**
 * Child-process contender for the task-guard concurrency tests.
 *
 * Runs the real crew/store.ts mutex in a separate OS process so acquisition,
 * reclaim and release are genuinely concurrent against the filesystem (an
 * in-process test is single-threaded and cannot interleave them).
 *
 * Usage (spawned with `node --experimental-strip-types`):
 *   guard-contender.ts race    <cwd> <taskId> <dir>
 *   guard-contender.ts reclaim <cwd> <taskId> <dir>
 *   guard-contender.ts hold    <cwd> <taskId> <dir> <addDepId>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as store from "../../crew/store.ts";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(filePath: string, timeoutMs = 10000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
    sleepSync(2);
  }
}

function writeResult(dir: string, suffix: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, `${process.pid}.${suffix}.json`), JSON.stringify(data));
}

const [mode, cwd, taskId, dir, extra] = process.argv.slice(2);
if (!mode || !cwd || !taskId || !dir) {
  throw new Error("usage: guard-contender.ts <race|reclaim|hold> <cwd> <taskId> <dir> [extra]");
}
fs.mkdirSync(dir, { recursive: true });

if (mode === "race") {
  // Both contenders wait for the parent's barrier, then race for the guard.
  waitFor(path.join(dir, "go"));
  try {
    const guard = store.acquireTaskGuard(cwd, taskId, { timeoutMs: 700, retryMs: 2 });
    writeResult(dir, "held", { marker: guard.markerName });
    // Hold long enough that the loser hits its bounded deadline.
    sleepSync(1800);
    store.releaseTaskGuard(guard);
    writeResult(dir, "released", { marker: guard.markerName });
  } catch (err) {
    writeResult(dir, "timeout", { message: err instanceof Error ? err.message : String(err) });
  }
} else if (mode === "reclaim") {
  waitFor(path.join(dir, "go"));
  const reclaimed = store.tryReclaimTaskGuard(cwd, taskId);
  writeResult(dir, "reclaim", { reclaimed });
  const guard = store.acquireTaskGuard(cwd, taskId, { timeoutMs: 4000, retryMs: 2 });
  writeResult(dir, "held", { marker: guard.markerName });
  sleepSync(150);
  store.releaseTaskGuard(guard);
  writeResult(dir, "released", { marker: guard.markerName });
} else if (mode === "hold") {
  // Publish a dependency change while holding the task guard, so a concurrent
  // dependent-list write has to wait and then read the updated list.
  store.mutateTask(cwd, taskId, current => {
    writeResult(dir, "inside", { dependsOn: current.depends_on });
    sleepSync(600);
    return { depends_on: [...current.depends_on, extra] };
  });
  writeResult(dir, "done", {});
} else {
  throw new Error(`unknown mode ${mode}`);
}
