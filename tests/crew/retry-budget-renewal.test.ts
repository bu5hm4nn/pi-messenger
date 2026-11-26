import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../../crew/store.ts";
import { executeTaskAction } from "../../crew/task-actions.ts";
import { buildWorkerPrompt } from "../../crew/prompt.ts";
import { loadCrewConfig } from "../../crew/utils/config.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";
import { createMockContext } from "../helpers/mock-context.ts";

const CAP = 5;

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

function makeResult(taskId: string, exitCode: number, extra: Record<string, unknown> = {}) {
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

function seedAttempts(cwd: string, taskId: string, attempts: number, baseline?: number): void {
  store.mutateTask(cwd, taskId, () => ({
    attempt_count: attempts,
    ...(baseline === undefined ? {} : { budget_baseline: baseline }),
  }));
}

describe("crew/retry budget renewal", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
  });

  it("explicit reset at the cap renews the budget: next claim is lifetime attempt 6 and the prompt shows attempt 6", () => {
    const task = store.createTask(cwd, "Flaky task", "Desc");
    seedAttempts(cwd, task.id, CAP);
    store.blockTask(cwd, task.id, `Max attempts (${CAP}) reached`);

    const atCap = store.getTask(cwd, task.id)!;
    expect(atCap.status).toBe("blocked");
    expect(store.attemptsSinceReset(atCap)).toBe(CAP);
    expect(store.getReadyTasks(cwd).map(t => t.id)).not.toContain(task.id);

    const result = executeTaskAction(cwd, "reset", task.id, "Operator");
    expect(result.success).toBe(true);

    const renewed = store.getTask(cwd, task.id)!;
    expect(renewed.status).toBe("todo");
    expect(renewed.blocked_reason).toBeUndefined();
    expect(renewed.attempt_count).toBe(CAP); // lifetime number is not rewritten
    expect(renewed.budget_baseline).toBe(CAP);
    expect(store.attemptsSinceReset(renewed)).toBe(0);
    expect(store.getReadyTasks(cwd).map(t => t.id)).toContain(task.id);

    // The wave builds the prompt from the pre-claim snapshot: lifetime 5 means
    // the next (sixth) lifetime attempt is announced, not a reset to 1.
    const prompt = buildWorkerPrompt(
      renewed,
      "docs/PRD.md",
      cwd,
      loadCrewConfig(store.getCrewDir(cwd)),
      [],
    );
    expect(prompt).toContain("**Attempt:** 6");

    const claimed = store.claimTaskForDispatch(cwd, task.id, "WaveA", { maxAttempts: CAP });
    expect(claimed?.attempt_count).toBe(6);
    expect(claimed?.budget_baseline).toBe(CAP);
    expect(claimed && store.attemptsSinceReset(claimed)).toBe(1);
  });

  it("renewed budget is exhausted after five more never-started crashes; a second explicit reset renews again", () => {
    const task = store.createTask(cwd, "Crash looping task", "Desc");
    seedAttempts(cwd, task.id, CAP);
    store.blockTask(cwd, task.id, `Max attempts (${CAP}) reached`);
    expect(executeTaskAction(cwd, "reset", task.id, "Operator").success).toBe(true);

    for (let i = 1; i <= CAP; i++) {
      const claimed = store.claimTaskForDispatch(cwd, task.id, `Worker${i}`, { maxAttempts: CAP });
      expect(claimed).not.toBeNull();
      expect(claimed?.attempt_count).toBe(CAP + i);
      expect(claimed?.budget_baseline).toBe(CAP);
      expect(claimed && store.attemptsSinceReset(claimed)).toBe(i);

      // todo + reservation means the worker crashed before task.start: the
      // shared guarded exit consumes the claim and only resets or cap-blocks.
      const exit = store.exitAttempt(cwd, task.id, {
        owner: `Worker${i}`,
        dispatchToken: claimed!.dispatch_token,
        maxAttempts: CAP,
      });
      expect(exit.outcome).toBe(i < CAP ? "todo" : "blocked");
      expect(exit.task?.budget_baseline).toBe(CAP); // never renewed by recovery
    }

    const exhausted = store.getTask(cwd, task.id)!;
    expect(exhausted.status).toBe("blocked");
    expect(exhausted.blocked_reason).toContain(`Max attempts (${CAP})`);
    expect(exhausted.attempt_count).toBe(10); // lifetime, never rewritten
    expect(exhausted.budget_baseline).toBe(CAP);
    expect(store.attemptsSinceReset(exhausted)).toBe(CAP);
    expect(store.claimTaskForDispatch(cwd, task.id, "TooLate", { maxAttempts: CAP })).toBeNull();

    const second = executeTaskAction(cwd, "reset", task.id, "Operator");
    expect(second.success).toBe(true);
    const renewedAgain = store.getTask(cwd, task.id)!;
    expect(renewedAgain.status).toBe("todo");
    expect(renewedAgain.attempt_count).toBe(10);
    expect(renewedAgain.budget_baseline).toBe(10);
    expect(store.attemptsSinceReset(renewedAgain)).toBe(0);
  });

  it("NEEDS_WORK review bounce at the cap never renews: the next wave re-blocks without a baseline", async () => {
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    writeWorkerAgent(cwd);
    const task = store.createTask(cwd, "Reviewed task", "Desc");

    for (let i = 1; i <= CAP; i++) {
      expect(store.startTask(cwd, task.id, "WorkerA")?.attempt_count).toBe(i);
      expect(store.completeTask(cwd, task.id, `Attempt ${i}`, undefined, "WorkerA")?.status).toBe("done");
      if (i < CAP) {
        // Automatic review bounce between attempts: never renews the budget.
        const bounce = store.applyReview(cwd, task.id, {
          verdict: "NEEDS_WORK",
          summary: `Attempt ${i} needs work`,
          issues: [],
          suggestions: [],
          reviewed_at: new Date().toISOString(),
        }, { status: "done", owner: "WorkerA" });
        expect(bounce?.status).toBe("todo");
        expect(bounce?.budget_baseline).toBeUndefined();
      }
    }
    const done = store.getTask(cwd, task.id)!;
    expect(done.status).toBe("done");
    expect(done.attempt_count).toBe(CAP);
    expect(done.budget_baseline).toBeUndefined();

    const applied = store.applyReview(cwd, task.id, {
      verdict: "NEEDS_WORK",
      summary: "Still broken",
      issues: ["fix it"],
      suggestions: [],
      reviewed_at: new Date().toISOString(),
    }, { status: "done", owner: "WorkerA" });
    expect(applied?.status).toBe("todo");
    expect(applied?.attempt_count).toBe(CAP);
    expect(applied?.budget_baseline).toBeUndefined();

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);
    const response = await workHandler.execute(
      { action: "work" },
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    const rebounced = store.getTask(cwd, task.id)!;
    expect(rebounced.status).toBe("blocked");
    expect(rebounced.blocked_reason).toContain(`Max attempts (${CAP})`);
    expect(rebounced.attempt_count).toBe(CAP);
    expect(rebounced.budget_baseline).toBeUndefined();
    expect(store.attemptsSinceReset(rebounced)).toBe(CAP);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain("No ready tasks");
  });

  it("crash-recovery reset leaves budget_baseline untouched", async () => {
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    writeWorkerAgent(cwd);
    const task = store.createTask(cwd, "Crashing task", "Desc");
    seedAttempts(cwd, task.id, CAP, CAP); // fresh budget after a prior explicit reset

    vi.spyOn(agents, "spawnAgents").mockImplementation(async (tasks: Array<{ taskId?: string; workerName?: string }>) => {
      for (const t of tasks) {
        if (!t.taskId) continue;
        const claimed = store.claimTaskForDispatch(cwd, t.taskId, t.workerName!, { maxAttempts: CAP });
        store.startTask(cwd, t.taskId, t.workerName!, { dispatchToken: claimed?.dispatch_token });
      }
      return tasks.map(t => makeResult(t.taskId!, 1, { workerName: t.workerName }));
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    const recovered = store.getTask(cwd, task.id)!;
    expect(recovered.status).toBe("todo"); // non-autonomous crash recovery reset
    expect(recovered.attempt_count).toBe(CAP + 1);
    expect(recovered.budget_baseline).toBe(CAP); // unchanged by recovery
    expect(store.attemptsSinceReset(recovered)).toBe(1);
    expect(response.details.failed).toEqual([task.id]);
  });

  it("exit resets (the shared lobby close path) leave budget_baseline untouched", () => {
    const task = store.createTask(cwd, "Orphaned task", "Desc");
    seedAttempts(cwd, task.id, 6, CAP);
    store.mutateTask(cwd, task.id, () => ({
      status: "in_progress",
      assigned_to: "LobbyWorker",
      dispatch_token: "lobby-dispatch-token",
    }));

    const exit = store.exitAttempt(cwd, task.id, {
      owner: "LobbyWorker",
      dispatchToken: "lobby-dispatch-token",
      maxAttempts: CAP,
    });

    expect(exit.outcome).toBe("todo");
    expect(exit.task?.status).toBe("todo");
    expect(exit.task?.attempt_count).toBe(6);
    expect(exit.task?.budget_baseline).toBe(CAP);
    expect(exit.task && store.attemptsSinceReset(exit.task)).toBe(1);
  });

  it("legacy records without a baseline keep lifetime accounting until an explicit reset", () => {
    const task = store.createTask(cwd, "Legacy task", "Desc");
    seedAttempts(cwd, task.id, CAP);

    const legacy = store.getTask(cwd, task.id)!;
    expect(legacy.budget_baseline).toBeUndefined();
    expect(store.attemptsSinceReset(legacy)).toBe(CAP); // lifetime = budget

    const blocked = store.blockTask(cwd, task.id, `Max attempts (${CAP}) reached`, {
      expectedStatus: "todo",
      requireNoDispatchToken: true,
      minAttemptCount: CAP,
    });
    expect(blocked?.status).toBe("blocked");
    expect(store.claimTaskForDispatch(cwd, task.id, "WaveA", { maxAttempts: CAP })).toBeNull();

    expect(executeTaskAction(cwd, "reset", task.id, "Operator").success).toBe(true);
    const migrated = store.getTask(cwd, task.id)!;
    expect(migrated.budget_baseline).toBe(CAP);
    expect(migrated.attempt_count).toBe(CAP);
    expect(store.attemptsSinceReset(migrated)).toBe(0);
  });

  it("cascade-reset gives each actually-reset task its own baseline and leaves others untouched", () => {
    const root = store.createTask(cwd, "Root", "Desc");
    const child = store.createTask(cwd, "Child", "Desc", [root.id]);
    const grandchild = store.createTask(cwd, "Grandchild", "Desc", [child.id]);
    const todoDependent = store.createTask(cwd, "Todo dependent", "Desc", [root.id]);
    const unrelated = store.createTask(cwd, "Unrelated", "Desc");

    store.mutateTask(cwd, root.id, () => ({ status: "done", attempt_count: 2 }));
    store.mutateTask(cwd, child.id, () => ({ status: "done", attempt_count: 3 }));
    store.mutateTask(cwd, grandchild.id, () => ({ status: "done", attempt_count: 4 }));
    store.mutateTask(cwd, todoDependent.id, () => ({ status: "todo", attempt_count: 1 }));
    store.mutateTask(cwd, unrelated.id, () => ({ status: "done", attempt_count: 7 }));

    const result = executeTaskAction(cwd, "cascade-reset", root.id, "Operator");
    expect(result.success).toBe(true);
    expect(new Set(result.resetTasks?.map(t => t.id))).toEqual(new Set([root.id, child.id, grandchild.id]));

    expect(store.getTask(cwd, root.id)).toMatchObject({ status: "todo", attempt_count: 2, budget_baseline: 2 });
    expect(store.getTask(cwd, child.id)).toMatchObject({ status: "todo", attempt_count: 3, budget_baseline: 3 });
    expect(store.getTask(cwd, grandchild.id)).toMatchObject({ status: "todo", attempt_count: 4, budget_baseline: 4 });

    // A dependent already in todo is not reset, so it gains no baseline.
    const skipped = store.getTask(cwd, todoDependent.id)!;
    expect(skipped.status).toBe("todo");
    expect(skipped.attempt_count).toBe(1);
    expect(skipped.budget_baseline).toBeUndefined();

    const untouched = store.getTask(cwd, unrelated.id)!;
    expect(untouched.status).toBe("done");
    expect(untouched.attempt_count).toBe(7);
    expect(untouched.budget_baseline).toBeUndefined();
  });

  it("store dispatch and the shared exit refuse at since-reset equality", () => {
    const task = store.createTask(cwd, "At cap after renewal", "Desc");
    seedAttempts(cwd, task.id, 10, CAP);

    expect(store.attemptsSinceReset(store.getTask(cwd, task.id)!)).toBe(CAP);
    const refused = store.claimTaskForDispatch(cwd, task.id, "WaveA", { maxAttempts: CAP });
    expect(refused).toBeNull();
    const unchanged = store.getTask(cwd, task.id)!;
    expect(unchanged.attempt_count).toBe(10);

    store.mutateTask(cwd, task.id, () => ({
      status: "in_progress",
      assigned_to: "LobbyWorker",
      dispatch_token: "dispatch-token",
    }));
    const exit = store.exitAttempt(cwd, task.id, {
      owner: "LobbyWorker",
      dispatchToken: "dispatch-token",
      maxAttempts: CAP,
    });
    expect(exit.outcome).toBe("blocked");
    expect(exit.task?.status).toBe("blocked");
    expect(exit.task?.budget_baseline).toBe(CAP);
  });

  it("wave-start cap-block compares attempts since the reset, not lifetime attempts", async () => {
    const agents = await import("../../crew/agents.ts");
    const workHandler = await import("../../crew/handlers/work.ts");
    writeWorkerAgent(cwd);

    // Lifetime 10 is above the cap, but only 4 attempts belong to this budget.
    const inBudget = store.createTask(cwd, "Still in budget", "Desc");
    seedAttempts(cwd, inBudget.id, 10, 6);
    // Lifetime 10 with baseline 5 is exactly at the cap: it must auto-block.
    const atCap = store.createTask(cwd, "At cap", "Desc");
    seedAttempts(cwd, atCap.id, 10, CAP);

    const spawnSpy = vi.spyOn(agents, "spawnAgents").mockResolvedValue([]);
    const response = await workHandler.execute(
      { action: "work" },
      createDirs(cwd),
      createMockContext(cwd),
      () => {},
    );

    const notBlocked = store.getTask(cwd, inBudget.id)!;
    expect(notBlocked.status).toBe("todo");
    expect(notBlocked.blocked_reason).toBeUndefined();
    expect(notBlocked.attempt_count).toBe(10);
    expect(notBlocked.budget_baseline).toBe(6);

    const blocked = store.getTask(cwd, atCap.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_reason).toContain(`Max attempts (${CAP})`);
    expect(blocked.attempt_count).toBe(10);
    expect(blocked.budget_baseline).toBe(CAP);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(response.details.attempted).toEqual([inBudget.id]);
    // Auto-blocked-before-dispatch tasks are persisted but are not worker
    // results, so they never enter the wave's blocked receipt list.
  });

  it("lifetime attempt_count keeps increasing across renewals (completion-import compatibility)", () => {
    const task = store.createTask(cwd, "Long lived task", "Desc");
    seedAttempts(cwd, task.id, CAP);

    const observed = [store.getTask(cwd, task.id)!.attempt_count];
    expect(executeTaskAction(cwd, "reset", task.id, "Operator").success).toBe(true);
    observed.push(store.getTask(cwd, task.id)!.attempt_count);

    for (let i = 1; i <= 2; i++) {
      const claimed = store.claimTaskForDispatch(cwd, task.id, `Worker${i}`, { maxAttempts: CAP })!;
      observed.push(claimed.attempt_count);
      store.exitAttempt(cwd, task.id, {
        owner: `Worker${i}`,
        dispatchToken: claimed.dispatch_token,
        maxAttempts: CAP,
      });
    }

    expect(executeTaskAction(cwd, "reset", task.id, "Operator").success).toBe(true);
    observed.push(store.getTask(cwd, task.id)!.attempt_count);
    const claimed = store.claimTaskForDispatch(cwd, task.id, "Worker3", { maxAttempts: CAP })!;
    observed.push(claimed.attempt_count);

    expect(observed).toEqual([CAP, CAP, CAP + 1, CAP + 2, CAP + 2, CAP + 3]);
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1]);
    }
    const final = store.getTask(cwd, task.id)!;
    expect(final.budget_baseline).toBe(CAP + 2);
    expect(final.attempt_count).toBe(CAP + 3);
  });

  it("a refused explicit reset never renews the budget", () => {
    const task = store.createTask(cwd, "Active task", "Desc");
    seedAttempts(cwd, task.id, CAP, CAP);

    const activeRefusal = executeTaskAction(cwd, "reset", task.id, "Operator", undefined, {
      isWorkerActive: () => true,
    });
    expect(activeRefusal.success).toBe(false);
    expect(activeRefusal.error).toBe("active_worker");
    let current = store.getTask(cwd, task.id)!;
    expect(current.attempt_count).toBe(CAP);
    expect(current.budget_baseline).toBe(CAP); // pre-existing baseline untouched

    store.mutateTask(cwd, task.id, () => ({ dispatch_token: "held-token" }));
    const fencedRefusal = executeTaskAction(cwd, "reset", task.id, "Operator", undefined, {
      dispatchToken: "wrong-token",
      crewIdentity: false,
    });
    expect(fencedRefusal.success).toBe(false);
    expect(fencedRefusal.error).toBe("reset_failed");
    current = store.getTask(cwd, task.id)!;
    expect(current.attempt_count).toBe(CAP);
    expect(current.budget_baseline).toBe(CAP);
    expect(current.status).toBe("todo");
  });

  it("a refused cascade-reset never renews any baseline", () => {
    const root = store.createTask(cwd, "Root", "Desc");
    const child = store.createTask(cwd, "Child", "Desc", [root.id]);
    seedAttempts(cwd, root.id, CAP);
    seedAttempts(cwd, child.id, 3);
    store.mutateTask(cwd, child.id, () => ({ status: "done" }));

    const result = executeTaskAction(cwd, "cascade-reset", root.id, "Operator", undefined, {
      isWorkerActive: taskId => taskId === child.id,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("active_worker");
    const rootAfter = store.getTask(cwd, root.id)!;
    const childAfter = store.getTask(cwd, child.id)!;
    expect(rootAfter.status).toBe("todo");
    expect(rootAfter.budget_baseline).toBeUndefined();
    expect(rootAfter.attempt_count).toBe(CAP);
    expect(childAfter.status).toBe("done");
    expect(childAfter.budget_baseline).toBeUndefined();
    expect(childAfter.attempt_count).toBe(3);
  });
});
