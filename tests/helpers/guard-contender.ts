/**
 * Child-process contender for the task-guard concurrency tests.
 *
 * Runs the real crew/store.ts mutex in a separate OS process so acquisition,
 * reclaim and release are genuinely concurrent against the filesystem (an
 * in-process test is single-threaded and cannot interleave them).
 *
 * Usage (spawned with `node --experimental-strip-types`):
 *   guard-contender.ts race        <cwd> <taskId> <dir>
 *   guard-contender.ts reclaim     <cwd> <taskId> <dir>
 *   guard-contender.ts hold        <cwd> <taskId> <dir> <addDepId>
 *   guard-contender.ts release     <cwd> <watchedTaskId> <dir>
 *
 * Every mode writes `<pid>.ready.json` and waits for a parent `go` file before
 * racing. Tests must wait for both readiness files before releasing `go`;
 * that handshake replaces timing assumptions with explicit barriers.
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

function waitForSuffix(dir: string, suffix: string, timeoutMs = 10000): string {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fs.readdirSync(dir).find(name => name.endsWith(suffix));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for *${suffix} in ${dir}`);
    sleepSync(2);
  }
}

function writeResult(dir: string, suffix: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, `${process.pid}.${suffix}.json`), JSON.stringify(data));
}

function taskPath(cwd: string, taskId: string): string {
  return path.join(cwd, ".pi", "messenger", "crew", "tasks", `${taskId}.json`);
}

const [mode, cwd, taskId, dir, extra] = process.argv.slice(2);
if (!mode || !cwd || !taskId || !dir) {
  throw new Error("usage: guard-contender.ts <race|reclaim|hold|release> <cwd> <taskId> <dir> [extra]");
}
fs.mkdirSync(dir, { recursive: true });
writeResult(dir, "ready", {});

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

  // Observe first, reclaim second: the parent verifies BOTH children saw the
  // same dead marker before either may unlink it.
  const markers = fs.readdirSync(store.getTaskGuardPath(cwd, taskId));
  writeResult(dir, "observed", { markers });
  waitFor(path.join(dir, "release"));

  const reclaimed = store.tryReclaimTaskGuard(cwd, taskId);
  writeResult(dir, "reclaim", { reclaimed });

  if (reclaimed) {
    const guard = store.acquireTaskGuard(cwd, taskId, { timeoutMs: 4000, retryMs: 2 });
    writeResult(dir, "held", { marker: guard.markerName });
    writeResult(dir, "winner", { marker: guard.markerName });
    // Hold the successor until the loser has inspected it.
    waitForSuffix(dir, ".loser-done.json");
    store.releaseTaskGuard(guard);
    writeResult(dir, "released", { marker: guard.markerName });
  } else {
    // No unlink right: wait for the winner's successor, prove its marker is
    // still there, and prove a second reclaim attempt cannot remove it.
    const winnerFile = waitForSuffix(dir, ".winner.json", 3000);
    const winner = JSON.parse(fs.readFileSync(path.join(dir, winnerFile), "utf-8")) as { marker: string };
    const markerPresent = fs.existsSync(path.join(store.getTaskGuardPath(cwd, taskId), winner.marker));
    const reclaimedSuccessor = store.tryReclaimTaskGuard(cwd, taskId);
    writeResult(dir, "successor", { markerPresent, reclaimedSuccessor });
    writeResult(dir, "loser-done", {});
  }
} else if (mode === "hold") {
  // Publish a dependency change while holding the task guard, so a concurrent
  // dependent-list write has to wait and then read the updated list. The
  // parent releases us through a file barrier; no fixed sleep is involved.
  waitFor(path.join(dir, "go"));
  store.mutateTask(cwd, taskId, current => {
    writeResult(dir, "inside", { dependsOn: current.depends_on });
    waitFor(path.join(dir, "release"));
    return { depends_on: [...current.depends_on, extra] };
  });
  writeResult(dir, "done", {});
} else if (mode === "release") {
  // Release the holder as soon as the watched task file disappears: the
  // deleting process unlinks that file before it blocks on the dependent's
  // guard, so this is a filesystem barrier rather than a sleep.
  waitFor(path.join(dir, "go"));
  const deadline = Date.now() + 10000;
  while (fs.existsSync(taskPath(cwd, taskId))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${taskPath(cwd, taskId)} to disappear`);
    sleepSync(2);
  }
  fs.writeFileSync(path.join(dir, "release"), "");
  writeResult(dir, "released", {});
} else {
  throw new Error(`unknown mode ${mode}`);
}
