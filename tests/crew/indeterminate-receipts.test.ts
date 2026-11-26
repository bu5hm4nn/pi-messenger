import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

// Both dispatch draws return the same display name; the unique suffix added at
// dispatch is what fences the stale receipt.
vi.mock("../../lib.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib.ts")>();
  return { ...actual, generateMemorableName: () => "SwiftArrow" };
});

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
      // Ownership is recorded at the launch point (runAgent), which this mock
      // replaces; mirror that before the receipt is classified.
      for (const t of tasks) {
        if (t.taskId) store.claimTaskForDispatch(dirs.cwd, t.taskId, t.workerName!);
      }
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
    store.mutateTask(dirs.cwd, task.id, () => ({ attempt_count: config.work.maxAttemptsPerTask - 1 }));

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) {
          store.claimTaskForDispatch(dirs.cwd, t.taskId, t.workerName!);
          store.startTask(dirs.cwd, t.taskId, t.workerName!);
        }
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
    store.mutateTask(dirs.cwd, task.id, () => ({ attempt_count: config.work.maxAttemptsPerTask - 1 }));

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) {
          store.claimTaskForDispatch(dirs.cwd, t.taskId, t.workerName!);
          store.startTask(dirs.cwd, t.taskId, t.workerName!);
        }
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
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.claimTaskForDispatch(dirs.cwd, t.taskId, t.workerName!);
      }
      return [makeResult(task.id, 1, { error: "crashed before start", workerName: tasks[0]?.workerName })];
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

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (t.taskId) store.claimTaskForDispatch(dirs.cwd, t.taskId, t.workerName!);
      }
      return [makeResult(task.id, 0, { workerName: tasks[0]?.workerName })];
    });

    // Wave 1: the claim charges the single allowed attempt, so the
    // never-started exit releases the reservation and blocks at the cap.
    const wave1 = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    const afterWave1 = store.getTask(dirs.cwd, task.id)!;
    expect(afterWave1.attempt_count).toBe(1);
    expect(afterWave1.status).toBe("blocked");
    expect(wave1.details.blocked ?? []).toEqual([task.id]);
    expect(wave1.details.indeterminate ?? []).toEqual([]);

    // Wave 2: nothing is dispatched for a blocked task and the attempt budget
    // is not charged again.
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
      // Ownership is recorded at launch, not while the queue is built.
      expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBeUndefined();
      store.claimTaskForDispatch(dirs.cwd, task.id, waveAWorker!);
      expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBe(waveAWorker);

      // Wave A claims the task via task.start, then exits without task.done.
      store.startTask(dirs.cwd, task.id, waveAWorker!);
      store.updateTask(dirs.cwd, task.id, { base_commit: "aaa1111" });

      // Before A's receipt is classified, wave B takes the task over (explicit
      // reset clears A's reservation), re-claims and starts it.
      store.resetTask(dirs.cwd, task.id);
      const claimedB = store.claimTaskForDispatch(dirs.cwd, task.id, "WaveBWorker");
      store.startTask(dirs.cwd, task.id, "WaveBWorker", { dispatchToken: claimedB?.dispatch_token });
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
      store.mutateTask(dirs.cwd, task.id, () => ({
        assigned_to: "WaveBWorker",
        attempt_count: 1,
        dispatch_token: "wave-b-reservation",
      }));
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

  it("same display name with a different dispatch suffix is fenced as stale", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    let waveAWorker: string | undefined;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      waveAWorker = tasks[0]?.workerName;
      expect(waveAWorker).toMatch(/^SwiftArrow-[0-9a-f]{4}$/);

      // Wave A launches and claims the task.
      store.claimTaskForDispatch(dirs.cwd, task.id, waveAWorker!);
      store.startTask(dirs.cwd, task.id, waveAWorker!);

      // Wave B re-draws the same memorable name but has its own suffix.
      const waveBWorker = "SwiftArrow-bbbb";
      expect(waveBWorker.startsWith("SwiftArrow")).toBe(true);
      store.resetTask(dirs.cwd, task.id);
      const claimedB = store.claimTaskForDispatch(dirs.cwd, task.id, waveBWorker);
      store.startTask(dirs.cwd, task.id, waveBWorker, { dispatchToken: claimedB?.dispatch_token });
      store.updateTask(dirs.cwd, task.id, { base_commit: "bbb2222" });

      // A's receipt arrives late. Equal display names must not let it pass.
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
    expect(untouched.assigned_to).toBe("SwiftArrow-bbbb");
    expect(untouched.attempt_count).toBe(2);
    expect(untouched.base_commit).toBe("bbb2222");

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain(`Ignored stale result from ${waveAWorker}`);
    expect(progress).toContain("SwiftArrow-bbbb");

    expect(response.details.failed ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);
    expect(response.details.indeterminate ?? []).toEqual([]);
  });

  it("receipt with no worker identity on a mutable task is unattributable: no mutation, ignore note", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    let owner: string | undefined;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      owner = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, owner);
      store.startTask(dirs.cwd, task.id, owner);
      // Legacy/foreign receipt: no workerName, so it cannot be attributed.
      return [makeResult(task.id, 0)];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("in_progress");
    expect(reloaded.assigned_to).toBe(owner);
    expect(reloaded.attempt_count).toBe(1);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Ignored unattributable result from crew-worker");
    expect(progress).not.toContain("Worker exited before task.done");

    expect(response.details.indeterminate ?? []).toEqual([]);
    expect(response.details.failed ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);
  });

  it("final allowed exit-0 in_progress attempt records the reconciliation note with its base commit", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    fs.writeFileSync(
      path.join(dirs.crewDir, "config.json"),
      JSON.stringify({ work: { maxAttemptsPerTask: 1 } }),
    );

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerName);
      store.startTask(dirs.cwd, task.id, workerName);
      store.updateTask(dirs.cwd, task.id, { base_commit: "feedface" });
      return [makeResult(task.id, 0, { workerName })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("blocked");
    expect(reloaded.attempt_count).toBe(1);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("indeterminate: work may have landed");
    expect(progress).toContain("Prior attempt base commit: feedface.");

    expect(response.details.blocked ?? []).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
  });

  it("final allowed non-zero crash attempt records the reconciliation note before blocking", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    fs.writeFileSync(
      path.join(dirs.crewDir, "config.json"),
      JSON.stringify({ work: { maxAttemptsPerTask: 1 } }),
    );

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerName);
      store.startTask(dirs.cwd, task.id, workerName);
      store.updateTask(dirs.cwd, task.id, { base_commit: "feedface" });
      return [makeResult(task.id, 1, { error: "boom", workerName })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("blocked");
    expect(reloaded.attempt_count).toBe(1);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("Worker failed: boom");
    expect(progress).toContain("indeterminate: work may have landed");
    expect(progress).toContain("Prior attempt base commit: feedface.");

    expect(response.details.blocked ?? []).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
  });

  it("never-started crash records the distinct never-started wording and prior base commit", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    store.updateTask(dirs.cwd, task.id, { base_commit: "cafebabe" });

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerName);
      // No task.start: the worker crashed before claiming.
      return [makeResult(task.id, 1, { error: "crashed", workerName })];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id)!;
    expect(reloaded.status).toBe("todo");
    expect(reloaded.attempt_count).toBe(1);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("work may not have started — verify state before retrying.");
    expect(progress).toContain("Worker failed: crashed");
    expect(progress).toContain("Prior attempt base commit: cafebabe.");
    expect(progress).not.toContain("indeterminate: work may have landed");

    expect(response.details.failed ?? []).toEqual([task.id]);
    expect(response.details.indeterminate ?? []).toEqual([]);
    expect(response.details.blocked ?? []).toEqual([]);
  });

  it("cancelled wave leaves queued tasks unassigned and dispatchable", async () => {
    const store = await import("../../crew/store.ts");
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string }>) => {
      // Queue built, but the wave is cancelled before any runAgent launch:
      // ownership must not have been written while building the queue.
      for (const t of tasks) {
        expect(store.getTask(dirs.cwd, t.taskId!)?.assigned_to).toBeUndefined();
      }
      return [];
    });

    const response = await workHandler.execute(
      { action: "work", concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    for (const task of [t1, t2]) {
      const reloaded = store.getTask(dirs.cwd, task.id)!;
      expect(reloaded.status).toBe("todo");
      expect(reloaded.assigned_to).toBeUndefined();
    }

    const ready = store.getReadyTasks(dirs.cwd).map(t => t.id);
    expect(ready).toContain(t1.id);
    expect(ready).toContain(t2.id);
    expect(response.details.succeeded ?? []).toEqual([]);
    expect(response.details.failed ?? []).toEqual([]);
  });
});
