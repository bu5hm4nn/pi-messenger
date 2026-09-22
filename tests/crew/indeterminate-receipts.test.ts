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

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      // Task stays todo — the worker exited before calling task.start.
      return [makeResult(task.id)];
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

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => makeResult(t.taskId!, 0));
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

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.startTask(dirs.cwd, t.taskId, "Worker");
      }
      return tasks.map(t => makeResult(t.taskId!, 1, { error: "crashed" }));
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
    vi.spyOn(agents, "spawnAgents").mockImplementation(async () =>
      [makeResult(task.id, 1, { error: "crashed before start" })]
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

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => [makeResult(task.id)]);

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
