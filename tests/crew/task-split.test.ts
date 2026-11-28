import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState } from "../../lib.ts";
import * as store from "../../crew/store.ts";
import * as taskHandler from "../../crew/handlers/task.ts";
import type { Task } from "../../crew/types.ts";
import { createMockContext } from "../helpers/mock-context.ts";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

function createState(agentName: string = "TestAgent"): MessengerState {
  return { agentName } as MessengerState;
}

describe("crew/task.split", () => {
  let dirs: TempCrewDirs;
  let cwd: string;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    cwd = dirs.cwd;
    store.createPlan(cwd, "docs/PRD.md");
  });

  it("returns inspect context with spec, progress, and dependents", async () => {
    const foundation = store.createTask(cwd, "Foundation", "Foundational work");
    store.startTask(cwd, foundation.id, "WorkerA");
    store.completeTask(cwd, foundation.id, "Done");

    const parent = store.createTask(cwd, "Big task", "Large task body", [foundation.id]);
    const dependent = store.createTask(cwd, "Downstream", "Uses big task", [parent.id]);
    store.appendTaskProgress(cwd, parent.id, "WorkerA", "Partial implementation");

    const response = await taskHandler.execute(
      "split",
      { id: parent.id, count: 3 },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.mode).toBe("task.split");
    expect(response.details.phase).toBe("inspect");
    expect(response.details.suggestedCount).toBe(3);
    expect(response.details.dependents).toEqual([dependent.id]);
    expect(response.content[0].text).toContain(`Split Task ${parent.id}`);
    expect(response.content[0].text).toContain("Current Spec");
    expect(response.content[0].text).toContain("Progress");
  });

  it("executes split by creating subtasks, rewiring dependents, and converting parent to milestone", async () => {
    const dep = store.createTask(cwd, "Shared dependency", "Dependency");
    store.startTask(cwd, dep.id, "WorkerA");
    store.completeTask(cwd, dep.id, "Done");

    const parent = store.createTask(cwd, "Parent task", "Parent work", [dep.id]);
    const downstream = store.createTask(cwd, "Downstream task", "Downstream work", [parent.id]);

    const response = await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Subtask one", content: "Part 1" },
          { title: "Subtask two", content: "Part 2" },
        ],
      },
      createState("Splitter"),
      createMockContext(cwd),
    );

    expect(response.details.mode).toBe("task.split");
    expect(response.details.phase).toBe("execute");
    const subtasks = response.details.subtasks as Pick<Task, "id" | "title">[];
    const subtaskIds = subtasks.map(t => t.id);
    expect(subtaskIds).toHaveLength(2);

    const reloadedParent = store.getTask(cwd, parent.id);
    expect(reloadedParent?.milestone).toBe(true);
    expect(reloadedParent?.status).toBe("todo");
    expect(reloadedParent?.depends_on).toEqual(subtaskIds);

    const reloadedDownstream = store.getTask(cwd, downstream.id);
    expect(reloadedDownstream?.depends_on).not.toContain(parent.id);
    for (const subtaskId of subtaskIds) {
      expect(reloadedDownstream?.depends_on).toContain(subtaskId);
    }
  });

  it("refuses an intervening claim instead of treating it as a split takeover", async () => {
    const parent = store.createTask(cwd, "Parent task", "Parent work");
    const original = store.mutateTask.bind(store);
    let injected = false;

    // Land a claim in the gap between the handler's snapshot and its guarded
    // parent acceptance.
    const spy = vi.spyOn(store, "mutateTask").mockImplementation(((
      taskCwd: string,
      taskId: string,
      mutate: Parameters<typeof store.mutateTask>[2],
      options?: Parameters<typeof store.mutateTask>[3],
    ) => {
      if (!injected && taskId === parent.id) {
        injected = true;
        original(taskCwd, taskId, () => ({
          dispatch_token: "successor-token",
          assigned_to: "Successor",
          attempt_count: 1,
        }));
      }
      return original(taskCwd, taskId, mutate, options);
    }) as typeof store.mutateTask);

    try {
      const response = await taskHandler.execute(
        "split",
        {
          id: parent.id,
          subtasks: [{ title: "Slice one" }, { title: "Slice two" }],
        },
        createState(),
        createMockContext(cwd),
      );

      expect(response.details.error).toBe("task_changed");
      expect(store.getTasks(cwd)).toHaveLength(1);
      const after = store.getTask(cwd, parent.id)!;
      expect(after.status).toBe("todo");
      expect(after.milestone).not.toBe(true);
      expect(after.dispatch_token).toBe("successor-token");
      expect(after.assigned_to).toBe("Successor");

      // The reserved task survives; the successor still owns it.
      expect(store.blockTask(cwd, parent.id, "stale split", {
        dispatchToken: "old-token",
      })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("pending split prevents milestone auto-completion and work claims before linking", async () => {
    const parent = store.createTask(cwd, "Parent with no deps", "Parent work");
    const originalCreate = store.createTask.bind(store);
    let injected = false;
    let statusAfterAutoComplete: string | undefined;
    let claimedDuringSplit: Task | null = null;
    let startedDuringSplit: Task | null = null;
    let response: Awaited<ReturnType<typeof taskHandler.execute>>;

    const spy = vi.spyOn(store, "createTask").mockImplementation(((
      taskCwd: string,
      title: string,
      description?: string,
      dependsOn?: string[],
      options?: Parameters<typeof store.createTask>[4],
    ) => {
      if (!injected) {
        injected = true;
        // Between split acceptance and the milestone-link commit: the parent
        // must be pending, not an auto-completable milestone with old deps.
        store.autoCompleteMilestones(taskCwd);
        statusAfterAutoComplete = store.getTask(taskCwd, parent.id)?.status;
        claimedDuringSplit = store.claimTaskForDispatch(taskCwd, parent.id, "Racer");
        startedDuringSplit = store.startTask(taskCwd, parent.id, "Racer");
      }
      return originalCreate(taskCwd, title, description, dependsOn, options);
    }) as typeof store.createTask);

    try {
      response = await taskHandler.execute(
        "split",
        {
          id: parent.id,
          subtasks: [{ title: "Slice one" }, { title: "Slice two" }],
        },
        createState(),
        createMockContext(cwd),
      );
      expect(response.details.phase).toBe("execute");
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    // Neither operation may treat the intermediate parent as workable.
    expect(statusAfterAutoComplete).toBe("todo");
    expect(claimedDuringSplit).toBeNull();
    expect(startedDuringSplit).toBeNull();

    const reloaded = store.getTask(cwd, parent.id)!;
    expect(reloaded.milestone).toBe(true);
    expect(reloaded.status).toBe("todo");
    expect(reloaded.pending_split).toBeUndefined();
    const subtasks = response.details.subtasks as Pick<Task, "id" | "title">[];
    expect(reloaded.depends_on).toEqual(subtasks.map(t => t.id));
  });

  it("rolls back a refused split and removes untouched subtasks", async () => {
    const parent = store.createTask(cwd, "Parent", "Parent work");
    const originalCreate = store.createTask.bind(store);
    let injected = false;

    const spy = vi.spyOn(store, "createTask").mockImplementation(((
      taskCwd: string,
      title: string,
      description?: string,
      dependsOn?: string[],
      options?: Parameters<typeof store.createTask>[4],
    ) => {
      if (!injected) {
        injected = true;
        // A concurrent spec edit lands after split acceptance; the milestone
        // commit must refuse instead of linking children to a changed parent.
        store.applyTaskRevision(taskCwd, parent.id, { spec: "concurrent edit" }, {
          expectedGeneration: 0,
        });
      }
      return originalCreate(taskCwd, title, description, dependsOn, options);
    }) as typeof store.createTask);

    let response: Awaited<ReturnType<typeof taskHandler.execute>>;
    try {
      response = await taskHandler.execute(
        "split",
        {
          id: parent.id,
          subtasks: [{ title: "Slice one" }, { title: "Slice two" }],
        },
        createState(),
        createMockContext(cwd),
      );
    } finally {
      spy.mockRestore();
    }

    expect(response.details.error).toBe("split_not_committed");
    const after = store.getTask(cwd, parent.id)!;
    expect(after.pending_split).toBeUndefined();
    expect(after.milestone).not.toBe(true);
    expect(after.depends_on).toEqual([]);
    // The untouched subtasks from the refused split are rolled back, not left
    // behind as claimable orphan work.
    expect(store.getTasks(cwd).map(t => t.id)).toEqual([parent.id]);
  });

  it("splitting an in-progress task commits and invalidates its old reservation", async () => {
    const parent = store.createTask(cwd, "Live parent", "Parent work");
    const started = store.startTask(cwd, parent.id, "WorkerA");
    const oldToken = started!.dispatch_token;

    const response = await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [{ title: "Slice one" }, { title: "Slice two" }],
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.phase).toBe("execute");
    const after = store.getTask(cwd, parent.id)!;
    expect(after.milestone).toBe(true);
    expect(after.status).toBe("todo");
    expect(after.dispatch_token).toBeUndefined();
    expect(after.assigned_to).toBeUndefined();
    // The old worker's token cannot complete the now-milestone parent.
    expect(store.completeTask(cwd, parent.id, "late", undefined, "WorkerA", {
      dispatchToken: oldToken,
    })).toBeNull();
  });

  it("rejects splitting a milestone task", async () => {
    const parent = store.createTask(cwd, "Parent task", "Parent work");
    await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Subtask one" },
          { title: "Subtask two" },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    const secondSplit = await taskHandler.execute(
      "split",
      { id: parent.id },
      createState(),
      createMockContext(cwd),
    );

    expect(secondSplit.details.error).toBe("already_milestone");
    expect(secondSplit.content[0].text).toContain("Cannot split milestone task");
  });

  it("rejects execute mode when a subtask title is blank", async () => {
    const parent = store.createTask(cwd, "Parent task", "Parent work");

    const response = await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Valid subtask" },
          { title: "   " },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    expect(response.details.error).toBe("invalid_subtask_title");
    expect(store.getTasks(cwd)).toHaveLength(1);
  });

  it("allows splitting a blocked task and removes its block context file", async () => {
    const parent = store.createTask(cwd, "Blocked parent", "Needs decomposition");
    store.startTask(cwd, parent.id, "WorkerA");
    store.blockTask(cwd, parent.id, "Need smaller slices");

    const blockFile = path.join(dirs.blocksDir, `${parent.id}.md`);
    expect(fs.existsSync(blockFile)).toBe(true);

    await taskHandler.execute(
      "split",
      {
        id: parent.id,
        subtasks: [
          { title: "Slice one" },
          { title: "Slice two" },
        ],
      },
      createState(),
      createMockContext(cwd),
    );

    const reloadedParent = store.getTask(cwd, parent.id);
    expect(fs.existsSync(blockFile)).toBe(false);
    expect(reloadedParent?.status).toBe("todo");
    expect(reloadedParent?.blocked_reason).toBeUndefined();
    expect(reloadedParent?.milestone).toBe(true);
  });
});
