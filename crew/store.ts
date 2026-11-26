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

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
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
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
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
): Task | null {
  const guard = acquireTaskGuard(cwd, taskId);
  try {
    const task = getTask(cwd, taskId);
    // A mutation that finds no task file must not write one back: that is how
    // a deleted task gets resurrected.
    if (!task) return null;

    const updates = mutate(task, { guardPath: guard.guardPath, markerName: guard.markerName });
    if (!updates) return null;

    // Pre-publish guard: one stat. If reclaimers removed our marker we look
    // dead, so publishing now would collide with whoever holds the guard.
    if (!fs.existsSync(path.join(guard.guardPath, guard.markerName))) {
      throw new TaskLockLostError(guard.guardPath, guard.markerName);
    }

    const updated: Task = {
      ...task,
      ...updates,
      updated_at: new Date().toISOString(),
      rev: (task.rev ?? 0) + 1,
    };
    writeJson(getTaskPath(cwd, taskId), updated);
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
    // Delete plan.json
    if (fs.existsSync(planPath)) {
      fs.unlinkSync(planPath);
      deleted = true;
    }

    // Delete plan.md
    if (fs.existsSync(planMdPath)) {
      fs.unlinkSync(planMdPath);
    }

    // Delete task files, but never sweep a live guard or an in-flight temp
    // file. A task whose guard is held is skipped: its writer owns it.
    if (fs.existsSync(tasksDir)) {
      const skipped = new Set<string>();
      for (const entry of fs.readdirSync(tasksDir)) {
        if (entry === ".locks" || entry.startsWith(".")) continue;
        if (entry.includes(".tmp-")) continue;
        const fullPath = path.join(tasksDir, entry);
        let isFile = false;
        try { isFile = fs.statSync(fullPath).isFile(); } catch { continue; }
        if (!isFile) continue;

        const taskMatch = entry.match(/^(task-\d+)\./);
        if (taskMatch) {
          const taskId = taskMatch[1];
          if (skipped.has(taskId)) continue;
          const guard = tryAcquireTaskGuard(cwd, taskId);
          if (!guard) {
            skipped.add(taskId);
            continue;
          }
          try { fs.unlinkSync(fullPath); } finally { releaseTaskGuard(guard); }
        } else {
          fs.unlinkSync(fullPath);
        }
      }
    }

    // Delete all block files
    const blocksDir = getBlocksDir(cwd);
    if (fs.existsSync(blocksDir)) {
      for (const file of fs.readdirSync(blocksDir)) {
        try { fs.unlinkSync(path.join(blocksDir, file)); } catch {}
      }
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
      };

      writeJson(taskPath, task);
      break;
    }
  } finally {
    releaseTaskGuard(allocGuard);
  }

  // Create task spec file
  const specContent = description
    ? `# ${title}\n\n${description}\n`
    : `# ${title}\n\n*Spec pending*\n`;
  writeText(getTaskSpecPath(cwd, task.id), specContent);

  // Update plan task count
  const plan = getPlan(cwd);
  if (plan) {
    updatePlan(cwd, { task_count: plan.task_count + 1 });
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
  return {
    ...raw,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    skills: Array.isArray(raw.skills) ? raw.skills.filter(s => typeof s === "string") : undefined,
    role: typeof raw.role === "string" && raw.role.trim().length > 0 ? raw.role : undefined,
    risk_labels: normalizeRiskLabels(Array.isArray(raw.risk_labels) ? raw.risk_labels.filter(s => typeof s === "string") : undefined),
    approval,
    attempt_count: typeof raw.attempt_count === "number" ? raw.attempt_count : 0,
    dispatch_token: typeof raw.dispatch_token === "string" ? raw.dispatch_token : undefined,
    completed_dispatch: typeof raw.completed_dispatch === "string" ? raw.completed_dispatch : undefined,
    rev: typeof raw.rev === "number" ? raw.rev : 0,
    generation: typeof raw.generation === "number" ? raw.generation : 0,
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
  "completed_by",
  "completed_dispatch",
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

export function getTaskSpec(cwd: string, taskId: string): string | null {
  return readText(getTaskSpecPath(cwd, taskId));
}

export function appendTaskProgress(cwd: string, taskId: string, agent: string, message: string): void {
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
  const updated = mutateTask(cwd, taskId, task => {
    assertGeneration(task, options);
    return {
      ...(revision.title ? { title: revision.title } : {}),
      generation: (task.generation ?? 0) + 1,
    };
  });
  if (!updated) return null;
  writeText(getTaskSpecPath(cwd, taskId), revision.spec);
  return updated;
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
    for (const ext of [".json", ".md", ".progress.md"]) {
      try { fs.unlinkSync(path.join(tasksDir, `${taskId}${ext}`)); } catch {}
    }

    try { fs.unlinkSync(path.join(getBlocksDir(cwd), `${taskId}.md`)); } catch {}
  } finally {
    releaseTaskGuard(guard);
  }

  // Dependents: the filter is computed from the task state read *inside* the
  // dependent's mutation, so a dependency added after our snapshot survives.
  for (const t of getTasks(cwd)) {
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
  /** Refuse the claim at/above this many attempts (cap re-checked here). */
  maxAttempts?: number;
}

/**
 * Reserve a todo task for one dispatch. The reservation is the dispatch
 * token; the attempt is charged exactly here, once per dispatch, so a worker
 * that never reaches task.start still consumed its budget.
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
    if (task.dispatch_token) return null;
    const attemptCount = task.attempt_count ?? 0;
    if (attemptCount >= maxAttempts) return null;
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

/**
 * todo -> in_progress. With a dispatch token the start must match the
 * reservation and does not re-charge the attempt; a manual human start mints
 * a session-held token and charges the attempt here.
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
    if (dispatchToken !== undefined) {
      if (task.dispatch_token !== dispatchToken) return null;
    } else if (task.dispatch_token && task.assigned_to !== agentName) {
      // Reserved for another dispatch: only its owner may start it.
      return null;
    }
    const alreadyCharged = task.dispatch_token !== undefined;
    return {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: baseCommit,
      assigned_to: agentName,
      attempt_count: alreadyCharged ? task.attempt_count : task.attempt_count + 1,
      dispatch_token: task.dispatch_token ?? randomUUID(),
    };
  });
}

export interface CompleteOptions {
  /** Dispatch token carried by the worker (PI_CREW_DISPATCH). */
  dispatchToken?: string;
}

/**
 * in_progress -> done. Requires the live reservation (token) or, for callers
 * without a token (lobby/manual), the recorded owner to match.
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
    if (dispatchToken !== undefined) {
      if (task.dispatch_token !== dispatchToken) return null;
    } else if (completedBy !== undefined && task.assigned_to !== completedBy) {
      return null;
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

export function blockTask(
  cwd: string,
  taskId: string,
  reason: string,
  fence?: LifecycleFence,
): Task | null {
  const updated = mutateTask(cwd, taskId, task => {
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
 * dispatch token and the completion attribution.
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

export interface ResetTaskOptions extends LifecycleFence {
  expectedStatus?: TaskStatus;
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
    if (options?.dispatchToken !== undefined && task.dispatch_token !== options.dispatchToken) return null;
    if (options?.owner !== undefined && task.assigned_to !== options.owner) return null;
    wasDone = task.status === "done";
    return {
      status: "todo",
      ...REOPEN_CLEARS,
      // Keep attempt_count for tracking
    };
  });
  if (!updated) return resetTasks;
  resetTasks.push(updated);

  cleanupBlockFiles(cwd, taskId);

  // If cascade, reset all tasks that depend on this one
  if (cascade) {
    const allTasks = getTasks(cwd);
    for (const t of allTasks) {
      if (t.depends_on.includes(taskId) && t.status !== "todo") {
        const cascaded = resetTask(cwd, t.id, true);
        resetTasks.push(...cascaded);
      }
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
  task: Task | null;
}

/**
 * One guarded exit used by every crash/receipt path (work.ts receipts and the
 * lobby close handler). The attempt was already charged at claim, so this
 * only releases the reservation or blocks at the attempt cap -- it never
 * re-charges, and it never touches a task owned by a newer dispatch.
 */
export function exitAttempt(cwd: string, taskId: string, options: ExitAttemptOptions = {}): ExitAttemptResult {
  let outcome: ExitAttemptResult["outcome"] = "changed";
  const updated = mutateTask(cwd, taskId, task => {
    if (options.dispatchToken !== undefined) {
      if (task.dispatch_token !== options.dispatchToken) return null;
    } else if (options.owner !== undefined) {
      if (task.assigned_to !== options.owner) return null;
    }
    if (task.status === "todo") {
      if (!task.dispatch_token) return null;
    } else if (task.status !== "in_progress") {
      return null;
    }

    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if ((task.attempt_count ?? 0) >= maxAttempts) {
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

  if (updated) return { outcome, task: updated };
  return { outcome: getTask(cwd, taskId) ? "changed" : "missing", task: null };
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
  return task.status === "todo" && !task.dispatch_token;
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
        if (!current.milestone || !isDispatchable(current)) return null;
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
