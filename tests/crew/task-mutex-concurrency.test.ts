/**
 * Concurrency hardening tests: directory-mutex task guards and dispatch
 * tokens.
 *
 * The true-concurrent cases run real child processes (tests/helpers/
 * guard-contender.ts) that import crew/store.ts, so acquisition/reclaim races
 * happen against the real filesystem across OS processes. Everything else is a
 * deterministic single-process case.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.ts";
import * as store from "../../crew/store.ts";
import * as agents from "../../crew/agents.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENDER = path.resolve(HERE, "../helpers/guard-contender.ts");

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch {}
  }
  store.setGuardLivenessProbe(null);
  vi.restoreAllMocks();
});

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: crew-worker\ndescription: Test worker\ncrewRole: worker\n---\nYou are a worker.\n`);
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function markerFor(pid: number, host = os.hostname()): string {
  return `${host}-${pid}-${randomUUID()}`;
}

function seedGuard(guardPath: string, markerName: string): void {
  fs.mkdirSync(guardPath, { recursive: true });
  fs.writeFileSync(path.join(guardPath, markerName), JSON.stringify({ pid: "seeded" }));
}

function exitedPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (!result.pid) throw new Error("failed to spawn a short-lived child");
  return result.pid;
}

function startContender(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["--experimental-strip-types", CONTENDER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 20000): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  let stdout = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`contender still running; stdout=${stdout} stderr=${stderr}`)), timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`contender exited ${code}: ${stderr || stdout}`));
    });
    child.once("error", reject);
  });
}

function resultFiles(dir: string, suffix: string): string[] {
  return fs.readdirSync(dir).filter(name => name.endsWith(`.${suffix}.json`));
}

function readResult<T>(dir: string, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as T;
}

function raceDir(dirs: TempCrewDirs): string {
  return fs.mkdtempSync(path.join(dirs.cwd, "guard-race-"));
}

// =============================================================================
// 1. exactly one concurrent acquire holds the guard
// =============================================================================

describe("task guard mutual exclusion", () => {
  it("two barrier-released processes: exactly one holds, the other times out without stealing", async () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const gate = raceDir(dirs);

    const first = startContender(["race", dirs.cwd, task.id, gate]);
    const second = startContender(["race", dirs.cwd, task.id, gate]);
    // Barrier: both processes are already inside acquire when it appears.
    fs.writeFileSync(path.join(gate, "go"), "");
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const held = resultFiles(gate, "held");
    const timedOut = resultFiles(gate, "timeout");
    expect(held).toHaveLength(1);
    expect(timedOut).toHaveLength(1);

    const failure = readResult<{ message: string }>(gate, timedOut[0]);
    expect(failure.message).toContain(store.getTaskGuardPath(dirs.cwd, task.id));
    // The observed marker belongs to the live winner, so its pid is named.
    expect(failure.message).toMatch(/pid \d+/);
    expect(failure.message).toContain("Stop all crew writers for this project");

    // The winner released: the guard directory is gone and the task file is
    // untouched by the mutex.
    expect(fs.existsSync(store.getTaskGuardPath(dirs.cwd, task.id))).toBe(false);
    expect(store.getTask(dirs.cwd, task.id)?.title).toBe("Task one");
  });

  it("an empty guard directory is removable by a contender; a non-empty guard never is", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);

    // Crash between marker unlink and rmdir: an empty guard is free.
    fs.mkdirSync(guardPath, { recursive: true });
    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(true);
    expect(fs.existsSync(guardPath)).toBe(false);

    const guard = store.acquireTaskGuard(dirs.cwd, task.id);
    const marker = guard.markerName;
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);

    // A live local marker is never removed, even by try-acquire.
    expect(store.tryAcquireTaskGuard(dirs.cwd, task.id)).toBeNull();
    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(false);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);

    // Release removes only our marker and the now-empty directory.
    store.releaseTaskGuard(guard);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("times out with the guard path, observed marker, holder pid and recovery sentence", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);
    const marker = markerFor(process.pid); // live holder: ourselves
    seedGuard(guardPath, marker);

    let error: unknown;
    try {
      store.acquireTaskGuard(dirs.cwd, task.id, { timeoutMs: 120, retryMs: 5 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(store.TaskLockTimeoutError);
    const message = (error as Error).message;
    expect(message).toContain(guardPath);
    expect(message).toContain(marker);
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain("Stop all crew writers for this project, then remove the named marker file and the (now empty) guard directory, then retry.");

    // Never force-deleted.
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);
  });
});

// =============================================================================
// 2 + 3 + 4. reclaim only on verified death
// =============================================================================

describe("task guard reclaim", () => {
  it("reclaims a verified-dead marker exactly once, then the loser returns to acquire", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);
    const marker = markerFor(exitedPid());
    seedGuard(guardPath, marker);

    // First reclaimer wins and removes marker + empty guard.
    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(true);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);

    // The loser finds nothing to reclaim (ENOENT) and returns to acquire.
    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(false);

    const guard = store.acquireTaskGuard(dirs.cwd, task.id, { timeoutMs: 500 });
    store.releaseTaskGuard(guard);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("two processes reclaiming a dead guard both eventually acquire; no live guard is swept", async () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);
    const marker = markerFor(exitedPid());
    seedGuard(guardPath, marker);

    const gate = raceDir(dirs);
    const first = startContender(["reclaim", dirs.cwd, task.id, gate]);
    const second = startContender(["reclaim", dirs.cwd, task.id, gate]);
    fs.writeFileSync(path.join(gate, "go"), "");
    await Promise.all([waitForExit(first), waitForExit(second)]);

    // Both observed the dead guard and acquired in turn.
    expect(resultFiles(gate, "held")).toHaveLength(2);
    // At most one call can report the reclaim itself; the loser sees ENOENT or
    // a successor's marker and retries acquisition.
    const reclaims = resultFiles(gate, "reclaim")
      .map(name => readResult<{ reclaimed: boolean }>(gate, name).reclaimed);
    expect(reclaims.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(false);
    expect(fs.existsSync(guardPath)).toBe(false);
  });

  it("an EPERM liveness probe means ALIVE: a dead pid is never stolen", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);
    const marker = markerFor(exitedPid());
    seedGuard(guardPath, marker);

    store.setGuardLivenessProbe(() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(false);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);
    expect(() => store.acquireTaskGuard(dirs.cwd, task.id, { timeoutMs: 100 }))
      .toThrow(store.TaskLockTimeoutError);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);
  });

  it("a marker from another host means ALIVE even when its pid is dead here", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const guardPath = store.getTaskGuardPath(dirs.cwd, task.id);
    const marker = markerFor(exitedPid(), "some-foreign-host");
    seedGuard(guardPath, marker);

    expect(store.tryReclaimTaskGuard(dirs.cwd, task.id)).toBe(false);
    expect(fs.existsSync(path.join(guardPath, marker))).toBe(true);
    expect(store.tryAcquireTaskGuard(dirs.cwd, task.id)).toBeNull();
  });
});

// =============================================================================
// 5. pre-publish guard check
// =============================================================================

describe("pre-publish guard check", () => {
  it("a holder whose marker was removed aborts instead of publishing", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    let guardPath = "";
    expect(() => store.mutateTask(dirs.cwd, task.id, (current, guard) => {
      guardPath = guard.guardPath;
      // Simulate a reclaimer that judged this holder dead and removed its
      // marker while the mutator was computing updates.
      fs.unlinkSync(path.join(guard.guardPath, guard.markerName));
      return { title: "Published over a new holder" };
    })).toThrow(store.TaskLockLostError);

    expect(store.getTask(dirs.cwd, task.id)?.title).toBe("Task one");
    // Release must not touch anything after an ENOENT unlink, so the now-empty
    // guard stays and a later contender removes it when it acquires.
    expect(fs.existsSync(guardPath)).toBe(true);
    const next = store.acquireTaskGuard(dirs.cwd, task.id, { timeoutMs: 500 });
    store.releaseTaskGuard(next);
    expect(fs.existsSync(guardPath)).toBe(false);
  });
});

// =============================================================================
// 6. dispatch reservation
// =============================================================================

describe("dispatch claim reservation", () => {
  it("reserves the task once, hides it from ready tasks, and never re-charges at start", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const other = store.createTask(dirs.cwd, "Task two", "Desc two");

    const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA", { maxAttempts: 3 });
    expect(claimed?.status).toBe("todo");
    expect(claimed?.dispatch_token).toBeTruthy();
    expect(claimed?.attempt_count).toBe(1);

    // Second dispatch of the same todo is refused.
    expect(store.claimTaskForDispatch(dirs.cwd, task.id, "WaveB", { maxAttempts: 3 })).toBeNull();

    // Reserved tasks are not ready to launch.
    const readyIds = store.getReadyTasks(dirs.cwd).map(t => t.id);
    expect(readyIds).not.toContain(task.id);
    expect(readyIds).toContain(other.id);

    // A start must match the reservation and does not charge again.
    expect(store.startTask(dirs.cwd, task.id, "WaveB", { dispatchToken: "not-the-token" })).toBeNull();
    const started = store.startTask(dirs.cwd, task.id, "WaveA", { dispatchToken: claimed!.dispatch_token });
    expect(started?.status).toBe("in_progress");
    expect(started?.attempt_count).toBe(1);

    // Completion is fenced by the same token and records the attribution.
    expect(store.completeTask(dirs.cwd, task.id, "x", undefined, "WaveA", { dispatchToken: "not-the-token" })).toBeNull();
    const completed = store.completeTask(dirs.cwd, task.id, "Done", undefined, "WaveA", {
      dispatchToken: claimed!.dispatch_token,
    });
    expect(completed?.status).toBe("done");
    expect(completed?.completed_dispatch).toBe(claimed!.dispatch_token);
    expect(completed?.dispatch_token).toBeUndefined();
  });

  it("re-checks the attempt cap at claim: a queued task at equality is refused, not launched", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    store.mutateTask(dirs.cwd, task.id, () => ({ attempt_count: 3 }));

    expect(store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA", { maxAttempts: 3 })).toBeNull();
    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("todo");
    expect(after.attempt_count).toBe(3);
    expect(after.dispatch_token).toBeUndefined();

    // Below the cap the same claim succeeds and charges once.
    expect(store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA", { maxAttempts: 4 })?.attempt_count).toBe(4);
  });

  it("releaseDispatch drops only a matching reservation (failed launch cleanup)", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA")!;

    expect(store.releaseDispatch(dirs.cwd, task.id, "different-token")).toBeNull();
    expect(store.getTask(dirs.cwd, task.id)?.dispatch_token).toBe(claimed.dispatch_token);

    const released = store.releaseDispatch(dirs.cwd, task.id, claimed.dispatch_token!);
    expect(released?.dispatch_token).toBeUndefined();
    expect(released?.assigned_to).toBeUndefined();
    expect(released?.status).toBe("todo");
    // The charge stays: the attempt was used by the failed launch.
    expect(released?.attempt_count).toBe(1);
  });
});

// =============================================================================
// 7. stale receipt end-to-end with identical worker names, different tokens
// =============================================================================

describe("stale receipt fencing by dispatch token", () => {
  it("a stale receipt from a re-claimed dispatch leaves the newer attempt intact", async () => {
    const dirs = createTempCrewDirs();
    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const workHandler = await import("../../crew/handlers/work.ts");

    let staleToken: string | undefined;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      // Wave A claims and starts with identity "SameWorker".
      const a = store.claimTaskForDispatch(dirs.cwd, task.id, "SameWorker", { maxAttempts: 5 })!;
      staleToken = a.dispatch_token;
      store.startTask(dirs.cwd, task.id, "SameWorker", { dispatchToken: a.dispatch_token });

      // Wave B takes over with the SAME display name but its own reservation.
      store.resetTask(dirs.cwd, task.id);
      const b = store.claimTaskForDispatch(dirs.cwd, task.id, "SameWorker", { maxAttempts: 5 })!;
      store.startTask(dirs.cwd, task.id, "SameWorker", { dispatchToken: b.dispatch_token });

      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: { agent: "crew-worker", status: "failed" as const, recentTools: [], toolCallCount: 0, tokens: 0, durationMs: 0 },
        taskId: task.id,
        workerName: "SameWorker",
        dispatchToken: staleToken,
        error: "wave A crashed",
      }];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const untouched = store.getTask(dirs.cwd, task.id)!;
    expect(untouched.status).toBe("in_progress");
    expect(untouched.assigned_to).toBe("SameWorker");
    expect(untouched.attempt_count).toBe(2);
    expect(untouched.dispatch_token).not.toBe(staleToken);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Ignored stale result from dispatch");
    expect(response.details.failed ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);

    // B still completes with its own token.
    const done = store.completeTask(dirs.cwd, task.id, "B landed", undefined, "SameWorker", {
      dispatchToken: untouched.dispatch_token,
    });
    expect(done?.status).toBe("done");
    expect(done?.completed_dispatch).toBe(untouched.dispatch_token);
    expect(done?.completed_dispatch).not.toBe(staleToken);
  });
});

// =============================================================================
// 8. review attribution in one guarded mutation
// =============================================================================

describe("review application attribution", () => {
  function doneTask(cwd: string, owner: string): { taskId: string; token?: string } {
    const task = store.createTask(cwd, `Task ${owner}`, "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, owner)!;
    store.startTask(cwd, task.id, owner, { baseCommit: "abc123", dispatchToken: claimed.dispatch_token });
    store.completeTask(cwd, task.id, "Done", undefined, owner);
    return { taskId: task.id, token: claimed.dispatch_token };
  }

  const feedback = (verdict: "SHIP" | "NEEDS_WORK" | "MAJOR_RETHINK") => ({
    verdict,
    summary: `Review says ${verdict}`,
    issues: verdict === "SHIP" ? [] : ["Issue one"],
    suggestions: [],
    reviewed_at: new Date().toISOString(),
  });

  it("discards feedback and verdict when the completion attribution changed", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const { taskId } = doneTask(dirs.cwd, "WorkerA");

    const discarded = store.applyReview(dirs.cwd, taskId, feedback("NEEDS_WORK"), {
      status: "done",
      dispatchToken: "some-other-dispatch",
    });
    expect(discarded).toBeNull();

    const after = store.getTask(dirs.cwd, taskId)!;
    expect(after.status).toBe("done");
    expect(after.review_count ?? 0).toBe(0);
    expect(after.last_review).toBeUndefined();
  });

  it("applies feedback, review_count and the NEEDS_WORK reset together for the owning completion", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const { taskId, token } = doneTask(dirs.cwd, "WorkerA");

    const applied = store.applyReview(dirs.cwd, taskId, feedback("NEEDS_WORK"), {
      status: "done",
      dispatchToken: token,
    });
    expect(applied).not.toBeNull();

    const after = store.getTask(dirs.cwd, taskId)!;
    expect(after.status).toBe("todo");
    expect(after.review_count).toBe(1);
    expect(after.last_review?.verdict).toBe("NEEDS_WORK");
    expect(after.completed_by).toBeUndefined();
    expect(after.completed_dispatch).toBeUndefined();
    expect(store.getReadyTasks(dirs.cwd).map(t => t.id)).toContain(taskId);
  });

  it("does not reset a different worker's completion (B's takeover survives A's NEEDS_WORK)", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Shared", "Desc");
    const a = store.claimTaskForDispatch(dirs.cwd, task.id, "WorkerA")!;
    store.startTask(dirs.cwd, task.id, "WorkerA", { dispatchToken: a.dispatch_token });
    store.completeTask(dirs.cwd, task.id, "A landed", undefined, "WorkerA");

    // B takes over and completes before A's review is applied.
    store.resetTask(dirs.cwd, task.id);
    const b = store.claimTaskForDispatch(dirs.cwd, task.id, "WorkerB")!;
    store.startTask(dirs.cwd, task.id, "WorkerB", { dispatchToken: b.dispatch_token });
    store.completeTask(dirs.cwd, task.id, "B landed", undefined, "WorkerB");

    expect(store.applyReview(dirs.cwd, task.id, feedback("NEEDS_WORK"), {
      status: "done",
      dispatchToken: a.dispatch_token,
    })).toBeNull();

    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("done");
    expect(after.completed_by).toBe("WorkerB");
    expect(after.review_count ?? 0).toBe(0);
    expect(after.last_review).toBeUndefined();
  });
});

// =============================================================================
// 9. dependent-list closures compute under the guard
// =============================================================================

describe("dependent list interleave", () => {
  it("deleteTask preserves a dependency that lands while it waits for the dependent's guard", async () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Foundation", "Desc");
    const t2 = store.createTask(dirs.cwd, "Dependent", "Desc", [t1.id]);
    const t3 = store.createTask(dirs.cwd, "New dependency", "Desc");

    const gate = raceDir(dirs);
    const holder = startContender(["hold", dirs.cwd, t2.id, gate, t3.id]);

    // Wait until the other process holds t2's guard inside its mutation.
    await waitFor(() => resultFiles(gate, "inside").length === 1, "contender to hold the guard");

    // deleteTask snapshots dependents, then blocks on t2's guard. When it gets
    // the guard the closure must read the updated list, not the snapshot.
    expect(store.deleteTask(dirs.cwd, t1.id)).toBe(true);

    await waitForExit(holder);

    const dependent = store.getTask(dirs.cwd, t2.id)!;
    expect(dependent.depends_on).toEqual([t3.id]);
    expect(store.getTask(dirs.cwd, t1.id)).toBeNull();
    expect(store.getTask(dirs.cwd, t3.id)).not.toBeNull();
  });

  it("a guarded dependency write (revise/plan path) does not publish a stale list", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc");

    // Snapshot taken outside the guard (what a naive update would publish).
    const staleSnapshot = store.getTask(dirs.cwd, task.id)!;

    // A concurrent writer adds a dependency under the guard.
    store.mutateTask(dirs.cwd, task.id, current => ({
      depends_on: [...current.depends_on, "task-99"],
    }));

    // The guarded transform recomputes from the current state.
    store.mutateTask(dirs.cwd, task.id, current => ({
      depends_on: current.depends_on.filter(dep => dep !== "task-42"),
    }));

    const after = store.getTask(dirs.cwd, task.id)!;
    expect(staleSnapshot.depends_on).toEqual([]);
    expect(after.depends_on).toEqual(["task-99"]);
  });
});

// =============================================================================
// lifecycle guards that do not need a child process
// =============================================================================

describe("lifecycle mutation guards", () => {
  it("exitAttempt never touches a task reserved by a different dispatch", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA")!;

    const result = store.exitAttempt(dirs.cwd, task.id, {
      owner: "WaveB",
      dispatchToken: "wrong-token",
      maxAttempts: 5,
    });
    expect(result.outcome).toBe("changed");
    expect(store.getTask(dirs.cwd, task.id)?.dispatch_token).toBe(claimed.dispatch_token);
  });

  it("manual task.start mints a session token and charges the attempt once", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    const started = store.startTask(dirs.cwd, task.id, "Human", { baseCommit: "abc123" });
    expect(started?.status).toBe("in_progress");
    expect(started?.dispatch_token).toBeTruthy();
    expect(started?.attempt_count).toBe(1);

    // A human task.done without a token is fenced by the recorded owner.
    expect(store.completeTask(dirs.cwd, task.id, "x", undefined, "OtherHuman")).toBeNull();
    expect(store.completeTask(dirs.cwd, task.id, "Done", undefined, "Human")?.status).toBe("done");
  });

  it("reset and unblock are explicit takeovers that invalidate the active token", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, "WaveA")!;
    store.startTask(dirs.cwd, task.id, "WaveA", { dispatchToken: claimed.dispatch_token });

    store.resetTask(dirs.cwd, task.id);
    const reset = store.getTask(dirs.cwd, task.id)!;
    expect(reset.status).toBe("todo");
    expect(reset.dispatch_token).toBeUndefined();
    expect(reset.assigned_to).toBeUndefined();

    const blocked = store.blockTask(dirs.cwd, task.id, "Later");
    expect(blocked?.status).toBe("blocked");
    const unblocked = store.unblockTask(dirs.cwd, task.id);
    expect(unblocked?.status).toBe("todo");
    expect(unblocked?.dispatch_token).toBeUndefined();
  });

  it("a mutation on a deleted task must not resurrect it", () => {
    const dirs = createTempCrewDirs();
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    expect(store.deleteTask(dirs.cwd, task.id)).toBe(true);

    expect(store.mutateTask(dirs.cwd, task.id, () => ({ title: "Zombie" }))).toBeNull();
    expect(store.getTask(dirs.cwd, task.id)).toBeNull();
  });

  it("task.done persists the completing worker identity and dispatch", async () => {
    const dirs = createTempCrewDirs();
    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, "WorkerA-1234")!;
    store.startTask(dirs.cwd, task.id, "WorkerA-1234", { dispatchToken: claimed.dispatch_token });

    const taskHandler = await import("../../crew/handlers/task.ts");
    const response = await taskHandler.execute(
      "done",
      { action: "task.done", id: task.id, summary: "Done" },
      { agentName: "WorkerA-1234" } as MessengerState,
      createMockContext(dirs.cwd),
    );

    expect(response.details.error).toBeUndefined();
    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("done");
    expect(after.completed_by).toBe("WorkerA-1234");
    expect(after.completed_dispatch).toBe(claimed.dispatch_token);
  });
});
