/**
 * Crew - Store Operations
 * 
 * Simplified PRD-based storage: plan.json + tasks/*.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Plan, ReviewFeedback, Task, TaskApproval, TaskApprovalDecisionStatus, TaskEvidence, TaskStatus } from "./types.ts";
import { allocateTaskId } from "./id-allocator.ts";
import { normalizeRiskLabels } from "./utils/risk-labels.ts";
import {
  acquireDirMutex,
  dirMutexHeld,
  releaseDirMutex,
  tryAcquireDirMutex,
  tryReclaimDirMutex,
  setDirMutexLivenessProbe,
  DirMutexTimeoutError,
  type DirMutexHandle,
  type DirMutexOptions,
} from "../dir-mutex.ts";

// =============================================================================
// Directory Helpers
// =============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getCrewDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "crew");
}

function getTasksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "tasks");
}

function getBlocksDir(cwd: string): string {
  return path.join(getCrewDir(cwd), "blocks");
}

export function cleanupBlockFiles(cwd: string, taskId: string): void {
  try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}
}

// =============================================================================
// JSON Helpers
// =============================================================================

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function stageFile(filePath: string, content: string): string {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(temp, content);
  return temp;
}

function cleanupStagedFile(temp: string): void {
  try { fs.unlinkSync(temp); } catch {}
}

/** Unlink a file that may have vanished between the scan and the unlink. */
function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function writeJson(filePath: string, data: unknown): void {
  const temp = stageFile(filePath, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    cleanupStagedFile(temp);
    throw err;
  }
}

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function writeText(filePath: string, content: string): void {
  const temp = stageFile(filePath, content);
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    cleanupStagedFile(temp);
    throw err;
  }
}

// =============================================================================
// Per-task cross-process guard
// =============================================================================
//
// Guards are non-empty directories in <crew>/tasks/.locks/<taskId>/ (plus
// .locks/alloc/ for task-id allocation and deletion coordination). They are
// deliberately not task files: task scans only read *.json, deletePlan skips
// the .locks directory, and no task ever sees another task's guard.
//
// The mutex primitive itself lives in ../dir-mutex.ts; this section only maps
// it onto task ids and defines the mutation contract.

const TASK_GUARD_TIMEOUT_MS = 5000;

function getLocksDir(cwd: string): string {
  return path.join(getTasksDir(cwd), ".locks");
}

export function getTaskGuardPath(cwd: string, taskId: string): string {
  return path.join(getLocksDir(cwd), taskId);
}

export function getAllocGuardPath(cwd: string): string {
  return path.join(getLocksDir(cwd), "alloc");
}

function getTaskPath(cwd: string, taskId: string): string {
  return path.join(getTasksDir(cwd), `${taskId}.json`);
}

function getTaskSpecPath(cwd: string, taskId: string): string {
  return path.join(getTasksDir(cwd), `${taskId}.md`);
}

function getTaskSpecPathForVersion(cwd: string, taskId: string, version: number): string {
  return version > 0
    ? path.join(getTasksDir(cwd), `${taskId}.spec.${version}.md`)
    : getTaskSpecPath(cwd, taskId);
}

function getTaskSpecPathForTask(cwd: string, task: Task): string {
  return getTaskSpecPathForVersion(cwd, task.id, task.spec_version ?? 0);
}

/** All spec artifacts for a task, including superseded generations. */
function getTaskSpecFileNames(cwd: string, taskId: string): string[] {
  const dir = getTasksDir(cwd);
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter(name =>
      name === `${taskId}.md` ||
      (name.startsWith(`${taskId}.spec.`) && name.endsWith(".md")),
    )
    .map(name => path.join(dir, name));
}

function removeTaskSpecFiles(cwd: string, taskId: string): void {
  for (const filePath of getTaskSpecFileNames(cwd, taskId)) {
    unlinkIfExists(filePath);
  }
}

/** Best-effort removal of generations the committed JSON no longer selects. */
function removeSupersededTaskSpecs(cwd: string, taskId: string, keepVersion: number): void {
  const keep = getTaskSpecPathForVersion(cwd, taskId, keepVersion);
  for (const filePath of getTaskSpecFileNames(cwd, taskId)) {
    if (filePath === keep) continue;
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/** Directory-mutex handle for a task guard (exported for lifecycle/tests). */
export type TaskGuardHandle = DirMutexHandle;

export function acquireTaskGuard(
  cwd: string,
  taskId: string,
  options?: DirMutexOptions,
): TaskGuardHandle {
  return acquireDirMutex(getTaskGuardPath(cwd, taskId), {
    timeoutMs: options?.timeoutMs ?? TASK_GUARD_TIMEOUT_MS,
    retryMs: options?.retryMs,
  });
}

/** Single-shot acquisition; null means another holder has the guard. */
export function tryAcquireTaskGuard(cwd: string, taskId: string): TaskGuardHandle | null {
  return tryAcquireDirMutex(getTaskGuardPath(cwd, taskId));
}

export function releaseTaskGuard(handle: TaskGuardHandle): void {
  releaseDirMutex(handle);
}

/** Reclaim only a guard whose marker is verified dead (see dir-mutex). */
export function tryReclaimTaskGuard(cwd: string, taskId: string): boolean {
  return tryReclaimDirMutex(getTaskGuardPath(cwd, taskId));
}

export function taskGuardHeld(cwd: string, taskId: string): boolean {
  return dirMutexHeld(getTaskGuardPath(cwd, taskId));
}

/** Test seam for holder liveness; inert in production. */
export function setGuardLivenessProbe(probe: ((pid: number) => "alive" | "dead" | "unknown") | null): void {
  setDirMutexLivenessProbe(probe);
}

let dependentScanProbe: (() => void) | null = null;

/** Test seam fired after deleteTask snapshots its dependent list; inert in production. */
export function setDependentScanProbe(probe: (() => void) | null): void {
  dependentScanProbe = probe;
}

export { DirMutexTimeoutError as TaskLockTimeoutError };

/**
 * The lock was lost between the mutator's write decision and the publish
 * (a reclaimer removed our marker because we looked dead). Aborting is the
 * only safe outcome: publishing would race the new holder.
 */
export class TaskLockLostError extends Error {
  readonly guardPath: string;
  readonly markerName: string;

  constructor(guardPath: string, markerName: string) {
    super(
      `Lost crew task guard ${guardPath} (own marker ${markerName} disappeared before publish); ` +
      `the mutation was aborted instead of publishing over the new holder. Retry once all crew writers are idle.`,
    );
    this.name = "TaskLockLostError";
    this.guardPath = guardPath;
    this.markerName = markerName;
  }
}

export interface TaskMutationContext {
  guardPath: string;
  markerName: string;
}

export interface TaskMutationOptions {
  /**
   * Write companion state (e.g. a generation-named spec file) while the
   * per-task guard is held, BEFORE the task JSON commit. A throw aborts the
   * mutation with the old JSON still pointing at the old, still-valid file.
   */
  prepare?: (task: Task, updated: Task) => void;
  /**
   * Best-effort cleanup after the JSON commit succeeded (e.g. removing
   * superseded spec generations). Errors are swallowed: orphans are harmless.
   */
  afterCommit?: (updated: Task) => void;
}

/**
 * Guarded task mutation. The mutator runs against the freshly-read task while
 * holding the per-task guard; returning null aborts without writing. Callers
 * must express their check (status/owner/dispatch token/attempt budget)
 * inside the mutator, not against a snapshot read before the call.
 *
 * No await, spawn or git may run inside a mutator: the guard is held for the
 * duration and everything else waits behind it.
 */
export function mutateTask(
  cwd: string,
  taskId: string,
  mutate: (task: Task, guard: TaskMutationContext) => Partial<Task> | null,
  options?: TaskMutationOptions,
): Task | null {
  const guard = acquireTaskGuard(cwd, taskId);
  try {
    const task = getTask(cwd, taskId);
    // A mutation that finds no task file must not write one back: that is how
    // a deleted task gets resurrected.
    if (!task) return null;

    const updates = mutate(task, { guardPath: guard.guardPath, markerName: guard.markerName });
    if (!updates) return null;

    const updated: Task = {
      ...task,
      ...updates,
      updated_at: new Date().toISOString(),
      rev: (task.rev ?? 0) + 1,
    };

    // Stage first, then stat our own marker immediately before the rename.
    // If a reclaimer removed the marker while the mutator ran we look dead, so
    // publishing now would collide with whoever holds the guard. The staged
    // temp is private and is cleaned up on refusal.
    const taskPath = getTaskPath(cwd, taskId);
    const temp = stageFile(taskPath, JSON.stringify(updated, null, 2));
    try {
      // Companion first: if this throws, the JSON is never committed and the
      // old record still selects a complete, readable spec generation.
      options?.prepare?.(task, updated);
      if (!fs.existsSync(path.join(guard.guardPath, guard.markerName))) {
        throw new TaskLockLostError(guard.guardPath, guard.markerName);
      }
      fs.renameSync(temp, taskPath);
    } catch (err) {
      cleanupStagedFile(temp);
      throw err;
    }

    try {
      options?.afterCommit?.(updated);
    } catch {
      // Orphaned generations are harmless; never fail a committed mutation.
    }
    return updated;
  } finally {
    releaseTaskGuard(guard);
  }
}

// =============================================================================
// Plan Operations
// =============================================================================

export function getPlan(cwd: string): Plan | null {
  return readJson<Plan>(path.join(getCrewDir(cwd), "plan.json"));
}

export function createPlan(cwd: string, prdPath: string, prompt?: string): Plan {
  const now = new Date().toISOString();
  
  const plan: Plan = {
    prd: prdPath,
    ...(prompt ? { prompt } : {}),
    created_at: now,
    updated_at: now,
    task_count: 0,
    completed_count: 0,
  };

  writeJson(path.join(getCrewDir(cwd), "plan.json"), plan);
  return plan;
}

export function getPlanLabel(plan: Plan, maxLen = 60): string {
  if (!plan.prompt) return plan.prd;
  return plan.prompt.length > maxLen
    ? plan.prompt.slice(0, maxLen - 3) + "..."
    : plan.prompt;
}

export function updatePlan(cwd: string, updates: Partial<Plan>): Plan | null {
  const plan = getPlan(cwd);
  if (!plan) return null;

  const updated: Plan = {
    ...plan,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(path.join(getCrewDir(cwd), "plan.json"), updated);
  return updated;
}

export function deletePlan(cwd: string): boolean {
  const planPath = path.join(getCrewDir(cwd), "plan.json");
  const planMdPath = path.join(getCrewDir(cwd), "plan.md");
  const tasksDir = getTasksDir(cwd);

  let deleted = false;

  // Allocation is serialized against creates so no id is handed out while the
  // board is being wiped.
  const allocGuard = acquireDirMutex(getAllocGuardPath(cwd));

  try {
    // Delete plan.json / plan.md. They can vanish under us if another sweep
    // already removed them; ENOENT is a skip, never a throw.
    if (fs.existsSync(planPath)) {
      unlinkIfExists(planPath);
      deleted = true;
    }
    unlinkIfExists(planMdPath);

    // Collect each task's complete file set from the task and block dirs, then
    // acquire ONE guard per task for all of it. A task whose guard is held is
    // skipped entirely: its writer owns every file in the set. Hidden entries
    // (.locks, stage dirs) and in-flight temp files are never swept.
    const taskIds = new Set<string>();
    const unguardedTaskFiles: string[] = [];
    if (fs.existsSync(tasksDir)) {
      for (const entry of fs.readdirSync(tasksDir)) {
        if (entry === ".locks" || entry.startsWith(".")) continue;
        if (entry.includes(".tmp-")) continue;
        const fullPath = path.join(tasksDir, entry);
        let isFile = false;
        try { isFile = fs.statSync(fullPath).isFile(); } catch { continue; }
        if (!isFile) continue;

        const taskMatch = entry.match(/^(task-\d+)\./);
        if (taskMatch) taskIds.add(taskMatch[1]);
        else unguardedTaskFiles.push(fullPath);
      }
    }

    const blocksDir = getBlocksDir(cwd);
    const unguardedBlockFiles: string[] = [];
    if (fs.existsSync(blocksDir)) {
      for (const file of fs.readdirSync(blocksDir)) {
        if (file.startsWith(".") || file.includes(".tmp-")) continue;
        const fullPath = path.join(blocksDir, file);
        let isFile = false;
        try { isFile = fs.statSync(fullPath).isFile(); } catch { continue; }
        if (!isFile) continue;

        const taskMatch = file.match(/^(task-\d+)\.md$/);
        if (taskMatch) taskIds.add(taskMatch[1]);
        else unguardedBlockFiles.push(fullPath);
      }
    }

    for (const taskId of taskIds) {
      const guard = tryAcquireTaskGuard(cwd, taskId);
      if (!guard) continue;
      try {
        for (const ext of [".json", ".progress.md"]) {
          unlinkIfExists(path.join(tasksDir, `${taskId}${ext}`));
        }
        removeTaskSpecFiles(cwd, taskId);
        unlinkIfExists(path.join(blocksDir, `${taskId}.md`));
      } finally {
        releaseTaskGuard(guard);
      }
    }

    // Files outside the task-id namespace have no writer guard to coordinate
    // with; remove them only after the per-task sets are done.
    for (const filePath of [...unguardedTaskFiles, ...unguardedBlockFiles]) {
      unlinkIfExists(filePath);
    }
  } finally {
    releaseTaskGuard(allocGuard);
  }

  return deleted;
}

// =============================================================================
// Plan Spec Operations
// =============================================================================

export function getPlanSpec(cwd: string): string | null {
  return readText(path.join(getCrewDir(cwd), "plan.md"));
}

export function setPlanSpec(cwd: string, content: string): void {
  writeText(path.join(getCrewDir(cwd), "plan.md"), content);
  updatePlan(cwd, {}); // Touch updated_at
}

// =============================================================================
// Task Operations
// =============================================================================

export function createTask(
  cwd: string,
  title: string,
  description?: string,
  dependsOn?: string[],
  options?: Pick<Task, "role" | "risk_labels" | "approval" | "skills" | "model">
): Task {
  const tasksDir = getTasksDir(cwd);
  ensureDir(tasksDir);
  const now = new Date().toISOString();
  const riskLabels = normalizeRiskLabels(options?.risk_labels);

  // The alloc guard serializes "scan for the next id" and "reserve that id":
  // two processes can otherwise both scan task-4 and one would overwrite the
  // other's task file.
  const allocGuard = acquireDirMutex(getAllocGuardPath(cwd));
  let task: Task;
  try {
    for (;;) {
      const id = allocateTaskId(cwd);
      const taskPath = getTaskPath(cwd, id);
      try {
        // wx-create reserves the id. EEXIST means another allocator won the
        // race even though we hold the alloc guard (e.g. a crashed holder's
        // id was already on disk); rescan.
        fs.writeFileSync(taskPath, "", { flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }

      const specVersion = 1;
      task = {
        id,
        title,
        status: "todo",
        depends_on: dependsOn ?? [],
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.role ? { role: options.role } : {}),
        ...(riskLabels ? { risk_labels: riskLabels } : {}),
        ...(options?.approval ? { approval: options.approval } : {}),
        ...(options?.skills && options.skills.length > 0 ? { skills: options.skills } : {}),
        created_at: now,
        updated_at: now,
        attempt_count: 0,
        spec_version: specVersion,
      };

      // Write the generation-named spec FIRST, then commit the JSON that
      // selects it. Readers never observe a task record whose selected spec
      // generation does not exist; a failed spec write leaves only the empty
      // reservation placeholder, which getTask ignores.
      const specContent = description
        ? `# ${title}\n\n${description}\n`
        : `# ${title}\n\n*Spec pending*\n`;
      const specPath = getTaskSpecPathForVersion(cwd, id, specVersion);
      try {
        writeText(specPath, specContent);
        writeJson(taskPath, task);
      } catch (err) {
        try { fs.unlinkSync(specPath); } catch {}
        try { fs.unlinkSync(taskPath); } catch {}
        throw err;
      }
      break;
    }

    // Plan accounting is part of the same critical section: a concurrent
    // deletePlan must not interleave between task publication and the count.
    const plan = getPlan(cwd);
    if (plan) {
      updatePlan(cwd, { task_count: plan.task_count + 1 });
    }
  } finally {
    releaseTaskGuard(allocGuard);
  }

  return task;
}

function normalizeApproval(raw: unknown): TaskApproval | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const metadata = {
    ...(typeof value.plan === "string" ? { plan: value.plan } : {}),
    ...(typeof value.feedback === "string" ? { feedback: value.feedback } : {}),
    ...(typeof value.decided_by === "string" ? { decided_by: value.decided_by } : {}),
    ...(typeof value.decided_at === "string" ? { decided_at: value.decided_at } : {}),
  };
  if (value.required !== true) return { required: false, status: "not_required", ...metadata };

  const status: TaskApprovalDecisionStatus = value.status === "approved" || value.status === "rejected"
    ? value.status
    : "pending";
  return { required: true, status, ...metadata };
}

function normalizeTask(raw: Task): Task {
  const approval = normalizeApproval(raw.approval);
  const attemptCount = typeof raw.attempt_count === "number" ? raw.attempt_count : 0;
  const rawBaseline = typeof raw.budget_baseline === "number" ? raw.budget_baseline : undefined;
  return {
    ...raw,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    skills: Array.isArray(raw.skills) ? raw.skills.filter(s => typeof s === "string") : undefined,
    role: typeof raw.role === "string" && raw.role.trim().length > 0 ? raw.role : undefined,
    risk_labels: normalizeRiskLabels(Array.isArray(raw.risk_labels) ? raw.risk_labels.filter(s => typeof s === "string") : undefined),
    approval,
    attempt_count: attemptCount,
    // An out-of-range baseline is hand-corruption, not a legitimate budget:
    // above the lifetime count it would make attemptsSinceReset negative and
    // fail open every cap comparison. Repair it here (fresh-budget-equivalent,
    // since-reset 0) so the next guarded mutation persists the bounded record.
    budget_baseline: rawBaseline === undefined
      ? undefined
      : Math.max(0, Math.min(rawBaseline, attemptCount)),
    dispatch_token: typeof raw.dispatch_token === "string" ? raw.dispatch_token : undefined,
    completed_dispatch: typeof raw.completed_dispatch === "string" ? raw.completed_dispatch : undefined,
    rev: typeof raw.rev === "number" ? raw.rev : 0,
    generation: typeof raw.generation === "number" ? raw.generation : 0,
    spec_version: typeof raw.spec_version === "number" && raw.spec_version > 0 ? raw.spec_version : 0,
    pending_split: raw.pending_split === true ? true : undefined,
  };
}

export function getTask(cwd: string, taskId: string): Task | null {
  const raw = readJson<Task>(getTaskPath(cwd, taskId));
  return raw ? normalizeTask(raw) : null;
}

/**
 * Fields owned by the lifecycle mutations. A generic update must not write
 * them: those checks (status/owner/token/attempt budget) only exist inside
 * claimTaskForDispatch/startTask/completeTask/exitAttempt/resetTask/etc.
 */
const LIFECYCLE_FIELDS = [
  "status",
  "assigned_to",
  "dispatch_token",
  "attempt_count",
  "budget_baseline",
  "completed_by",
  "completed_dispatch",
  "pending_split",
] as const;

export function updateTask(cwd: string, taskId: string, updates: Partial<Task>): Task | null {
  for (const field of LIFECYCLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      throw new Error(
        `updateTask cannot write lifecycle field "${field}" on ${taskId}; ` +
        `use claimTaskForDispatch/startTask/completeTask/blockTask/unblockTask/resetTask/applyReview instead`,
      );
    }
  }
  return mutateTask(cwd, taskId, () => updates);
}

export function getTasks(cwd: string): Task[] {
  const dir = getTasksDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const tasks: Task[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = readJson<Task>(path.join(dir, file));
    if (raw) tasks.push(normalizeTask(raw));
  }

  // Sort by ID number (task-1, task-2, ...)
  return tasks.sort((a, b) => {
    const aNum = parseInt(a.id.replace("task-", ""));
    const bNum = parseInt(b.id.replace("task-", ""));
    return aNum - bNum;
  });
}

/** Read the spec generation selected by the task JSON (the only pointer). */
export function getTaskSpecFor(cwd: string, task: Task): string | null {
  return readText(getTaskSpecPathForTask(cwd, task));
}

export function getTaskSpec(cwd: string, taskId: string): string | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;
  return getTaskSpecFor(cwd, task);
}

export function appendTaskProgress(cwd: string, taskId: string, agent: string, message: string): void {
  // Progress is companion state for a live task record. A task deleted while a
  // note was in flight must not be resurrected as an orphan .progress.md; the
  // record is the source of truth, so a missing record means no note.
  if (!getTask(cwd, taskId)) return;
  const progressPath = path.join(getTasksDir(cwd), `${taskId}.progress.md`);
  ensureDir(path.dirname(progressPath));
  const timestamp = new Date().toISOString();
  fs.appendFileSync(progressPath, `[${timestamp}] (${agent}) ${message}\n`);
}

export function getTaskProgress(cwd: string, taskId: string): string | null {
  const content = readText(path.join(getTasksDir(cwd), `${taskId}.progress.md`));
  return content && content.trim().length > 0 ? content : null;
}

export function getBlockContext(cwd: string, taskId: string): string | null {
  return readText(path.join(getBlocksDir(cwd), `${taskId}.md`));
}

// =============================================================================
// Spec edits (generation-preconditioned)
// =============================================================================

export class StaleTaskGenerationError extends Error {
  readonly taskId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(taskId: string, expected: number, actual: number) {
    super(
      `Task ${taskId} changed while an edit was in flight (expected generation ${expected}, found ${actual}); ` +
      `re-read the task and retry so the newer edit is not overwritten.`,
    );
    this.name = "StaleTaskGenerationError";
    this.taskId = taskId;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface SpecEditOptions {
  /** Abort unless the task's spec generation is still this value. */
  expectedGeneration?: number;
}

function assertGeneration(task: Task, options?: SpecEditOptions): void {
  if (options?.expectedGeneration === undefined) return;
  const actual = task.generation ?? 0;
  if (actual !== options.expectedGeneration) {
    throw new StaleTaskGenerationError(task.id, options.expectedGeneration, actual);
  }
}

export interface TaskRevisionInput {
  title?: string;
  spec: string;
}

/**
 * Apply a spec (and optional title) under the task guard. Spec/title
 * transforms are computed outside the lock (an agent produced them), so they
 * carry an expected generation and abort rather than overwrite a newer edit.
 */
export function applyTaskRevision(
  cwd: string,
  taskId: string,
  revision: TaskRevisionInput,
  options?: SpecEditOptions,
): Task | null {
  // The spec content is written to a new generation-named file while the
  // guard is held, then the JSON commit atomically selects it. A reader can
  // only ever see an old JSON + old file or a new JSON + new file; a thrown
  // spec write leaves the old JSON pointing at the still-valid old file.
  return mutateTask(cwd, taskId, task => {
    assertGeneration(task, options);
    return {
      ...(revision.title ? { title: revision.title } : {}),
      generation: (task.generation ?? 0) + 1,
      spec_version: (task.spec_version ?? 0) + 1,
    };
  }, {
    prepare: (_task, updated) => {
      const version = updated.spec_version ?? 1;
      writeText(getTaskSpecPathForVersion(cwd, taskId, version), revision.spec);
    },
    afterCommit: updated => {
      removeSupersededTaskSpecs(cwd, taskId, updated.spec_version ?? 0);
    },
  });
}

export function setTaskSpec(cwd: string, taskId: string, content: string, options?: SpecEditOptions): boolean {
  return applyTaskRevision(cwd, taskId, { spec: content }, options) !== null;
}

export function deleteTask(cwd: string, taskId: string): boolean {
  // Hold the task guard across read + unlink so a concurrent mutation cannot
  // read the task, lose the guard, and publish it back after the delete.
  const guard = acquireTaskGuard(cwd, taskId);
  let task: Task | null;
  try {
    task = getTask(cwd, taskId);
    if (!task) return false;

    const tasksDir = getTasksDir(cwd);
    for (const ext of [".json", ".progress.md"]) {
      try { fs.unlinkSync(path.join(tasksDir, `${taskId}${ext}`)); } catch {}
    }
    removeTaskSpecFiles(cwd, taskId);

    try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}
  } finally {
    releaseTaskGuard(guard);
  }

  // Dependents: the filter is computed from the task state read *inside* the
  // dependent's mutation, so a dependency added after our snapshot survives.
  const dependents = getTasks(cwd);
  try {
    dependentScanProbe?.();
  } catch {
    // Test seam only; must never affect the delete.
  }
  for (const t of dependents) {
    if (!t.depends_on.includes(taskId)) continue;
    mutateTask(cwd, t.id, current =>
      current.depends_on.includes(taskId)
        ? { depends_on: current.depends_on.filter(d => d !== taskId) }
        : null
    );
  }

  const plan = getPlan(cwd);
  if (plan) {
    const updates: Partial<Plan> = { task_count: plan.task_count - 1 };
    if (task.status === "done") {
      updates.completed_count = plan.completed_count - 1;
    }
    updatePlan(cwd, updates);
  }

  return true;
}

/**
 * Best-effort rollback for a task created by a decision that was never
 * committed (e.g. a split whose milestone link was refused). Only an untouched
 * todo task with no attempt charge, reservation, dependents or milestone is
 * removed; anything a concurrent wave may already own is left alone.
 */
export function discardUnclaimedTask(cwd: string, taskId: string): boolean {
  const guard = acquireTaskGuard(cwd, taskId);
  let removed = false;
  try {
    const task = getTask(cwd, taskId);
    if (!task) return false;
    if (task.status !== "todo" || task.dispatch_token !== undefined) return false;
    if (task.milestone || task.pending_split) return false;
    if ((task.attempt_count ?? 0) !== 0) return false;
    if (getTasks(cwd).some(t => t.depends_on.includes(taskId))) return false;

    const tasksDir = getTasksDir(cwd);
    for (const ext of [".json", ".progress.md"]) {
      try { fs.unlinkSync(path.join(tasksDir, `${taskId}${ext}`)); } catch {}
    }
    removeTaskSpecFiles(cwd, taskId);
    try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}
    removed = true;
  } finally {
    releaseTaskGuard(guard);
  }

  if (removed) {
    const plan = getPlan(cwd);
    if (plan) updatePlan(cwd, { task_count: Math.max(0, plan.task_count - 1) });
  }
  return removed;
}

// =============================================================================
// Task Lifecycle Operations
// =============================================================================

export function getBaseCommit(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

export interface ClaimOptions {
  /** Refuse the claim at/above this many attempts since the last explicit reset. */
  maxAttempts?: number;
}

/**
 * Retry budget consumed since the last explicit reset. `attempt_count` is the
 * lifetime number (audit/completion import); `budget_baseline` is the lifetime
 * value observed at that reset. Legacy records have no baseline and therefore
 * keep their original lifetime accounting (baseline 0). The result is clamped
 * at zero: a corrupted baseline above the lifetime count is repaired on
 * hydration, and this read guard also bounds any raw/transient snapshot so
 * corruption can never buy a negative (fail-open) budget.
 */
export function attemptsSinceReset(task: Task): number {
  return Math.max(0, (task.attempt_count ?? 0) - (task.budget_baseline ?? 0));
}

/**
 * Reserve a todo task for one dispatch. The reservation is the dispatch
 * token; the attempt is charged exactly here, once per dispatch, so a worker
 * that never reaches task.start still consumed its budget. The budget is
 * counted since the task's last explicit reset; automatic recoveries and
 * exits never advance the baseline. An explicit reset is the only thing that
 * renews it (through task-actions, never through resetTask by default).
 */
export function claimTaskForDispatch(
  cwd: string,
  taskId: string,
  workerName: string,
  options?: ClaimOptions,
): Task | null {
  const maxAttempts = options?.maxAttempts ?? Number.POSITIVE_INFINITY;
  return mutateTask(cwd, taskId, task => {
    if (task.status !== "todo") return null;
    if (task.pending_split) return null;
    if (task.dispatch_token) return null;
    const attemptCount = task.attempt_count ?? 0;
    if (attemptsSinceReset(task) >= maxAttempts) return null;
    return {
      dispatch_token: randomUUID(),
      assigned_to: workerName,
      attempt_count: attemptCount + 1,
    };
  });
}

export interface StartOptions {
  /** Base commit computed by the caller before acquiring the guard. */
  baseCommit?: string;
  /** Dispatch token this start must match (spawned worker path). */
  dispatchToken?: string;
}

// Manual (human/orchestrator) starts mint a session-held token that is never
// handed to a spawned worker. The prefix distinguishes it from a dispatch
// reservation, so a name-only caller may finish its own manual session while
// it can never act on a token-bearing worker attempt.
const MANUAL_TOKEN_PREFIX = "session-";

function mintManualToken(): string {
  return `${MANUAL_TOKEN_PREFIX}${randomUUID()}`;
}

function isManualToken(token: string | undefined): boolean {
  return token?.startsWith(MANUAL_TOKEN_PREFIX) === true;
}

/**
 * todo -> in_progress. With a dispatch token the start must match the
 * reservation and does not re-charge the attempt; a manual human start mints
 * a session-held token and charges the attempt here. A name-only caller can
 * never start another dispatch's token-bearing attempt.
 */
export function startTask(
  cwd: string,
  taskId: string,
  agentName: string,
  options?: StartOptions,
): Task | null {
  const baseCommit = options?.baseCommit;
  const dispatchToken = options?.dispatchToken;
  return mutateTask(cwd, taskId, task => {
    if (task.status !== "todo") return null;
    if (task.pending_split) return null;
    if (dispatchToken !== undefined) {
      if (task.dispatch_token !== dispatchToken) return null;
    } else if (task.dispatch_token !== undefined) {
      // A reservation exists. Only the manual-session owner may resume it;
      // a same-name worker without the token must not act on it.
      if (!isManualToken(task.dispatch_token) || task.assigned_to !== agentName) return null;
    }
    const alreadyCharged = task.dispatch_token !== undefined;
    return {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: baseCommit,
      assigned_to: agentName,
      attempt_count: alreadyCharged ? task.attempt_count : task.attempt_count + 1,
      dispatch_token: task.dispatch_token ?? mintManualToken(),
    };
  });
}

export interface CompleteOptions {
  /** Dispatch token carried by the worker (PI_CREW_DISPATCH). */
  dispatchToken?: string;
}

/**
 * in_progress -> done. Requires the live reservation (token) or, for callers
 * without a token, the recorded owner of a manual session. A name-only caller
 * can never complete a token-bearing dispatch attempt.
 */
export function completeTask(
  cwd: string,
  taskId: string,
  summary: string,
  evidence?: TaskEvidence,
  completedBy?: string,
  options?: CompleteOptions,
): Task | null {
  const dispatchToken = options?.dispatchToken;
  const updated = mutateTask(cwd, taskId, task => {
    if (task.status !== "in_progress") return null;
    if (task.pending_split) return null;
    if (dispatchToken !== undefined) {
      if (task.dispatch_token !== dispatchToken) return null;
    } else {
      if (task.dispatch_token !== undefined && !isManualToken(task.dispatch_token)) return null;
      if (completedBy !== undefined && task.assigned_to !== completedBy) return null;
    }
    return {
      status: "done",
      completed_at: new Date().toISOString(),
      summary,
      evidence,
      assigned_to: undefined,
      completed_by: completedBy,
      completed_dispatch: task.dispatch_token,
      dispatch_token: undefined,
    };
  });

  // Update plan completed count
  if (updated) {
    const plan = getPlan(cwd);
    if (plan) {
      updatePlan(cwd, { completed_count: plan.completed_count + 1 });
    }
  }

  autoCompleteMilestones(cwd);

  return updated;
}

export interface LifecycleFence {
  /** Only proceed while the task is assigned to this identity. */
  owner?: string;
  /** Only proceed while this dispatch token is the live reservation. */
  dispatchToken?: string;
}

export interface BlockOptions extends LifecycleFence {
  /** Only block while the task is still in this status. */
  expectedStatus?: TaskStatus;
  /** Only block a task that has no live dispatch reservation. */
  requireNoDispatchToken?: boolean;
  /** Only block at/above this many attempts since the last explicit reset. */
  minAttemptCount?: number;
  /** For a done task: only block while this completion still owns it. */
  completedDispatch?: string;
  completedBy?: string;
}

export function blockTask(
  cwd: string,
  taskId: string,
  reason: string,
  fence?: BlockOptions,
): Task | null {
  const updated = mutateTask(cwd, taskId, task => {
    if (fence?.expectedStatus !== undefined && task.status !== fence.expectedStatus) return null;
    if (fence?.requireNoDispatchToken && task.dispatch_token !== undefined) return null;
    if (fence?.minAttemptCount !== undefined && attemptsSinceReset(task) < fence.minAttemptCount) return null;
    if (fence?.completedDispatch !== undefined && task.completed_dispatch !== fence.completedDispatch) return null;
    if (fence?.completedBy !== undefined && task.completed_by !== fence.completedBy) return null;
    if (fence?.dispatchToken !== undefined && task.dispatch_token !== fence.dispatchToken) return null;
    if (fence?.owner !== undefined && task.assigned_to !== fence.owner) return null;
    return {
      status: "blocked",
      blocked_reason: reason,
      assigned_to: undefined,
      dispatch_token: undefined,
    };
  });
  if (!updated) return null;

  // Write block context to blocks directory
  const blockPath = path.join(getBlocksDir(cwd), `${taskId}.md`);
  writeText(blockPath, `# Blocked: ${updated.title}\n\n**Reason:** ${reason}\n\n**Blocked at:** ${new Date().toISOString()}\n`);

  return updated;
}

const REOPEN_CLEARS: Partial<Task> = {
  started_at: undefined,
  completed_at: undefined,
  base_commit: undefined,
  assigned_to: undefined,
  summary: undefined,
  evidence: undefined,
  completed_by: undefined,
  completed_dispatch: undefined,
  blocked_reason: undefined,
  dispatch_token: undefined,
};

/**
 * blocked -> todo (explicit takeover). Reopening invalidates the active
 * dispatch token and the completion attribution. Unlike an explicit reset,
 * unblock does NOT renew the retry budget: it is not a reset, so the
 * since-reset attempt count (and any baseline) is left untouched.
 */
export function unblockTask(cwd: string, taskId: string, fence?: LifecycleFence): Task | null {
  const updated = mutateTask(cwd, taskId, task => {
    if (task.status !== "blocked") return null;
    if (fence?.dispatchToken !== undefined && task.dispatch_token !== fence.dispatchToken) return null;
    if (fence?.owner !== undefined && task.assigned_to !== fence.owner) return null;
    return { status: "todo", ...REOPEN_CLEARS };
  });
  if (!updated) return null;

  cleanupBlockFiles(cwd, taskId);
  return updated;
}

export interface ResetLifecycleSnapshot {
  status: TaskStatus;
  createdAt?: string;
  assignedTo?: string;
  dispatchToken?: string;
  completedAt?: string;
  completedDispatch?: string;
  /**
   * Lifetime attempt_count at snapshot time. A claim after the snapshot changes
   * it even when the owner/token were cleared again by a failed attempt, so it
   * must be fenced or a stale cascade could clear the newer block.
   */
  attemptCount?: number;
  /** Lifetime budget_baseline at snapshot time (fenced with the attempt state). */
  budgetBaseline?: number;
}

export interface ResetTaskOptions extends LifecycleFence {
  expectedStatus?: TaskStatus;
  /**
   * Renew the retry budget: record the current lifetime attempt_count as the
   * new budget baseline. Only the explicit reset/cascade-reset entry points
   * in task-actions pass this; automatic resets (review bounce, crash/exit
   * recovery, revise/split takeover, task.stop) must leave it unset.
   */
  renewBudget?: boolean;
  /**
   * Revalidate the lifecycle state captured by the caller before this reset.
   * Spec edits may have bumped generation/rev since then, but a claim,
   * completion or attempt charge after the snapshot must refuse the reset
   * instead of being treated as a takeover.
   */
  expectedLifecycle?: ResetLifecycleSnapshot;
  /**
   * Refuse while a live dispatch reservation exists. Cascade dependents set
   * this so a task claimed or started after the subtree scan is skipped rather
   * than clobbered. The explicit root reset keeps clearing its reservation.
   */
  requireNoDispatchToken?: boolean;
  /**
   * Dependent snapshot captured by the caller before the cascade began. When
   * present, these tasks are revalidated under their guards instead of being
   * re-scanned, so a claim between the snapshot and the reset is detected.
   */
  cascadeSnapshot?: Task[];
}

/**
 * Tasks that transitively depend on rootId, in the caller's snapshot order.
 *
 * Contract: an explicit cascade-reset resets every transitive dependent that
 * passes the per-task lifecycle fence, regardless of intermediate status. The
 * walk deliberately continues through todo intermediates: a done grandchild
 * under a todo intermediate is still part of the subtree. A todo dependent
 * needs no reset and is skipped with a note, but it never truncates the walk.
 */
function transitiveDependentSnapshots(allTasks: Task[], rootId: string): Task[] {
  const collected = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const task of allTasks) {
      if (task.id === rootId || collected.has(task.id)) continue;
      if (task.depends_on.includes(current)) {
        collected.add(task.id);
        queue.push(task.id);
      }
    }
  }
  return allTasks.filter(t => collected.has(t.id));
}

/** Why a cascade dependent was not safe to reset after the snapshot. */
function cascadeSkipReason(snapshot: Task, current: Task): string {
  const reasons: string[] = [];
  if (current.status !== snapshot.status) {
    reasons.push(`status changed from ${snapshot.status} to ${current.status}`);
  }
  if ((current.assigned_to ?? undefined) !== (snapshot.assigned_to ?? undefined)) {
    reasons.push(`ownership changed from ${snapshot.assigned_to ?? "unassigned"} to ${current.assigned_to ?? "unassigned"}`);
  }
  if (current.dispatch_token !== undefined) {
    reasons.push(
      "an active dispatch reservation is held; wait for the worker to finish or stop it, " +
      "then retry with a single task.reset (verify any stale reservation first)",
    );
  }
  if ((current.completed_at ?? undefined) !== (snapshot.completed_at ?? undefined)) {
    reasons.push("completion changed");
  }
  if ((current.completed_dispatch ?? undefined) !== (snapshot.completed_dispatch ?? undefined)) {
    reasons.push("completion attribution changed");
  }
  if (
    (current.attempt_count ?? 0) !== (snapshot.attempt_count ?? 0) ||
    (current.budget_baseline ?? undefined) !== (snapshot.budget_baseline ?? undefined)
  ) {
    reasons.push(
      `attempt state changed (lifetime ${snapshot.attempt_count ?? 0} -> ${current.attempt_count ?? 0}, ` +
      `baseline ${snapshot.budget_baseline ?? "none"} -> ${current.budget_baseline ?? "none"})`,
    );
  }
  return reasons.length > 0 ? reasons.join(", ") : "lifecycle changed";
}

export function resetTask(
  cwd: string,
  taskId: string,
  cascade: boolean = false,
  options?: ResetTaskOptions,
): Task[] {
  const resetTasks: Task[] = [];
  let wasDone = false;

  // Reset this task (explicit takeover: clears completion attribution and any
  // live dispatch reservation).
  const updated = mutateTask(cwd, taskId, task => {
    if (options?.expectedStatus !== undefined && task.status !== options.expectedStatus) return null;
    const expected = options?.expectedLifecycle;
    if (expected) {
      if (task.status !== expected.status) return null;
      if ((task.created_at ?? undefined) !== (expected.createdAt ?? undefined)) return null;
      if ((task.assigned_to ?? undefined) !== (expected.assignedTo ?? undefined)) return null;
      if ((task.dispatch_token ?? undefined) !== (expected.dispatchToken ?? undefined)) return null;
      if ((task.completed_at ?? undefined) !== (expected.completedAt ?? undefined)) return null;
      if ((task.completed_dispatch ?? undefined) !== (expected.completedDispatch ?? undefined)) return null;
      // Fence the lifetime attempt state, not attemptsSinceReset: a renewal can
      // legitimately lower since-reset usage, so it cannot reveal a newer
      // claim/re-block whose owner and token were cleared again.
      if ((task.attempt_count ?? 0) !== (expected.attemptCount ?? 0)) return null;
      if ((task.budget_baseline ?? undefined) !== (expected.budgetBaseline ?? undefined)) return null;
    }
    if (options?.dispatchToken !== undefined && task.dispatch_token !== options.dispatchToken) return null;
    if (options?.owner !== undefined && task.assigned_to !== options.owner) return null;
    if (options?.requireNoDispatchToken && task.dispatch_token !== undefined) return null;
    wasDone = task.status === "done";
    return {
      status: "todo",
      ...REOPEN_CLEARS,
      // Lifetime attempt_count is kept for audit/completion import. An
      // explicit reset renews only the retry budget by advancing the baseline
      // to that lifetime value; the count itself never decreases.
      ...(options?.renewBudget ? { budget_baseline: task.attempt_count ?? 0 } : {}),
    };
  });
  if (!updated) return resetTasks;
  resetTasks.push(updated);

  cleanupBlockFiles(cwd, taskId);

  // If cascade, reset every transitive dependent. Selection uses the caller's
  // pre-cascade snapshot when supplied; otherwise scan now. Each dependent is
  // revalidated under its own guard before the write: a task claimed, started,
  // completed, reassigned or attempt-charged after the snapshot is skipped
  // with a note instead of being clobbered or granted a renewed budget.
  if (cascade) {
    const allTasks = options?.cascadeSnapshot ?? getTasks(cwd);
    for (const snapshot of transitiveDependentSnapshots(allTasks, taskId)) {
      if (snapshot.status === "todo") {
        appendTaskProgress(cwd, snapshot.id, "system",
          `Cascade reset skipped ${snapshot.id}: already todo; left untouched.`);
        continue;
      }
      const cascaded = resetTask(cwd, snapshot.id, false, {
        renewBudget: options?.renewBudget,
        expectedLifecycle: {
          status: snapshot.status,
          createdAt: snapshot.created_at,
          assignedTo: snapshot.assigned_to,
          dispatchToken: snapshot.dispatch_token,
          completedAt: snapshot.completed_at,
          completedDispatch: snapshot.completed_dispatch,
          attemptCount: snapshot.attempt_count,
          budgetBaseline: snapshot.budget_baseline,
        },
        requireNoDispatchToken: true,
      });
      if (cascaded.length === 0) {
        const current = getTask(cwd, snapshot.id);
        // A dependent that vanished before its turn has no record to annotate;
        // never recreate a progress file for a deleted task.
        if (!current) continue;
        appendTaskProgress(cwd, snapshot.id, "system",
          `Cascade reset skipped ${snapshot.id}: ${cascadeSkipReason(snapshot, current)}; left untouched.`);
        continue;
      }
      resetTasks.push(...cascaded);
    }
  }

  // Update plan completed count if needed
  if (wasDone && resetTasks.length > 0) {
    const plan = getPlan(cwd);
    if (plan) {
      const doneTasks = getTasks(cwd).filter(t => t.status === "done");
      updatePlan(cwd, { completed_count: doneTasks.length });
    }
  }

  return resetTasks;
}

/** Release a reservation whose launch/delivery failed, only if it still matches. */
export function releaseDispatch(cwd: string, taskId: string, dispatchToken: string): Task | null {
  return mutateTask(cwd, taskId, task => {
    if (task.dispatch_token !== dispatchToken) return null;
    if (task.status === "done" || task.status === "blocked") return null;
    return {
      dispatch_token: undefined,
      ...(task.status === "todo" ? { assigned_to: undefined } : {}),
    };
  });
}

export interface ExitAttemptOptions extends LifecycleFence {
  maxAttempts?: number;
}

export interface ExitAttemptResult {
  outcome: "blocked" | "todo" | "missing" | "changed";
  /** Updated task after an accepted exit (null when refused/missing). */
  task: Task | null;
  /**
   * Validated prior-attempt snapshot captured under the guard. Only present
   * for an accepted exit; a refusal never returns it, so callers cannot emit a
   * reconcile note for an attempt this dispatch did not own.
   */
  previous: Task | null;
  /** Typed refusal reason (present when outcome is changed/missing). */
  reason?: string;
}

/**
 * One guarded exit used by every crash/receipt path (work.ts receipts and the
 * lobby close handler). The attempt was already charged at claim, so this
 * only releases the reservation or blocks at the attempt cap -- it never
 * re-charges, and it never touches a task owned by a newer dispatch. When both
 * owner and token are supplied BOTH must match.
 */
export function exitAttempt(cwd: string, taskId: string, options: ExitAttemptOptions = {}): ExitAttemptResult {
  let outcome: ExitAttemptResult["outcome"] = "changed";
  let previous: Task | null = null;
  let refusal: string | undefined;
  const updated = mutateTask(cwd, taskId, task => {
    if (options.dispatchToken !== undefined && task.dispatch_token !== options.dispatchToken) {
      refusal = "dispatch_token_mismatch";
      return null;
    }
    if (options.owner !== undefined && task.assigned_to !== options.owner) {
      refusal = "owner_mismatch";
      return null;
    }
    if (task.status === "todo") {
      if (!task.dispatch_token) {
        refusal = "no_live_reservation";
        return null;
      }
    } else if (task.status !== "in_progress") {
      refusal = `status_${task.status}`;
      return null;
    }

    // All fences passed: this is the snapshot the caller may use for notes.
    previous = task;
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (attemptsSinceReset(task) >= maxAttempts) {
      outcome = "blocked";
      return {
        status: "blocked",
        blocked_reason: `Max attempts (${maxAttempts}) reached`,
        assigned_to: undefined,
        dispatch_token: undefined,
      };
    }
    outcome = "todo";
    return { status: "todo", assigned_to: undefined, dispatch_token: undefined };
  });

  if (updated) return { outcome, task: updated, previous };
  const missing = !getTask(cwd, taskId);
  return {
    outcome: missing ? "missing" : "changed",
    task: null,
    previous: null,
    reason: missing ? "task_missing" : refusal ?? "status_changed",
  };
}

// =============================================================================
// Review application (single guarded mutation)
// =============================================================================

export interface ReviewAttribution {
  /** Status observed when the review started. */
  status: TaskStatus;
  /** For done tasks: the completion's dispatch attribution. */
  dispatchToken?: string;
  /** Fallback attribution for tokenless (lobby/manual) completions. */
  owner?: string;
}

/**
 * Persist review feedback, review_count and the verdict's status change in a
 * single guarded mutation. Feedback computed by a reviewer is discarded when
 * the task is no longer done by the dispatch that was reviewed.
 */
export function applyReview(
  cwd: string,
  taskId: string,
  feedback: ReviewFeedback,
  attribution: ReviewAttribution,
): Task | null {
  return mutateTask(cwd, taskId, task => {
    if (task.status !== attribution.status) return null;

    if (task.status === "done") {
      if (attribution.dispatchToken !== undefined) {
        if (task.completed_dispatch !== attribution.dispatchToken) return null;
      } else if (attribution.owner !== undefined && task.completed_by !== attribution.owner) {
        return null;
      }
    } else if (task.status === "in_progress") {
      if (attribution.dispatchToken !== undefined && task.dispatch_token !== attribution.dispatchToken) return null;
      if (attribution.owner !== undefined && task.assigned_to !== attribution.owner) return null;
    }

    const updates: Partial<Task> = {
      last_review: feedback,
      review_count: (task.review_count ?? 0) + 1,
    };

    if (task.status === "done") {
      if (feedback.verdict === "NEEDS_WORK") {
        Object.assign(updates, { status: "todo", ...REOPEN_CLEARS });
      } else if (feedback.verdict === "MAJOR_RETHINK") {
        const summary = feedback.summary.split("\n")[0].slice(0, 120);
        Object.assign(updates, {
          status: "blocked",
          blocked_reason: `Reviewer: ${summary || "Major issues found"}`,
          assigned_to: undefined,
          dispatch_token: undefined,
        });
      }
    }

    return updates;
  });
}

// =============================================================================
// Ready Tasks (Dependency Resolution)
// =============================================================================

/** A todo task carrying a dispatch token is reserved: not ready to launch. */
function isDispatchable(task: Task): boolean {
  return task.status === "todo" && !task.dispatch_token && !task.pending_split;
}

export function getReadyTasksFrom(tasks: Task[], options?: { advisory?: boolean }): Task[] {
  if (options?.advisory) {
    return tasks.filter(t => isDispatchable(t) && !t.milestone);
  }
  const doneIds = new Set(tasks.filter(t => t.status === "done").map(t => t.id));

  return tasks.filter(task => {
    if (!isDispatchable(task) || task.milestone) return false;
    return task.depends_on.every(depId => doneIds.has(depId));
  });
}

export function getReadyTasks(cwd: string, options?: { advisory?: boolean }): Task[] {
  return getReadyTasksFrom(getTasks(cwd), options);
}

export function autoCompleteMilestones(cwd: string): void {
  let changed = true;
  while (changed) {
    changed = false;
    const tasks = getTasks(cwd);
    for (const task of tasks) {
      if (!task.milestone || !isDispatchable(task)) continue;
      const completed = mutateTask(cwd, task.id, current => {
        if (!current.milestone || !isDispatchable(current) || current.pending_split) return null;
        const allDepsDone = current.depends_on.every(depId => getTask(cwd, depId)?.status === "done");
        if (!allDepsDone) return null;
        return {
          status: "done",
          completed_at: new Date().toISOString(),
          summary: "All subtasks completed",
        };
      });
      if (completed) {
        const doneCount = getTasks(cwd).filter(t => t.status === "done").length;
        const plan = getPlan(cwd);
        if (plan) updatePlan(cwd, { completed_count: doneCount });
        changed = true;
      }
    }
  }
}

// =============================================================================
// Validation
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlan(cwd: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const plan = getPlan(cwd);
  if (!plan) {
    return { valid: false, errors: ["No plan found"], warnings: [] };
  }

  const tasks = getTasks(cwd);

  // Check for orphan dependencies
  const taskIds = new Set(tasks.map(t => t.id));
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      if (!taskIds.has(depId)) {
        errors.push(`Task ${task.id} depends on non-existent task ${depId}`);
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(taskId: string): boolean {
    if (recursionStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const depId of task.depends_on) {
        if (hasCycle(depId)) return true;
      }
    }

    recursionStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    visited.clear();
    recursionStack.clear();
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task ${task.id}`);
    }
  }

  // Check for tasks without specs
  for (const task of tasks) {
    const spec = getTaskSpec(cwd, task.id);
    if (!spec || spec.includes("*Spec pending*")) {
      warnings.push(`Task ${task.id} has no detailed spec`);
    }
  }

  // Check plan spec
  const planSpec = getPlanSpec(cwd);
  if (!planSpec || planSpec.includes("*Spec pending*")) {
    warnings.push("Plan has no detailed spec");
  }

  // Check task counts
  if (plan.task_count !== tasks.length) {
    warnings.push(`Plan task_count (${plan.task_count}) doesn't match actual tasks (${tasks.length})`);
  }

  const actualDone = tasks.filter(t => t.status === "done").length;
  if (plan.completed_count !== actualDone) {
    warnings.push(`Plan completed_count (${plan.completed_count}) doesn't match actual (${actualDone})`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// Dependency Graph
// =============================================================================

export function getTransitiveDependents(cwd: string, targetId: string): Task[] {
  const tasks = getTasks(cwd);
  const collected = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const task of tasks) {
      if (collected.has(task.id) || task.id === targetId) continue;
      if (task.depends_on.includes(current)) {
        collected.add(task.id);
        queue.push(task.id);
      }
    }
  }

  return tasks.filter(t => collected.has(t.id));
}

// =============================================================================
// Plan Existence Check
// =============================================================================

export function hasPlan(cwd: string): boolean {
  return getPlan(cwd) !== null;
}
