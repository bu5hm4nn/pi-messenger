import { describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import * as store from "../../crew/store.ts";
import * as teamStore from "../../crew/team/store.ts";
import { renderStatusBar, renderTaskList } from "../../overlay-render.ts";
import { createCrewViewState } from "../../overlay-actions.ts";
import { MessengerOverlay } from "../../overlay.ts";
import type { FeedEvent } from "../../feed.ts";

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
