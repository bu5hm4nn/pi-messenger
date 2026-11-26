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

function readCounter(counterPath: string): number {
  try {
    const value = parseInt(fs.readFileSync(counterPath, "utf-8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
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

  let maxN = 0;
  if (fs.existsSync(tasksDir)) {
    for (const file of fs.readdirSync(tasksDir)) {
      const match = file.match(/^task-(\d+)\.json$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    }
  }

  const counterPath = path.join(tasksDir, SEQ_FILE);
  const maxEver = readCounter(counterPath);
  const next = Math.max(maxN, maxEver) + 1;
  writeCounter(counterPath, next);
  return `task-${next}`;
}
