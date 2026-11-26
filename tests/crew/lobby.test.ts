import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, Function> = {};
    const proc: any = {
      pid: 12345,
      killed: false,
      exitCode: null,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: Function) => { handlers[event] = handler; }),
      kill: vi.fn(() => { proc.exitCode = 0; }),
      _handlers: handlers,
    };
    return proc;
  }),
}));

vi.mock("../../crew/store.ts", () => ({
  TaskLockTimeoutError: class MockTaskLockTimeoutError extends Error {},
  getPlan: vi.fn(() => ({ prd: "docs/PRD.md" })),
  getCrewDir: vi.fn((cwd: string) => `${cwd}/.pi/messenger/crew`),
  getTask: vi.fn(() => null),
  getBaseCommit: vi.fn(() => "abc1234"),
  claimTaskForDispatch: vi.fn((_cwd: string, taskId: string, workerName: string) => ({
    id: taskId,
    status: "todo",
    assigned_to: workerName,
    attempt_count: 1,
    dispatch_token: "test-dispatch-token",
  })),
  startTask: vi.fn((_cwd: string, taskId: string, agentName: string, options?: { dispatchToken?: string }) => ({
    id: taskId,
    status: "in_progress",
    assigned_to: agentName,
    attempt_count: 1,
    dispatch_token: options?.dispatchToken,
  })),
  exitAttempt: vi.fn(() => ({ outcome: "changed", task: null })),
  releaseDispatch: vi.fn(),
  appendTaskProgress: vi.fn(),
}));

vi.mock("../../feed.ts", () => ({
  logFeedEvent: vi.fn(),
}));

vi.mock("../../crew/utils/config.ts", () => ({
  loadCrewConfig: vi.fn(() => ({
    concurrency: { workers: 4 },
    models: {},
    artifacts: { enabled: false },
    work: {},
    coordination: "chatty",
  })),
}));

vi.mock("../../crew/utils/discover.ts", () => ({
  discoverCrewAgents: vi.fn(() => [{
    name: "crew-worker",
    description: "worker",
    systemPrompt: "# Crew Worker\nYou implement tasks.",
    tools: ["read", "write", "edit", "bash", "pi_messenger"],
    source: "extension",
    filePath: "/ext/crew-worker.md",
    crewRole: "worker",
    model: "claude-opus-4-5",
  }]),
}));

vi.mock("../../crew/live-progress.ts", () => ({
  updateLiveWorker: vi.fn(),
  removeLiveWorker: vi.fn(),
}));

vi.mock("../../lib.ts", async () => {
  let counter = 0;
  return {
    generateMemorableName: () => `TestWorker${++counter}`,
  };
});

function createTestCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-lobby-test-"));
  fs.mkdirSync(path.join(cwd, ".pi", "messenger", "crew"), { recursive: true });
  return cwd;
}

describe("lobby workers", () => {
  let lobby: typeof import("../../crew/lobby.ts");
  let liveProgress: typeof import("../../crew/live-progress.ts");

  beforeEach(async () => {
    vi.resetModules();
    lobby = await import("../../crew/lobby.ts");
    liveProgress = await import("../../crew/live-progress.ts");
  });

  it("spawns a lobby worker and registers it in live progress", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd");
    expect(worker).not.toBeNull();
    expect(worker!.name).toContain("TestWorker");
    expect(worker!.assignedTaskId).toBeNull();
    expect(worker!.cwd).toBe("/test/cwd");
    expect(liveProgress.updateLiveWorker).toHaveBeenCalledWith(
      "/test/cwd",
      expect.stringContaining("__lobby-"),
      expect.objectContaining({ agent: "crew-worker" }),
    );
  });

  it("returns null if no crew-worker agent is discovered", async () => {
    const discover = await import("../../crew/utils/discover.ts");
    vi.mocked(discover.discoverCrewAgents).mockReturnValueOnce([]);
    const worker = lobby.spawnLobbyWorker("/test/cwd");
    expect(worker).toBeNull();
  });

  it("passes bare .js tool entries as extension paths", async () => {
    const discover = await import("../../crew/utils/discover.ts");
    vi.mocked(discover.discoverCrewAgents).mockReturnValueOnce([{
      name: "crew-worker",
      description: "worker",
      systemPrompt: "# Crew Worker\nYou implement tasks.",
      tools: ["read", "pi_messenger", "custom-tool.js"],
      source: "extension",
      filePath: "/ext/crew-worker.md",
      crewRole: "worker",
    }]);

    lobby.spawnLobbyWorker("/test/cwd");

    const { spawn } = await import("node:child_process");
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const toolsIdx = args.indexOf("--tools");
    const extensionIdx = args.indexOf("--extension");

    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("read,pi_messenger");
    expect(extensionIdx).toBeGreaterThan(-1);
    expect(args[extensionIdx + 1]).toBe("custom-tool.js");
  });

  it("uses pi.cmd for lobby subprocesses on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      lobby.spawnLobbyWorker("/test/cwd");

      const { spawn } = await import("node:child_process");
      expect(vi.mocked(spawn).mock.calls[0][0]).toBe("pi.cmd");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("counts available lobby workers for a cwd", () => {
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(0);
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(1);
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(2);
    expect(lobby.getLobbyWorkerCount("/other/cwd")).toBe(0);
  });

  it("getAvailableLobbyWorkers returns only unassigned workers", () => {
    const w1 = lobby.spawnLobbyWorker("/test/cwd")!;
    lobby.spawnLobbyWorker("/test/cwd")!;
    expect(lobby.getAvailableLobbyWorkers("/test/cwd")).toHaveLength(2);

    w1.assignedTaskId = "task-1";
    expect(lobby.getAvailableLobbyWorkers("/test/cwd")).toHaveLength(1);
  });

  it("removeLobbyWorkerByIndex kills one unassigned lobby worker", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(2);

    const removed = lobby.removeLobbyWorkerByIndex("/test/cwd");
    expect(removed).toBe(true);
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(1);
  });

  it("removeLobbyWorkerByIndex returns false when no lobby workers exist", () => {
    expect(lobby.removeLobbyWorkerByIndex("/test/cwd")).toBe(false);
  });

  it("killLobbyWorkerForTask kills lobby worker assigned to a specific task", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-9";

    const killed = lobby.killLobbyWorkerForTask("/test/cwd", "task-9");
    expect(killed).toBe(true);
    const proc = worker.proc as any;
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("killLobbyWorkerForTask returns false when no matching worker", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    expect(lobby.killLobbyWorkerForTask("/test/cwd", "task-99")).toBe(false);
  });

  it("shutdownLobbyWorkers kills all lobby workers for a cwd", () => {
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/test/cwd");
    lobby.spawnLobbyWorker("/other/cwd");

    lobby.shutdownLobbyWorkers("/test/cwd");
    expect(lobby.getLobbyWorkerCount("/test/cwd")).toBe(0);
    expect(lobby.getLobbyWorkerCount("/other/cwd")).toBe(1);
  });

  it("assignTaskToLobbyWorker marks worker as assigned", () => {
    const cwd = createTestCwd();
    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox");
    const worker = lobby.spawnLobbyWorker(cwd)!;
    expect(worker.assignedTaskId).toBeNull();

    const assigned = lobby.assignTaskToLobbyWorker(worker, "task-3", "# Task 3\nDo stuff", inboxDir, "lobby-dispatch-token");
    expect(assigned).toBe(true);
    expect(worker.assignedTaskId).toBe("task-3");
    // The warm delivery conveys the minted token so the close handler fences
    // with the reservation, not the reusable worker name.
    expect(worker.dispatchToken).toBe("lobby-dispatch-token");
    expect(lobby.getAvailableLobbyWorkers(cwd)).toHaveLength(0);

    const inbox = path.join(inboxDir, worker.name);
    const messageFile = fs.readdirSync(inbox).find(file => file.endsWith(".json"));
    expect(messageFile).toBeTruthy();
    const message = JSON.parse(fs.readFileSync(path.join(inbox, messageFile!), "utf-8")) as {
      text: string;
      dispatchToken?: string;
      taskId?: string;
      lobbyId?: string;
    };
    expect(message.text).toContain("Follow the assignment below");
    expect(message.text).not.toContain("reserving files, implementing, testing, committing");
    // Structured, not prompt text: the extension attaches it, not the model.
    expect(message.dispatchToken).toBe("lobby-dispatch-token");
    expect(message.taskId).toBe("task-3");
    expect(message.lobbyId).toBe(worker.lobbyId);
    expect(message.text).not.toContain("lobby-dispatch-token");
  });

  it("assignTaskToLobbyWorker rejects already-assigned worker", () => {
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-1";
    const secondAssign = lobby.assignTaskToLobbyWorker(worker, "task-2", "prompt", "/tmp/test-inbox");
    expect(secondAssign).toBe(false);
    expect(worker.assignedTaskId).toBe("task-1");
  });

  it("manages keep-alive file lifecycle on spawn, assignment, direct assignment, and shutdown", async () => {
    const cwd = createTestCwd();
    const inboxDir = path.join(cwd, ".pi", "messenger", "inbox");

    const worker = lobby.spawnLobbyWorker(cwd)!;
    expect(worker.aliveFile).toBeTruthy();
    expect(fs.existsSync(worker.aliveFile!)).toBe(true);

    const assigned = lobby.assignTaskToLobbyWorker(worker, "task-keepalive", "# Task\nDo work", inboxDir);
    expect(assigned).toBe(true);
    expect(fs.existsSync(worker.aliveFile!)).toBe(false);

    const storeModule = await import("../../crew/store.ts");
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-keepalive-direct", title: "Direct assign", status: "todo", attempt_count: 0,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const directWorker = lobby.spawnWorkerForTask(cwd, "task-keepalive-direct", "# Task prompt");
    expect(directWorker).not.toBeNull();
    expect(directWorker!.assignedTaskId).toBe("task-keepalive-direct");
    expect(directWorker!.aliveFile).toBeTruthy();
    expect(fs.existsSync(directWorker!.aliveFile!)).toBe(false);

    const idleWorker = lobby.spawnLobbyWorker(cwd)!;
    expect(idleWorker.aliveFile).toBeTruthy();
    expect(fs.existsSync(idleWorker.aliveFile!)).toBe(true);

    lobby.shutdownLobbyWorkers(cwd);
    expect(fs.existsSync(idleWorker.aliveFile!)).toBe(false);
  });

  it("cleanupUnassignedAliveFiles deletes only unassigned keep-alive files", () => {
    const cwd = createTestCwd();
    const unassigned = lobby.spawnLobbyWorker(cwd)!;
    const assigned = lobby.spawnLobbyWorker(cwd)!;
    assigned.assignedTaskId = "task-assigned";

    expect(fs.existsSync(unassigned.aliveFile!)).toBe(true);
    expect(fs.existsSync(assigned.aliveFile!)).toBe(true);

    lobby.cleanupUnassignedAliveFiles(cwd);

    expect(fs.existsSync(unassigned.aliveFile!)).toBe(false);
    expect(fs.existsSync(assigned.aliveFile!)).toBe(true);
  });

  it("shutdownLobbyWorkers sweeps stale keep-alive files", () => {
    const cwd = createTestCwd();
    const staleAlive = path.join(cwd, ".pi", "messenger", "crew", "lobby-stale.alive");
    fs.writeFileSync(staleAlive, "", { mode: 0o600 });
    expect(fs.existsSync(staleAlive)).toBe(true);

    lobby.shutdownLobbyWorkers(cwd);

    expect(fs.existsSync(staleAlive)).toBe(false);
  });

  it("builds chatty lobby prompt with PRD path", async () => {
    const { spawn } = await import("node:child_process");
    lobby.spawnLobbyWorker("/test/cwd");

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.length).toBe(1);
    const promptArg = calls[0][1]![calls[0][1]!.length - 1] as string;
    expect(promptArg).toContain("Crew Lobby");
    expect(promptArg).toContain("docs/PRD.md");
    expect(promptArg).toContain("Share Your Findings");
    expect(promptArg).toContain("Introduce yourself");
    expect(promptArg).toContain("at most 5 messages");
    expect(promptArg).toContain("TASK ASSIGNMENT");
  });

  it("close handler resets orphaned in_progress task to todo", async () => {
    const storeModule = await import("../../crew/store.ts");
    const feedModule = await import("../../feed.ts");

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-1";
    worker.dispatchToken = "warm-dispatch-token";

    vi.mocked(storeModule.exitAttempt).mockReturnValueOnce({
      outcome: "todo",
      task: {
        id: "task-1", title: "Test", status: "todo", attempt_count: 1,
        depends_on: [], created_at: "", base_commit: "abc1234",
      } as any,
    });

    const proc = worker.proc as any;
    const closeHandler = proc._handlers["close"];
    expect(closeHandler).toBeDefined();

    closeHandler(1);

    // The ownership check and the write happen inside one guarded mutation.
    expect(storeModule.exitAttempt).toHaveBeenCalledWith("/test/cwd", "task-1", expect.objectContaining({
      owner: worker.name,
      dispatchToken: "warm-dispatch-token",
    }));
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-1", "system",
      expect.stringContaining("indeterminate"),
    );
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      "/test/cwd", worker.name, "task.reset", "task-1", "worker exited",
    );
  });

  it("close handler blocks task when max attempts exceeded", async () => {
    const storeModule = await import("../../crew/store.ts");
    const configModule = await import("../../crew/utils/config.ts");
    const feedModule = await import("../../feed.ts");
    vi.mocked(configModule.loadCrewConfig).mockReturnValue({
      concurrency: { workers: 4 },
      models: {},
      artifacts: { enabled: false },
      work: { maxAttemptsPerTask: 3 },
      coordination: "chatty",
    } as any);

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-2";

    vi.mocked(storeModule.exitAttempt).mockReturnValueOnce({
      outcome: "blocked",
      task: {
        id: "task-2", title: "Test", status: "blocked", attempt_count: 3,
        depends_on: [], created_at: "", base_commit: "feedface",
      } as any,
      previous: {
        id: "task-2", title: "Test", status: "in_progress", attempt_count: 3,
        depends_on: [], created_at: "", base_commit: "feedface",
      } as any,
    });

    const proc = worker.proc as any;
    proc._handlers["close"](1);

    expect(storeModule.exitAttempt).toHaveBeenCalledWith("/test/cwd", "task-2", expect.objectContaining({
      owner: worker.name,
      maxAttempts: 3,
    }));
    // The cap-block path still records the base-anchored reconcile note.
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-2", "system",
      expect.stringContaining("indeterminate: work may have landed"),
    );
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-2", "system",
      expect.stringContaining("Prior attempt base commit: feedface."),
    );
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      "/test/cwd", worker.name, "task.block", "task-2", "Max attempts reached",
    );
  });

  it("close handler skips recovery if task already completed", async () => {
    const storeModule = await import("../../crew/store.ts");

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-3";

    vi.mocked(storeModule.exitAttempt).mockReturnValueOnce({ outcome: "changed", task: null });

    const proc = worker.proc as any;
    proc._handlers["close"](0);

    // The guarded exit refused: a completed task is not reset or blocked.
    expect(storeModule.exitAttempt).toHaveBeenCalledWith("/test/cwd", "task-3", expect.objectContaining({
      owner: worker.name,
    }));
    expect(storeModule.appendTaskProgress).not.toHaveBeenCalledWith(
      "/test/cwd", "task-3", "system", expect.stringContaining("Reset to todo"),
    );
  });

  it("close handler skips reset if task reassigned to another worker", async () => {
    const storeModule = await import("../../crew/store.ts");

    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-4";

    vi.mocked(storeModule.exitAttempt).mockReturnValueOnce({ outcome: "changed", task: null });

    const proc = worker.proc as any;
    proc._handlers["close"](0);

    expect(storeModule.exitAttempt).toHaveBeenCalledWith("/test/cwd", "task-4", expect.objectContaining({
      owner: worker.name,
    }));
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-4", "system",
      expect.stringContaining("Ignored stale exit"),
    );
    expect(storeModule.appendTaskProgress).not.toHaveBeenCalledWith(
      "/test/cwd", "task-4", "system", expect.stringContaining("Reset to todo"),
    );
  });

  it("close handler survives a progress-append throw for an accepted exit", async () => {
    const storeModule = await import("../../crew/store.ts");
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-progress-throw";

    vi.mocked(storeModule.exitAttempt).mockReturnValueOnce({
      outcome: "todo",
      task: { id: "task-progress-throw", status: "todo", attempt_count: 1, depends_on: [], created_at: "" } as any,
      previous: { id: "task-progress-throw", status: "in_progress", attempt_count: 1, depends_on: [], created_at: "", base_commit: "abc1234" } as any,
    });
    vi.mocked(storeModule.appendTaskProgress).mockImplementationOnce(() => {
      throw new Error("progress guard timeout");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const proc = worker.proc as any;
      expect(() => proc._handlers["close"](0)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("lobby progress note for task-progress-throw"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("close handler survives an exitAttempt lock timeout", async () => {
    const storeModule = await import("../../crew/store.ts");
    const worker = lobby.spawnLobbyWorker("/test/cwd")!;
    worker.assignedTaskId = "task-timeout";

    vi.mocked(storeModule.exitAttempt).mockImplementationOnce(() => {
      const TimeoutError = (storeModule as unknown as { TaskLockTimeoutError: new (message: string) => Error }).TaskLockTimeoutError;
      throw new TimeoutError("Timed out waiting for filesystem guard /guard (held by pid 1); Stop all crew writers for this project, then remove the named marker file and the (now empty) guard directory, then retry.");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const proc = worker.proc as any;
      expect(() => proc._handlers["close"](0)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("lobby exit for task-timeout"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exports token budgets that scale with coordination level", () => {
    const budgets = lobby.LOBBY_TOKEN_BUDGETS;
    expect(budgets.none).toBeLessThan(budgets.minimal);
    expect(budgets.minimal).toBeLessThan(budgets.moderate);
    expect(budgets.moderate).toBeLessThan(budgets.chatty);
  });

  it("spawnWorkerForTask claims, starts, spawns and forwards the dispatch token", async () => {
    const storeModule = await import("../../crew/store.ts");
    const feedModule = await import("../../feed.ts");
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-5", title: "Build something", status: "todo", attempt_count: 0,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const worker = lobby.spawnWorkerForTask("/test/cwd", "task-5", "# Task prompt");

    expect(worker).not.toBeNull();
    expect(worker!.assignedTaskId).toBe("task-5");
    expect(storeModule.claimTaskForDispatch).toHaveBeenCalledWith("/test/cwd", "task-5", worker!.name, {
      maxAttempts: undefined,
    });
    expect(storeModule.startTask).toHaveBeenCalledWith("/test/cwd", "task-5", worker!.name, {
      baseCommit: "abc1234",
      dispatchToken: "test-dispatch-token",
    });
    // The token reaches the spawned process through the environment, so the
    // extension can attach it to task.start/task.done without the model.
    expect(vi.mocked(spawn).mock.calls[0][2]!.env!.PI_CREW_DISPATCH).toBe("test-dispatch-token");
    expect(storeModule.appendTaskProgress).toHaveBeenCalledWith(
      "/test/cwd", "task-5", "system",
      expect.stringContaining("Assigned to worker"),
    );
    expect(feedModule.logFeedEvent).toHaveBeenCalledWith(
      "/test/cwd", worker!.name, "task.start", "task-5", "Build something",
    );
  });

  it("spawnWorkerForTask returns null if task already claimed", async () => {
    const storeModule = await import("../../crew/store.ts");
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-6", title: "Claimed", status: "in_progress", attempt_count: 1,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);

    const worker = lobby.spawnWorkerForTask("/test/cwd", "task-6", "# prompt");
    expect(worker).toBeNull();
  });

  it("spawnWorkerForTask refuses when an active worker is already registered for the task", async () => {
    const storeModule = await import("../../crew/store.ts");
    const registry = await import("../../crew/registry.ts");
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
    vi.mocked(storeModule.getTask).mockReturnValueOnce({
      id: "task-7", title: "Active", status: "todo", attempt_count: 0,
      depends_on: [], description: "", created_at: "", milestone: false,
    } as any);
    registry.registerWorker({
      type: "worker",
      proc: { exitCode: null, killed: false, kill: vi.fn() } as any,
      name: "ExistingWorker",
      cwd: "/test/cwd",
      taskId: "task-7",
    });

    const worker = lobby.spawnWorkerForTask("/test/cwd", "task-7", "# prompt");

    expect(worker).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("builds minimal lobby prompt without chat instructions", async () => {
    const config = await import("../../crew/utils/config.ts");
    vi.mocked(config.loadCrewConfig).mockReturnValue({
      concurrency: { workers: 4 },
      models: {},
      artifacts: { enabled: false },
      work: {},
      coordination: "minimal",
    });

    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();

    lobby.spawnLobbyWorker("/test/cwd");

    const calls = vi.mocked(spawn).mock.calls;
    const promptArg = calls[0][1]![calls[0][1]!.length - 1] as string;
    expect(promptArg).toContain("Standing by for task assignment");
    expect(promptArg).not.toContain("Chat With Your Team");
  });
});
