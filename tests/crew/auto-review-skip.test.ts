import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dirs } from "../../lib.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { makeAgentProgress } from "../helpers/agent-progress.ts";

vi.mock("../../crew/agents.ts", () => ({
  spawnAgents: vi.fn(),
  resolveModel: vi.fn((...models: Array<string | undefined>) => models.find(Boolean)),
}));

vi.mock("../../crew/handlers/review.ts", () => ({
  reviewImplementation: vi.fn(),
}));

describe("auto-review skips blocked/duplicate tasks", () => {
  let workHandler: typeof import("../../crew/handlers/work.ts");
  let agents: typeof import("../../crew/agents.ts");
  let reviewHandler: typeof import("../../crew/handlers/review.ts");
  let store: typeof import("../../crew/store.ts");
  let cwd: string;
  let dirs: Dirs;

  beforeEach(async () => {
    vi.resetModules();
    workHandler = await import("../../crew/handlers/work.ts");
    agents = await import("../../crew/agents.ts");
    reviewHandler = await import("../../crew/handlers/review.ts");
    store = await import("../../crew/store.ts");

    cwd = createTempCrewDirs().cwd;
    dirs = {
      base: path.join(cwd, ".pi", "messenger"),
      registry: path.join(cwd, ".pi", "messenger", "registry"),
      inbox: path.join(cwd, ".pi", "messenger", "inbox"),
    };
    fs.mkdirSync(dirs.registry, { recursive: true });
    fs.mkdirSync(dirs.inbox, { recursive: true });
    const agentsDir = path.join(cwd, ".pi", "messenger", "crew", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of ["crew-worker", "crew-reviewer"]) {
      fs.writeFileSync(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Agent\n---\nAgent`);
    }

    vi.mocked(reviewHandler.reviewImplementation).mockResolvedValue({
      content: [{ type: "text", text: "Review" }],
      // reviewImplementation now returns the feedback instead of persisting it;
      // the caller applies it in one guarded mutation.
      details: {
        verdict: "SHIP",
        feedback: {
          verdict: "SHIP",
          summary: "Ship it",
          issues: [],
          suggestions: [],
          reviewed_at: new Date().toISOString(),
        },
      },
    } as Awaited<ReturnType<typeof reviewHandler.reviewImplementation>>);
  });

  afterEach(() => {
    delete process.env.PI_MESSENGER_TEAM_PROFILE_DIR;
  });

  // Simulates a task blocked (e.g. as a duplicate) after the worker exited 0
  // and result processing saw it done — i.e. between result processing and the
  // review dispatch loop. Blocks on the second getTask call for that task.
  function blockAfterResultProcessing(taskId: string, reason: string): void {
    const origGetTask = store.getTask.bind(store);
    let calls = 0;
    vi.spyOn(store, "getTask").mockImplementation((c: string, id: string) => {
      if (id === taskId && ++calls === 2) store.blockTask(c, taskId, reason);
      return origGetTask(c, id);
    });
  }

  function workerResult(taskId: string, workerName: string) {
    return { exitCode: 0, output: "", truncated: false, progress: makeAgentProgress(), agent: "crew-worker", taskId, workerName };
  }

  it("blocked task in succeeded list is not reviewed and gets a feed event", async () => {
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Duplicated work", "Do work");
    blockAfterResultProcessing(task.id, "Duplicate of completed task-1");
    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      const claimed = store.claimTaskForDispatch(cwd, task.id, workerName);
      store.startTask(cwd, task.id, workerName, { dispatchToken: claimed?.dispatch_token });
      store.updateTask(cwd, task.id, { base_commit: "abc123" });
      store.completeTask(cwd, task.id, "Done", undefined, workerName, { dispatchToken: claimed?.dispatch_token });
      return [workerResult(task.id, workerName)];
    });

    const response = await workHandler.execute({}, dirs, createMockContext(cwd), vi.fn());

    expect(reviewHandler.reviewImplementation).not.toHaveBeenCalled();
    expect(response.details.succeeded).toEqual([]);
    expect(response.details.blocked).toContain(task.id);

    const feedPath = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    const events = fs.readFileSync(feedPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const skip = events.find(e => e.type === "task.review" && e.target === task.id);
    expect(skip).toBeDefined();
    expect(skip.preview).toContain("skipped");
    expect(skip.preview).toContain("Duplicate of completed task-1");

    const updated = store.getTask(cwd, task.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.review_count ?? 0).toBe(0);
  });

  it("duplicate blocked_reason variant is skipped even if status was read as done", async () => {
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Duplicate work", "Do work");
    // Task stays status "done" but carries a stale duplicate blocked_reason
    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      const claimed = store.claimTaskForDispatch(cwd, task.id, workerName);
      store.startTask(cwd, task.id, workerName, { dispatchToken: claimed?.dispatch_token });
      store.updateTask(cwd, task.id, { base_commit: "abc123" });
      store.completeTask(cwd, task.id, "Done", undefined, workerName, { dispatchToken: claimed?.dispatch_token });
      return [workerResult(task.id, workerName)];
    });
    const responsePromise = workHandler.execute({}, dirs, createMockContext(cwd), vi.fn());
    // Block as duplicate right before the dispatch loop reads it again
    const origGetTask = store.getTask.bind(store);
    let calls = 0;
    vi.spyOn(store, "getTask").mockImplementation((c: string, id: string) => {
      if (id === task.id && ++calls === 2) {
        origGetTask(c, task.id);
        store.updateTask(c, task.id, { blocked_reason: "DUPLICATE of completed task-9" });
      }
      return origGetTask(c, id);
    });

    await responsePromise;

    expect(reviewHandler.reviewImplementation).not.toHaveBeenCalled();
    const updated = store.getTask(cwd, task.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.review_count ?? 0).toBe(0);
  });

  it("duplicate skip does not block a newer completion that landed before the blocking write", async () => {
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Duplicate work", "Do work");

    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      const a = store.claimTaskForDispatch(cwd, task.id, workerName)!;
      store.startTask(cwd, task.id, workerName, { dispatchToken: a.dispatch_token });
      store.updateTask(cwd, task.id, { base_commit: "abc123" });
      store.completeTask(cwd, task.id, "A landed", undefined, workerName, { dispatchToken: a.dispatch_token });
      // Stale duplicate marker remains on the completed task.
      store.updateTask(cwd, task.id, { blocked_reason: "Duplicate of completed task-9" });
      return [workerResult(task.id, workerName)];
    });

    const originalBlock = store.blockTask.bind(store);
    let swapped = false;
    const blockSpy = vi.spyOn(store, "blockTask").mockImplementation(((
      taskCwd: string,
      taskId: string,
      reason: string,
      fence?: Parameters<typeof store.blockTask>[3],
    ) => {
      if (!swapped && taskId === task.id && fence?.expectedStatus === "done") {
        swapped = true;
        // A newer worker takes over and completes before this stale duplicate
        // branch's blocking mutation runs.
        store.resetTask(taskCwd, taskId);
        const b = store.claimTaskForDispatch(taskCwd, taskId, "WorkerB")!;
        store.startTask(taskCwd, taskId, "WorkerB", { dispatchToken: b.dispatch_token });
        store.completeTask(taskCwd, taskId, "B landed", undefined, "WorkerB", { dispatchToken: b.dispatch_token });
      }
      return originalBlock(taskCwd, taskId, reason, fence);
    }) as typeof store.blockTask);

    try {
      const response = await workHandler.execute({}, dirs, createMockContext(cwd), vi.fn());
      expect(swapped).toBe(true);
      expect(response.details.blocked ?? []).not.toContain(task.id);
    } finally {
      blockSpy.mockRestore();
    }

    const updated = store.getTask(cwd, task.id)!;
    expect(updated.status).toBe("done");
    expect(updated.completed_by).toBe("WorkerB");
    expect(updated.review_count ?? 0).toBe(0);
  });

  it("healthy done tasks are still reviewed (no over-skipping)", async () => {
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Healthy work", "Do work");
    vi.mocked(agents.spawnAgents).mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      const workerName = tasks[0]?.workerName!;
      const claimed = store.claimTaskForDispatch(cwd, task.id, workerName);
      store.startTask(cwd, task.id, workerName, { dispatchToken: claimed?.dispatch_token });
      store.updateTask(cwd, task.id, { base_commit: "abc123" });
      store.completeTask(cwd, task.id, "Done", undefined, workerName, { dispatchToken: claimed?.dispatch_token });
      return [workerResult(task.id, workerName)];
    });

    const response = await workHandler.execute({}, dirs, createMockContext(cwd), vi.fn());

    expect(reviewHandler.reviewImplementation).toHaveBeenCalledWith(cwd, task.id, undefined);
    expect(response.details.succeeded).toContain(task.id);
    expect(store.getTask(cwd, task.id)?.review_count).toBe(1);
  });
});
