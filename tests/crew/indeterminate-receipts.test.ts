import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.ts";
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

function makeResult(taskId: string, exitCode = 0, extra: Record<string, unknown> = {}) {
  return {
    agent: "crew-worker",
    exitCode,
    output: "",
    truncated: false,
    progress: {
      agent: "crew-worker",
      status: exitCode === 0 ? ("running" as const) : ("failed" as const),
      recentTools: [],
      toolCallCount: 0,
      tokens: 0,
      durationMs: 0,
    },
    taskId,
    ...extra,
  };
}

describe("crew/indeterminate receipts and crew idle", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
  });

  it("never-started exit (todo, worker never called task.start) consumes an attempt", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    expect(task.attempt_count).toBe(0);

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      // Task stays todo — the worker exited before calling task.start.
      return [makeResult(task.id, 0, { workerName: tasks[0]?.workerName })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.attempt_count).toBe(1);
    expect(response.details.indeterminate).toEqual([task.id]);
    expect(response.details.failed).toEqual([]);
  });

  it("in_progress exit with attempts exhausted blocks and reports blocked, not indeterminate", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    const configModule = await import("../../crew/utils/config.ts");
    const crewDir = path.join(dirs.cwd, ".pi", "messenger", "crew");
    const config = configModule.loadCrewConfig(crewDir);

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    // startTask inside the mock consumes the final attempt, so the
    // classification-time guard (attempt_count >= max) fires in resetInterruptedTask.
    store.updateTask(dirs.cwd, task.id, { attempt_count: config.work.maxAttemptsPerTask - 1 });

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, t.workerName!);
      }
      return tasks.map(t => makeResult(t.taskId!, 0, { workerName: t.workerName }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("blocked");
    expect(reloaded?.attempt_count).toBe(config.work.maxAttemptsPerTask);
    expect(response.details.blocked).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
  });

  it("non-autonomous crash with blocked outcome reports blocked, not failed", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    const configModule = await import("../../crew/utils/config.ts");
    const crewDir = path.join(dirs.cwd, ".pi", "messenger", "crew");
    const config = configModule.loadCrewConfig(crewDir);

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    store.updateTask(dirs.cwd, task.id, { attempt_count: config.work.maxAttemptsPerTask - 1 });

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, t.workerName!);
      }
      return tasks.map(t => makeResult(t.taskId!, 1, { error: "crashed", workerName: t.workerName }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("blocked");
    expect(response.details.blocked).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
    expect(response.details.failed ?? []).toEqual([]);
  });

  it("non-autonomous crash on a never-started todo task consumes an attempt", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    // Non-graceful crash while the task is still todo (worker exited before
    // task.start): must consume an attempt so a crash loop hits
    // maxAttemptsPerTask instead of being bounded only by maxWaves.
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) =>
      [makeResult(task.id, 1, { error: "crashed before start", workerName: tasks[0]?.workerName })]
    );

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.attempt_count).toBe(1);
    expect(response.details.failed ?? []).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
  });

  it("repeated-wave boundary: never-started exits consume attempts until top-of-wave auto-block (max=1)", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    const configModule = await import("../../crew/utils/config.ts");
    const crewDir = path.join(dirs.cwd, ".pi", "messenger", "crew");
    const config = configModule.loadCrewConfig(crewDir);

    writeWorkerAgent(dirs.cwd);
    fs.writeFileSync(path.join(crewDir, "config.json"), JSON.stringify({ work: { maxAttemptsPerTask: 1 } }));

    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) =>
      [makeResult(task.id, 0, { workerName: tasks[0]?.workerName })]
    );

    // Wave 1: never-started exit consumes the single attempt (nextAttempt 1,
    // 1 > 1 is false, so the task stays todo — the NEXT wave blocks).
    const wave1 = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(store.getTask(dirs.cwd, task.id)?.attempt_count).toBe(1);
    expect(wave1.details.indeterminate ?? []).toEqual([task.id]);

    // Wave 2: top-of-wave auto-block fires at attempt_count >= max; no extra
    // worker dispatch happens.
    const wave2 = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("blocked");
    expect(reloaded?.attempt_count).toBe(1);
    expect(wave2.details.blocked ?? []).toEqual([task.id]);
  });

  it("stale result leaves a re-claimed in_progress task untouched and the new owner's task.done succeeds", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    const taskHandler = await import("../../crew/handlers/task.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    let waveAWorker: string | undefined;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      waveAWorker = tasks[0]?.workerName;
      expect(waveAWorker).toBeTruthy();
      // The dispatch side recorded the same identity the receipt will carry.
      expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBe(waveAWorker);

      // Wave A claims the task via task.start, then exits without task.done.
      store.updateTask(dirs.cwd, task.id, {
        status: "in_progress",
        assigned_to: waveAWorker,
        attempt_count: 1,
        base_commit: "aaa1111",
        started_at: new Date().toISOString(),
      });

      // Before A's receipt is classified, wave B re-claims and starts the task.
      store.updateTask(dirs.cwd, task.id, { status: "todo", assigned_to: undefined });
      store.startTask(dirs.cwd, task.id, "WaveBWorker");
      store.updateTask(dirs.cwd, task.id, { base_commit: "bbb2222" });

      return [makeResult(task.id, 1, { error: "wave A crashed", workerName: waveAWorker })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const untouched = store.getTask(dirs.cwd, task.id)!;
    expect(untouched.status).toBe("in_progress");
    expect(untouched.assigned_to).toBe("WaveBWorker");
    expect(untouched.attempt_count).toBe(2);
    expect(untouched.base_commit).toBe("bbb2222");

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Ignored stale result");
    expect(progress).toContain(waveAWorker!);
    expect(progress).toContain("WaveBWorker");

    expect(response.details.failed ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);
    expect(response.details.indeterminate ?? []).toEqual([]);

    // The orphaned-completion scenario: B can still finish because the stale
    // receipt did not reset the task out of in_progress.
    const done = await taskHandler.execute(
      "done",
      { action: "task.done", id: task.id, summary: "Wave B landed" },
      { agentName: "WaveBWorker" } as MessengerState,
      createMockContext(dirs.cwd),
    );
    expect(done.details.error).toBeUndefined();
    expect(store.getTask(dirs.cwd, task.id)?.status).toBe("done");
  });

  it("stale result on a re-claimed todo task does not consume an attempt", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    let waveAWorker: string | undefined;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      waveAWorker = tasks[0]?.workerName;
      // Wave A never claimed the task; it is now owned by wave B's dispatch.
      store.updateTask(dirs.cwd, task.id, { assigned_to: "WaveBWorker", attempt_count: 1 });
      return [makeResult(task.id, 1, { error: "wave A crashed before start", workerName: waveAWorker })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const untouched = store.getTask(dirs.cwd, task.id)!;
    expect(untouched.status).toBe("todo");
    expect(untouched.assigned_to).toBe("WaveBWorker");
    expect(untouched.attempt_count).toBe(1);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Ignored stale result");
    expect(progress).not.toContain("Worker exited before task.start");

    expect(response.details.failed ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);
  });

  it("non-autonomous in_progress crash records the reconciliation note with the prior base commit", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const baseCommit = "1234567890abcdef";

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const dispatched = tasks[0];
      store.startTask(dirs.cwd, dispatched.taskId!, dispatched.workerName!);
      store.updateTask(dirs.cwd, dispatched.taskId!, { base_commit: baseCommit });
      return [makeResult(dispatched.taskId!, 1, { error: "boom", workerName: dispatched.workerName })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("todo");
    expect(reloaded.assigned_to).toBeUndefined();

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Worker failed: boom");
    expect(progress).toContain("indeterminate: work may have landed");
    expect(progress).toContain(`Prior attempt base commit: ${baseCommit}.`);

    expect(response.details.failed ?? []).toEqual([task.id]);
    expect(response.details.blocked ?? []).toEqual([]);
  });

  it("autonomous in_progress crash blocks but records the reconciliation note with the prior base commit", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    const baseCommit = "fedcba0987654321";

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const dispatched = tasks[0];
      store.startTask(dirs.cwd, dispatched.taskId!, dispatched.workerName!);
      store.updateTask(dirs.cwd, dispatched.taskId!, { base_commit: baseCommit });
      return [makeResult(dispatched.taskId!, 1, { error: "crash", workerName: dispatched.workerName })];
    });

    const response = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("blocked");
    expect(reloaded.blocked_reason).toContain("Worker failed: crash");

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Worker crashed: crash");
    expect(progress).toContain("indeterminate: work may have landed");
    expect(progress).toContain(`Prior attempt base commit: ${baseCommit}.`);

    expect(response.details.blocked ?? []).toEqual([task.id]);
  });

  it("getLiveWorkers sees regular spawnAgents workers, not just lobby workers", async () => {
    const registry = await import("../../crew/registry.ts");

    const cwdA = dirs.cwd;
    const cwdB = `${dirs.cwd}-other`;

    const fakeProc = () => ({ exitCode: null, kill: () => {} }) as never;
    const deadProc = () => ({ exitCode: 1, kill: () => {} }) as never;
    const killedProc = () => ({ exitCode: null, killed: true, kill: () => {} }) as never;

    registry.registerWorker({
      type: "worker",
      proc: fakeProc(),
      name: "RegularOne",
      cwd: cwdA,
      taskId: "task-a",
    } as never);
    registry.registerWorker({
      type: "lobby",
      proc: deadProc(),
      name: "LobbyOne",
      cwd: cwdA,
      taskId: "__lobby-a__",
      lobbyId: "a",
      assignedTaskId: null,
      coordination: "none",
      startedAt: Date.now(),
      promptTmpDir: null,
      aliveFile: null,
    } as never);
    registry.registerWorker({
      type: "worker",
      proc: fakeProc(),
      name: "OtherCwd",
      cwd: cwdB,
      taskId: "task-b",
    } as never);

    const live = registry.getLiveWorkers(cwdA);
    expect(live).toHaveLength(1);
    expect(live[0].name).toBe("RegularOne");
    expect(registry.getLobbyWorkers(cwdA)).toHaveLength(1); // dead lobby still listed by type

    // A killed-but-not-yet-exited process counts as live (signal sent ≠ dead).
    registry.registerWorker({
      type: "worker",
      proc: killedProc(),
      name: "KilledButAlive",
      cwd: cwdA,
      taskId: "task-a2",
    } as never);
    expect(registry.getLiveWorkers(cwdA)).toHaveLength(2);

    registry.killAll();
  });
});
