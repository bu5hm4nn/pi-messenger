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
