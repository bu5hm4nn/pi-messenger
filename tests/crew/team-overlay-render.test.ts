import { describe, expect, it, vi } from "vitest";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";
import * as store from "../../crew/store.ts";
import * as teamStore from "../../crew/team/store.ts";
import { renderStatusBar, renderTaskList } from "../../overlay-render.ts";
import { createCrewViewState } from "../../overlay-actions.ts";
import { MessengerOverlay } from "../../overlay.ts";
import type { FeedEvent } from "../../feed.ts";

const theme = { fg: (_color: string, text: string) => text } as any;

function flashEvents(events: FeedEvent[], prevTs: string | null) {
  const tui = { requestRender: vi.fn() } as any;
  const overlay = Object.create(MessengerOverlay.prototype) as any;
  overlay.crewViewState = createCrewViewState();
  overlay.tui = tui;
  overlay.detectAndFlashEvents(events, prevTs);
  const viewState = overlay.crewViewState as ReturnType<typeof createCrewViewState>;
  if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  return viewState;
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
      {
        ts: "2026-01-01T00:00:01.000Z",
        agent: "crew",
        type: "crew.idle",
        preview: "All crew workers exited with outstanding work: task-1",
      },
    ], "2026-01-01T00:00:00.000Z");

    expect(viewState.notification?.message).toContain("crew idle");
    expect(viewState.notification?.message).not.toContain("crew.idle");
  });

  it("keeps sameType pluralization for repeated crew.idle events", () => {
    const viewState = flashEvents([
      { ts: "2026-01-01T00:00:01.000Z", agent: "crew", type: "crew.idle", preview: "first" },
      { ts: "2026-01-01T00:00:02.000Z", agent: "crew", type: "crew.idle", preview: "second" },
    ], "2026-01-01T00:00:00.000Z");

    expect(viewState.notification?.message).toContain("2 crew idle events");
  });

  it("does not flash an already-seen crew.idle event", () => {
    const viewState = flashEvents([
      { ts: "2026-01-01T00:00:00.000Z", agent: "crew", type: "crew.idle", preview: "seen" },
    ], "2026-01-01T00:00:00.000Z");

    expect(viewState.notification).toBeNull();
  });
});
