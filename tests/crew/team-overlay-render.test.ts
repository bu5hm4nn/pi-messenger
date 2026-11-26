import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import * as store from "../../crew/store.ts";
import * as teamStore from "../../crew/team/store.ts";
import { renderStatusBar, renderTaskList } from "../../overlay-render.ts";
import { createCrewViewState, setNotification } from "../../overlay-actions.ts";
import { MessengerOverlay } from "../../overlay.ts";
import { appendFeedEvent, type FeedEvent } from "../../feed.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function flashEvents(events: FeedEvent[], prevSeq: number | null, keepTimers = false) {
  const tui = { requestRender: vi.fn() } as any;
  const overlay = Object.create(MessengerOverlay.prototype) as any;
  overlay.crewViewState = createCrewViewState();
  overlay.tui = tui;
  overlay.detectAndFlashEvents(events, prevSeq);
  const viewState = overlay.crewViewState as ReturnType<typeof createCrewViewState>;
  if (!keepTimers && viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  return viewState;
}

function event(seq: number, type: FeedEvent["type"], extra: Partial<FeedEvent> = {}): FeedEvent {
  return {
    ts: "2026-01-01T00:00:01.000Z",
    seq,
    agent: "crew",
    type,
    ...extra,
  };
}

function createOverlay(cwd: string): MessengerOverlay {
  const base = path.join(cwd, ".pi", "messenger");
  const dirs = {
    base,
    registry: path.join(base, "registry"),
    inbox: path.join(base, "inbox"),
  };
  fs.mkdirSync(dirs.registry, { recursive: true });
  fs.mkdirSync(dirs.inbox, { recursive: true });
  const state = {
    agentName: "TestAgent",
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test",
    cwd,
    scopeToFolder: false,
    isHuman: false,
    session: {},
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  } as any;
  const tui = { requestRender: vi.fn() } as any;
  return new MessengerOverlay(tui, theme, state, dirs, vi.fn(), {}, cwd);
}

describe("Team overlay render signals", () => {
  it("shows active team, rejected count, role labels, and approval markers", () => {
    const { cwd } = createTempCrewDirs();
    teamStore.setActiveTeam(cwd, "migration-squad", "migration-squad");
    store.createPlan(cwd, "docs/PRD.md");
    store.createTask(cwd, "Update auth", "", [], {
      role: "worker",
      approval: { required: true, status: "rejected" },
    });

    const status = renderStatusBar(theme, cwd, 200);
    const tasks = renderTaskList(theme, cwd, 200, 10, createCrewViewState()).join("\n");

    expect(status).toContain("Team: migration-squad");
    expect(status).toContain("Rejected: 1");
    expect(tasks).toContain("[worker]");
    expect(tasks).toContain("[rejected]");
  });
});

describe("Crew idle overlay flash", () => {
  it("flashes crew.idle with a readable label instead of the raw type", () => {
    const viewState = flashEvents([
      event(11, "crew.idle", { preview: "All crew workers exited with outstanding work: task-1" }),
    ], 10);

    expect(viewState.notification?.message).toContain("crew idle");
    expect(viewState.notification?.message).not.toContain("crew.idle");
  });

  it("does not discard an unseen crew.idle when a later significant event is in the same batch", () => {
    const viewState = flashEvents([
      event(11, "crew.idle", { preview: "outstanding work" }),
      event(12, "task.done", { agent: "WorkerOne", target: "task-1", preview: "done" }),
    ], 10);

    expect(viewState.notification?.message).toContain("crew idle");
    // The later task.done still surfaces after the idle flash.
    expect(viewState.pendingNotifications.join(" ")).toContain("completed");
  });

  it("advances the real cursor across two renders for equal-timestamp idle events", () => {
    vi.useFakeTimers();
    const { cwd } = createTempCrewDirs();
    const overlay = createOverlay(cwd);
    try {
      // Empty first render establishes a zero baseline.
      overlay.render();
      const viewState = (overlay as any).crewViewState as ReturnType<typeof createCrewViewState>;
      expect(viewState.lastSeenEventSeq).toBe(0);

      const ts = "2026-01-01T00:00:02.000Z";
      appendFeedEvent(cwd, { ts, agent: "crew", type: "task.done", target: "task-1" });

      // Render BETWEEN the two equal-timestamp appends: the first event must
      // advance the cursor before the second is written.
      overlay.render();
      expect(viewState.notification?.message).toContain("completed");

      appendFeedEvent(cwd, { ts, agent: "crew", type: "crew.idle", preview: "outstanding work" });
      overlay.render();
      // The later idle event is not suppressed by its equal timestamp; it
      // queues behind the still-visible done flash and then actually displays.
      expect(viewState.pendingNotifications.join(" ")).toContain("crew idle");
      vi.advanceTimersByTime(2001);
      overlay.render();
      expect(viewState.notification?.message).toContain("crew idle");
    } finally {
      overlay.dispose();
      vi.useRealTimers();
    }
  });

  it("does not suppress the first sequenced batch after a legacy-only render", () => {
    vi.useFakeTimers();
    const { cwd } = createTempCrewDirs();
    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    fs.mkdirSync(path.dirname(feedFile), { recursive: true });
    fs.writeFileSync(feedFile, `${JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      agent: "LegacyAgent",
      type: "message",
      preview: "legacy line without seq",
    })}\n`);

    const overlay = createOverlay(cwd);
    try {
      overlay.render();
      const viewState = (overlay as any).crewViewState as ReturnType<typeof createCrewViewState>;
      expect(viewState.lastSeenEventSeq).toBe(0);

      appendFeedEvent(cwd, {
        ts: "2026-01-01T00:00:01.000Z",
        agent: "crew",
        type: "task.done",
        target: "task-1",
      });

      overlay.render();
      expect(viewState.notification?.message).toContain("completed");
    } finally {
      overlay.dispose();
      vi.useRealTimers();
    }
  });

  it("overflow preserves an unseen idle flash by dropping the oldest ordinary one", () => {
    vi.useFakeTimers();
    try {
      const viewState = createCrewViewState();
      const tui = { requestRender: vi.fn() } as any;

      // One visible flash, then a full ordinary queue.
      setNotification(viewState, tui, true, "visible", true);
      for (let i = 0; i < 10; i++) {
        setNotification(viewState, tui, true, `ordinary ${i}`, true);
      }
      expect(viewState.pendingNotifications).toHaveLength(10);
      expect(viewState.pendingNotifications[0]).toContain("ordinary 0");

      // Overflow for an idle flash evicts the oldest ordinary entry.
      setNotification(viewState, tui, true, "crew idle — outstanding work", true, true);
      expect(viewState.pendingNotifications).toHaveLength(10);
      expect(viewState.pendingNotifications.join(" ")).toContain("crew idle");
      expect(viewState.pendingNotifications.join(" ")).not.toContain("ordinary 0");

      // A later ordinary overflow likewise keeps idle and drops the next
      // oldest ordinary rather than the idle entry.
      setNotification(viewState, tui, true, "later ordinary", true);
      expect(viewState.pendingNotifications.join(" ")).toContain("crew idle");
      expect(viewState.pendingNotifications.join(" ")).not.toContain("ordinary 1");
      if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flashes two distinct idle transitions observed in separate batches", () => {
    const first = flashEvents([event(11, "crew.idle", { preview: "first transition" })], 10);
    const second = flashEvents([event(12, "crew.idle", { preview: "second transition" })], 11);

    expect(first.notification?.message).toContain("crew idle");
    expect(second.notification?.message).toContain("crew idle");
  });

  it("does not flash an already-seen crew.idle event", () => {
    const viewState = flashEvents([event(11, "crew.idle", { preview: "seen" })], 11);

    expect(viewState.notification).toBeNull();
  });

  it("flashes two unseen idle transitions in one batch as two distinct flashes", () => {
    vi.useFakeTimers();
    try {
      const viewState = flashEvents([
        event(11, "crew.idle", { preview: "first transition" }),
        event(12, "crew.idle", { preview: "second transition" }),
      ], 10, true);

      expect(viewState.notification?.message).toContain("crew idle");
      expect(viewState.pendingNotifications).toHaveLength(1);
      expect(viewState.pendingNotifications[0]).toContain("crew idle");

      // After the first flash expires the queued transition is shown, so both
      // transitions surface instead of being coalesced into one.
      vi.advanceTimersByTime(2000);
      expect(viewState.notification?.message).toContain("crew idle");
      expect(viewState.pendingNotifications).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flashes equal-timestamp events separately (identity is seq, not ts)", () => {
    vi.useFakeTimers();
    try {
      const ts = "2026-01-01T00:00:02.000Z";
      const viewState = flashEvents([
        { ts, seq: 21, agent: "crew", type: "task.done", target: "task-1" },
        { ts, seq: 22, agent: "crew", type: "task.block", target: "task-2", preview: "stuck" },
      ], 20, true);

      expect(viewState.notification?.message).toContain("completed");
      expect(viewState.pendingNotifications.join(" ")).toContain("blocked");
      vi.advanceTimersByTime(2000);
      expect(viewState.notification?.message).toContain("blocked");
    } finally {
      vi.useRealTimers();
    }
  });
});
