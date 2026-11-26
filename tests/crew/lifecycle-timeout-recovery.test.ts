import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`);
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function makeResult(taskId: string, dispatchToken: string, workerName: string) {
  return {
    agent: "crew-worker",
    exitCode: 0,
    output: "",
    truncated: false,
    progress: {
      agent: "crew-worker",
      status: "completed" as const,
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
    },
    taskId,
    dispatchToken,
    workerName,
  };
}

function timeoutError(store: typeof import("../../crew/store.ts")) {
  return new store.TaskLockTimeoutError(
    "/tmp/guard",
    ["host-1-marker"],
    "EEXIST",
  );
}

describe("receipt timeout recovery", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
  });

  it("isolates a contended receipt so later receipts still drain", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const first = store.createTask(dirs.cwd, "First task", "Desc");
    const second = store.createTask(dirs.cwd, "Second task", "Desc");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const results = [];
      for (const task of tasks) {
        const claimed = store.claimTaskForDispatch(dirs.cwd, task.taskId!, task.workerName!)!;
        store.startTask(dirs.cwd, task.taskId!, task.workerName!, {
          dispatchToken: claimed.dispatch_token,
        });
        results.push(makeResult(task.taskId!, claimed.dispatch_token!, task.workerName!));
      }
      return results;
    });

    const originalExit = store.exitAttempt.bind(store);
    vi.spyOn(store, "exitAttempt").mockImplementation(((cwd: string, taskId: string, options) => {
      if (taskId === first.id) throw timeoutError(store);
      return originalExit(cwd, taskId, options);
    }) as typeof store.exitAttempt);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    // The first receipt's guard timeout is reported for that task only; the
    // second receipt is still processed and returned to todo.
    expect(response.details.failed).toContain(first.id);
    expect(response.details.indeterminate).toEqual([second.id]);
    expect(store.getTask(dirs.cwd, first.id)?.status).toBe("in_progress");
    expect(store.getTask(dirs.cwd, second.id)?.status).toBe("todo");

    const progress = store.getTaskProgress(dirs.cwd, first.id) ?? "";
    expect(progress).toContain(`Receipt processing failed for ${first.id}`);
    expect(progress).toContain("task guard timeout");
  });

  it("a late reservation mismatch emits no misleading reconcile note", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Racy task", "Desc");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const claimed = store.claimTaskForDispatch(dirs.cwd, task.id, tasks[0].workerName!)!;
      store.startTask(dirs.cwd, task.id, tasks[0].workerName!, {
        dispatchToken: claimed.dispatch_token,
      });
      return [makeResult(task.id, claimed.dispatch_token!, tasks[0].workerName!)];
    });

    const originalExit = store.exitAttempt.bind(store);
    let replaced = false;
    vi.spyOn(store, "exitAttempt").mockImplementation(((cwd: string, taskId: string, options) => {
      if (!replaced && taskId === task.id) {
        replaced = true;
        // A newer reservation lands after the receipt snapshot but before the
        // guarded exit: the exit must refuse without returning a prior snapshot.
        store.resetTask(cwd, taskId);
        const newer = store.claimTaskForDispatch(cwd, taskId, "NewerWorker")!;
        store.startTask(cwd, taskId, "NewerWorker", { dispatchToken: newer.dispatch_token });
      }
      return originalExit(cwd, taskId, options);
    }) as typeof store.exitAttempt);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(replaced).toBe(true);
    expect(progress).not.toContain("indeterminate");
    expect(progress).not.toContain("Worker exited before task.done");
    expect(progress).toContain("Ignored result");
    expect(response.details.indeterminate).toEqual([]);
    expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBe("NewerWorker");
  });

  it("a double timeout leaves a recovery note and counts the warm failure", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const lobby = await import("../../crew/lobby.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Warm task", "Desc");

    vi.spyOn(lobby, "getAvailableLobbyWorkers").mockReturnValue([{
      type: "lobby",
      lobbyId: "lobby-1",
      name: "WarmHolder",
      cwd: dirs.cwd,
      proc: { exitCode: null } as never,
      taskId: "__lobby-1__",
      assignedTaskId: null,
      coordination: "chatty",
      startedAt: Date.now(),
      promptTmpDir: null,
      aliveFile: null,
    }]);
    vi.spyOn(store, "startTask").mockImplementation((() => {
      throw timeoutError(store);
    }) as typeof store.startTask);
    vi.spyOn(store, "releaseDispatch").mockImplementation((() => {
      throw timeoutError(store);
    }) as typeof store.releaseDispatch);
    vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("best-effort release also timed out");
    expect(progress).toContain(task.id);
    expect(progress).toContain("WarmHolder");
    expect(progress).toContain("task.reset");
    // The warm failure is an actual launch outcome, so it counts as attempted
    // and failed rather than disappearing from the wave bookkeeping.
    expect(response.details.attempted).toContain(task.id);
    expect(response.details.failed).toContain(task.id);
    expect(store.getTask(dirs.cwd, task.id)?.dispatch_token).toBeTruthy();
  });

  it("a warm launch failure is not re-selected for the next lobby worker", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const lobby = await import("../../crew/lobby.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const first = store.createTask(dirs.cwd, "First warm task", "Desc");
    const second = store.createTask(dirs.cwd, "Second warm task", "Desc");

    const makeWorker = (name: string, lobbyId: string) => ({
      type: "lobby" as const,
      lobbyId,
      name,
      cwd: dirs.cwd,
      proc: { exitCode: null } as never,
      taskId: `__lobby-${lobbyId}__`,
      assignedTaskId: null,
      coordination: "chatty" as const,
      startedAt: Date.now(),
      promptTmpDir: null,
      aliveFile: null,
    });
    vi.spyOn(lobby, "getAvailableLobbyWorkers").mockReturnValue([
      makeWorker("WarmOne", "lobby-1"),
      makeWorker("WarmTwo", "lobby-2"),
    ]);

    const realClaim = store.claimTaskForDispatch.bind(store);
    const claimedTaskIds: string[] = [];
    let failedFirst = false;
    vi.spyOn(store, "claimTaskForDispatch").mockImplementation(((cwd: string, taskId: string, workerName: string, options) => {
      claimedTaskIds.push(taskId);
      if (taskId === first.id && !failedFirst) {
        failedFirst = true;
        throw timeoutError(store);
      }
      return realClaim(cwd, taskId, workerName, options);
    }) as typeof store.claimTaskForDispatch);
    vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    // First worker fails task one; second worker must select task two, not the
    // task already marked lobbyLaunchFailed.
    expect(claimedTaskIds).toEqual([first.id, second.id]);
    expect(store.getTask(dirs.cwd, first.id)?.dispatch_token).toBeUndefined();
    expect(store.getTask(dirs.cwd, second.id)?.assigned_to).toBe("WarmTwo");
    expect(response.details.attempted).toEqual([first.id, second.id]);
    expect(response.details.failed).toEqual([first.id]);
  });
});
