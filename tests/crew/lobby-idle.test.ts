import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import { readFeedEvents } from "../../feed.ts";
import * as store from "../../crew/store.ts";
import * as state from "../../crew/state.ts";
import { spawnLobbyWorker, shutdownLobbyWorkers } from "../../crew/lobby.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
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

interface MockProc {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  fire: (event: string, ...args: unknown[]) => void;
}

function createProc(pid: number): MockProc {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const proc: MockProc = {
    pid,
    killed: false,
    exitCode: null,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    kill: vi.fn((signal?: string) => {
      proc.killed = true;
      proc.exitCode = signal === "SIGKILL" ? 137 : 143;
      return true;
    }),
    fire: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
  };
  return proc;
}

function crewIdleEvents(cwd: string) {
  return readFeedEvents(cwd, 100).filter(event => event.type === "crew.idle");
}

describe("crew idle transition detection", () => {
  let dirs: ReturnType<typeof createTempCrewDirs>;
  let nextPid: number;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    store.createTask(dirs.cwd, "Outstanding task", "Desc");
    nextPid = 5000;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createProc(nextPid++));
    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    state.autonomousState.concurrency = 2;
    state.startAutonomous(dirs.cwd, 2);
  });

  afterEach(() => {
    state.stopAutonomous("manual");
    try { shutdownLobbyWorkers(dirs.cwd); } catch {}
  });

  it("intentional shutdown with outstanding todo work emits no crew.idle", () => {
    const worker = spawnLobbyWorker(dirs.cwd)!;
    expect(worker).not.toBeNull();

    // Session shutdown kills/unregisters the lobby worker, then its close
    // handler runs while the autonomous flag may still be set.
    shutdownLobbyWorkers(dirs.cwd);
    const proc = worker.proc as unknown as MockProc;
    proc.exitCode = 143;
    proc.fire("close", 143);

    expect(crewIdleEvents(dirs.cwd)).toHaveLength(0);
  });

  it("a lobby close during an aborted wave's receipt drain emits no crew.idle", async () => {
    const workHandler = await import("../../crew/handlers/work.ts");
    const agents = await import("../../crew/agents.ts");
    const task = store.getTasks(dirs.cwd)[0];

    const controller = new AbortController();
    let worker: ReturnType<typeof spawnLobbyWorker> | null = null;

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      worker = spawnLobbyWorker(dirs.cwd);
      // The work tool is aborted while the wave is still draining; the run
      // must be marked stopped here, before receipts are classified.
      controller.abort();
      expect(state.autonomousState.active).toBe(false);
      // Receipt arrives for the still-unclaimed task, so result processing
      // continues into the drain window.
      return [{
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: { agent: "crew-worker", status: "completed" as const, recentTools: [], toolCallCount: 0, tokens: 0, durationMs: 0 },
        taskId: task.id,
        workerName: "WaveAWorker",
      }];
    });

    // Fire the lobby worker's close while work is processing receipts.
    const originalGetTask = store.getTask.bind(store);
    let fired = false;
    vi.spyOn(store, "getTask").mockImplementation((cwd: string, id: string) => {
      if (!fired && worker) {
        fired = true;
        const proc = worker.proc as unknown as MockProc;
        proc.exitCode = 0;
        proc.fire("close", 0);
      }
      return originalGetTask(cwd, id);
    });

    await workHandler.execute(
      { action: "work", autonomous: true },
      { base: path.join(dirs.cwd, ".pi", "messenger"), registry: path.join(dirs.cwd, ".pi", "messenger", "registry"), inbox: path.join(dirs.cwd, ".pi", "messenger", "inbox") },
      { cwd: dirs.cwd, hasUI: false, ui: { theme: { fg: (_c: string, t: string) => t }, notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [], getSessionId: () => "test" } } as never,
      () => {},
      controller.signal,
    );

    expect(fired).toBe(true);
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(0);
  });

  it("leaves an idle transition unreported when the feed append fails, then re-emits", async () => {
    const feed = await import("../../feed.ts");
    const worker = spawnLobbyWorker(dirs.cwd)!;
    worker.assignedTaskId = "task-feed-timeout";

    const storeModule = await import("../../crew/store.ts");
    vi.spyOn(storeModule, "exitAttempt").mockReturnValue({ outcome: "changed", task: null, previous: null });

    const spy = vi.spyOn(feed, "logFeedEvent");
    spy.mockReturnValueOnce(false);
    const proc = worker.proc as unknown as MockProc;
    proc.exitCode = 0;
    proc.fire("close", 0);

    // The append was dropped, so the transition was NOT marked reported.
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(0);

    // A later close re-emits the same transition exactly once (the successful
    // append gates any further re-emit).
    proc.fire("close", 0);
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(1);
    spy.mockRestore();
  });

  it("reports two distinct idle transitions even inside the old two-second window", () => {
    const first = spawnLobbyWorker(dirs.cwd)!;
    const second = spawnLobbyWorker(dirs.cwd)!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // First worker exits while the second is still live: not idle yet.
    const firstProc = first.proc as unknown as MockProc;
    firstProc.exitCode = 0;
    firstProc.fire("close", 0);
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(0);

    // Second exits with outstanding work: first idle transition.
    const secondProc = second.proc as unknown as MockProc;
    secondProc.exitCode = 0;
    secondProc.fire("close", 0);
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(1);

    // A new worker leaves the idle state; its exit is a second transition and
    // must report even though it happens immediately after the first.
    const third = spawnLobbyWorker(dirs.cwd)!;
    const thirdProc = third.proc as unknown as MockProc;
    thirdProc.exitCode = 0;
    thirdProc.fire("close", 0);
    expect(crewIdleEvents(dirs.cwd)).toHaveLength(2);
  });
});
