import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dirs, MessengerState } from "../../lib.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
  resolveModel: vi.fn((...models: Array<string | undefined>) => models.find(Boolean)),
}));

vi.mock("../../crew/handlers/review.ts", () => ({
  reviewImplementation: vi.fn(),
}));

function writeAgents(cwd: string): void {
  const agentsDir = path.join(cwd, ".pi", "messenger", "crew", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of ["crew-worker", "crew-reviewer"]) {
    fs.writeFileSync(
      path.join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Test ${name}\n---\nYou are a test ${name}.\n`,
    );
  }
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function makeResult(taskId: string, workerName?: string) {
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
    workerName,
  };
}

describe("auto-review completion attribution", () => {
  let dirs: ReturnType<typeof createTempCrewDirs>;
  let workHandler: typeof import("../../crew/handlers/work.ts");
  let agents: typeof import("../../crew/agents.ts");
  let reviewHandler: typeof import("../../crew/handlers/review.ts");
  let store: typeof import("../../crew/store.ts");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dirs = createTempCrewDirs();
    workHandler = await import("../../crew/handlers/work.ts");
    agents = await import("../../crew/agents.ts");
    reviewHandler = await import("../../crew/handlers/review.ts");
    store = await import("../../crew/store.ts");

    writeAgents(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    vi.mocked(reviewHandler.reviewImplementation).mockResolvedValue({
      content: [{ type: "text", text: "Review" }],
      details: { verdict: "SHIP" },
    } as Awaited<ReturnType<typeof reviewHandler.reviewImplementation>>);
  });

  it("A's exit-0 receipt after B completed is reported but not auto-reviewed", async () => {
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerA = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerA);
      store.startTask(dirs.cwd, task.id, workerA);

      // Worker B takes over in another process and completes first.
      store.updateTask(dirs.cwd, task.id, { status: "todo", assigned_to: undefined });
      store.claimTaskForDispatch(dirs.cwd, task.id, "WorkerB-bbbb");
      store.startTask(dirs.cwd, task.id, "WorkerB-bbbb");
      store.updateTask(dirs.cwd, task.id, { base_commit: "abc12345" });
      store.completeTask(dirs.cwd, task.id, "B landed", undefined, "WorkerB-bbbb");

      // A's exit-0 receipt arrives late, so it is not attributable to the
      // current completion and must not trigger auto-review.
      return [makeResult(task.id, workerA)];
    });
    vi.mocked(reviewHandler.reviewImplementation).mockResolvedValue({
      content: [{ type: "text", text: "Review" }],
      details: { verdict: "NEEDS_WORK" },
    } as Awaited<ReturnType<typeof reviewHandler.reviewImplementation>>);

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(response.details.succeeded).toContain(task.id);
    expect(reviewHandler.reviewImplementation).not.toHaveBeenCalled();

    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("done");
    expect(after.completed_by).toBe("WorkerB-bbbb");
    expect(after.review_count ?? 0).toBe(0);
  });

  it("task.done persists the completing worker identity", async () => {
    const taskHandler = await import("../../crew/handlers/task.ts");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");
    store.claimTaskForDispatch(dirs.cwd, task.id, "WorkerA-1234");
    store.startTask(dirs.cwd, task.id, "WorkerA-1234");

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
  });

  it("A's own completion is still auto-reviewed", async () => {
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerA = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerA);
      store.startTask(dirs.cwd, task.id, workerA);
      store.updateTask(dirs.cwd, task.id, { base_commit: "abc12345" });
      store.completeTask(dirs.cwd, task.id, "A landed", undefined, workerA);
      return [makeResult(task.id, workerA)];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(reviewHandler.reviewImplementation).toHaveBeenCalledWith(dirs.cwd, task.id, undefined);
    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("done");
    expect(after.completed_by).toBeTruthy();
    expect(after.review_count).toBe(1);
    expect(response.details.succeeded).toContain(task.id);
  });

  it("discards an async review verdict when completion attribution changed during review", async () => {
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerA = tasks[0]?.workerName!;
      store.claimTaskForDispatch(dirs.cwd, task.id, workerA);
      store.startTask(dirs.cwd, task.id, workerA);
      store.updateTask(dirs.cwd, task.id, { base_commit: "abc12345" });
      store.completeTask(dirs.cwd, task.id, "A landed", undefined, workerA);
      return [makeResult(task.id, workerA)];
    });
    vi.mocked(reviewHandler.reviewImplementation).mockImplementation(async () => {
      // Another process re-completes the task while the reviewer is running.
      store.updateTask(dirs.cwd, task.id, { completed_by: "WorkerB-bbbb" });
      return {
        content: [{ type: "text", text: "Review" }],
        details: { verdict: "NEEDS_WORK" },
      } as Awaited<ReturnType<typeof reviewHandler.reviewImplementation>>;
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    expect(reviewHandler.reviewImplementation).toHaveBeenCalledTimes(1);

    const after = store.getTask(dirs.cwd, task.id)!;
    expect(after.status).toBe("done");
    expect(after.completed_by).toBe("WorkerB-bbbb");
    expect(after.review_count ?? 0).toBe(0);
    expect(response.details.succeeded).toContain(task.id);
    expect(response.details.failed ?? []).toEqual([]);

    const progress = store.getTaskProgress(dirs.cwd, task.id) ?? "";
    expect(progress).toContain("discarded: completion is no longer attributed");
  });
});
