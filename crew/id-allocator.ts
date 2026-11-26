/**
 * Crew - ID Allocator
 *
 * Simple task ID allocation: task-1, task-2, ...
 *
 * Allocation is monotonic across deletions. A persisted max-ever counter is
 * chosen over carrying a task-instance identity in the generation
 * precondition: it is smaller, keeps the existing generation semantics, and
 * directly prevents a deleted highest ID from returning with generation 0.
 * The counter lives in tasks/.task-seq (hidden, so task scans and deletePlan
 * never treat it as a task) and is read + advanced by the caller while holding
 * the allocation guard.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SEQ_FILE = ".task-seq";

/** Strict canonical counter: missing, unreadable or malformed means no value. */
function readCounter(counterPath: string): number | null {
  try {
    const text = fs.readFileSync(counterPath, "utf-8").trim();
    if (!/^[1-9][0-9]*$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Highest task id visible in any task artifact, not just task JSON. A deleted
 * task can leave its spec/progress/block/lock artifacts behind; reusing that
 * id would resurrect an old instance identity.
 */
function scanTaskFloor(tasksDir: string): number {
  let maxN = 0;
  const scan = (dir: string): void => {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const match = entry.match(/^task-([1-9][0-9]*)(?:\.|$)/);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n > maxN) maxN = n;
    }
  };
  scan(tasksDir);
  scan(path.join(path.dirname(tasksDir), "blocks"));
  return maxN;
}

function writeCounter(counterPath: string, value: number): void {
  const temp = `${counterPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${value}\n`);
  try {
    fs.renameSync(temp, counterPath);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

/**
 * Scans existing tasks and the max-ever counter to determine the next
 * sequence number. The caller must hold the allocation guard so the
 * read-and-advance of both sources is one critical section.
 * Returns task ID in format: task-N
 */
export function allocateTaskId(cwd: string): string {
  const tasksDir = path.join(cwd, ".pi", "messenger", "crew", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });

  const maxN = scanTaskFloor(tasksDir);

  const counterPath = path.join(tasksDir, SEQ_FILE);
  const maxEver = readCounter(counterPath);
  // Invalid/unreadable counter data never resets the floor: it is derived from
  // the ids still visible on disk, then persisted so the next allocation stays
  // monotonic even after those artifacts are cleaned up.
  const next = Math.max(maxN, maxEver ?? 0) + 1;
  writeCounter(counterPath, next);
  return `task-${next}`;
}
