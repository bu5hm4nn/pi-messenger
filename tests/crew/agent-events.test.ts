import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.exitCode = 143;
    queueMicrotask(() => {
      proc.emit("exit", proc.exitCode);
      proc.emit("close", proc.exitCode);
    });
    return true;
  });
  return proc;
}

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a test worker.
`);
}

describe("crew agent event handling", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    writeWorkerAgent(dirs.cwd);
    spawnMock.mockReset();
  });

  it("compacts streaming message_update artifacts while preserving final output", async () => {
    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    const repeated = "SNAPSHOT_CONTENT".repeat(100);
    proc.stdout.emit("data", `${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "ok", partial: { role: "assistant", content: [{ type: "text", text: repeated }] } },
      message: { role: "assistant", content: [{ type: "text", text: repeated }] },
    })}\n${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] },
    })}\n`);
    proc.exitCode = 0;
    proc.emit("close", 0);

    const [result] = await resultPromise;

    expect(result.output).toBe("FINAL");
    const artifact = fs.readdirSync(path.join(dirs.crewDir, "artifacts")).find(file => file.endsWith(".jsonl"));
    expect(artifact).toBeTruthy();
    const jsonl = fs.readFileSync(path.join(dirs.crewDir, "artifacts", artifact!), "utf-8");
    expect(jsonl).not.toContain("SNAPSHOT_CONTENT");
    expect(jsonl).toContain("text_delta");
  });

  it("carries the dispatch workerName and token into the environment and the result", async () => {
    const store = await import("../../crew/store.ts");
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: task.id,
      workerName: "WaveAWorker",
    }], dirs.cwd);

    proc.exitCode = 0;
    proc.emit("close", 0);

    const [result] = await resultPromise;

    expect(spawnMock.mock.calls[0][2].env.PI_AGENT_NAME).toBe("WaveAWorker");
    // The claim mints the token and the extension forwards it to the worker;
    // the receipt carries the same value for stale-result fencing.
    const envToken = spawnMock.mock.calls[0][2].env.PI_CREW_DISPATCH as string;
    expect(envToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.workerName).toBe("WaveAWorker");
    expect(result.dispatchToken).toBe(envToken);
    expect(store.getTask(dirs.cwd, task.id)?.dispatch_token).toBe(envToken);
  });

  it("skips a dispatch whose task no longer exists instead of spawning", async () => {
    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const results = await spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-missing",
      workerName: "GhostWorker",
    }], dirs.cwd);

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].error).toContain("no longer exists");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("injects and records the dispatch identity when crewRole is renamed", async () => {
    const store = await import("../../crew/store.ts");
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    // A project override can rename the role; the explicit dispatch identity
    // must still reach the worker and be recorded on the task.
    fs.writeFileSync(path.join(dirs.cwd, ".pi", "messenger", "crew", "agents", "crew-worker.md"),
      `---
name: crew-worker
description: Renamed worker
crewRole: implementer
---
You are an implementer.
`);

    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: task.id,
      workerName: "RenamedWorker-7f3a",
    }], dirs.cwd);

    proc.exitCode = 0;
    proc.emit("close", 0);

    const [result] = await resultPromise;

    expect(spawnMock.mock.calls[0][2].env.PI_AGENT_NAME).toBe("RenamedWorker-7f3a");
    expect(spawnMock.mock.calls[0][2].env.PI_CREW_WORKER).toBeUndefined();
    expect(result.workerName).toBe("RenamedWorker-7f3a");
    expect(store.getTask(dirs.cwd, task.id)?.assigned_to).toBe("RenamedWorker-7f3a");
  });

  it("rejects one task on a claim timeout without losing another launched worker's receipt", async () => {
    const store = await import("../../crew/store.ts");
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Timed out task", "Desc");
    const t2 = store.createTask(dirs.cwd, "Launched task", "Desc");

    const originalClaim = store.claimTaskForDispatch.bind(store);
    const timeout = new store.TaskLockTimeoutError("/tmp/guard", [], "EEXIST");
    const claimSpy = vi.spyOn(store, "claimTaskForDispatch").mockImplementation(((
      cwd: string,
      taskId: string,
      workerName: string,
      options?: Parameters<typeof store.claimTaskForDispatch>[3],
    ) => {
      if (taskId === t1.id) throw timeout;
      return originalClaim(cwd, taskId, workerName, options);
    }) as typeof store.claimTaskForDispatch);

    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const resultPromise = spawnAgents([
      { agent: "crew-worker", task: "first", taskId: t1.id, workerName: "TimeoutWorker" },
      { agent: "crew-worker", task: "second", taskId: t2.id, workerName: "LaunchedWorker" },
    ], dirs.cwd);

    proc.exitCode = 0;
    proc.emit("close", 0);
    const results = await resultPromise;
    claimSpy.mockRestore();

    expect(results).toHaveLength(2);
    const timedOut = results.find(result => result.taskId === t1.id)!;
    expect(timedOut.errorCode).toBe("task_lock_timeout");
    expect(timedOut.skipped).toBeUndefined();
    expect(timedOut.error).toContain("Dispatch claim timed out");

    const launched = results.find(result => result.taskId === t2.id)!;
    expect(launched.workerName).toBe("LaunchedWorker");
    expect(launched.dispatchToken).toBeTruthy();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The launched worker's receipt survives the other task's timeout.
    expect(store.getTask(dirs.cwd, t2.id)?.dispatch_token).toBe(launched.dispatchToken);
  });

  it("fails fast on terminal provider quota errors", async () => {
    const proc = createProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnAgents } = await import("../../crew/agents.ts");

    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "Implement task",
      taskId: "task-1",
    }], dirs.cwd);

    proc.stdout.emit("data", `${JSON.stringify({
      type: "provider_error",
      error: {
        status: 400,
        type: "invalid_request_error",
        message: "Third-party apps now draw from your extra usage. Add more at claude.ai/settings/usage and keep going.",
      },
    })}\n`);

    const [result] = await resultPromise;

    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Provider error 400");
  });
});
