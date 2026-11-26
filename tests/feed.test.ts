import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendFeedEvent, formatFeedLine, isCrewEvent, logFeedEvent, pruneFeed, readFeedEvents } from "../feed.ts";
import { acquireDirMutex, releaseDirMutex } from "../dir-mutex.ts";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";

describe("feed", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempCrewDirs().cwd;
  });

  it("writes events to the project-scoped feed path", () => {
    logFeedEvent(cwd, "AgentOne", "join");

    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    expect(fs.existsSync(feedFile)).toBe(true);
    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
  });

  it("reads events back in append order and respects limit", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "src/app.ts");
    logFeedEvent(cwd, "AgentOne", "commit", undefined, "ship feed scope");

    const allEvents = readFeedEvents(cwd, 20);
    expect(allEvents).toHaveLength(3);
    expect(allEvents.map(e => e.type)).toEqual(["join", "edit", "commit"]);

    const limited = readFeedEvents(cwd, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map(e => e.type)).toEqual(["edit", "commit"]);
  });

  it("reads a bounded tail across chunks and skips malformed records", () => {
    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    fs.mkdirSync(path.dirname(feedFile), { recursive: true });
    const events = Array.from({ length: 600 }, (_, i) => JSON.stringify({
      ts: new Date(1_700_000_000_000 + i).toISOString(),
      agent: "AgentOne",
      type: "message",
      preview: `${i}:${"x".repeat(128)}`,
    }));
    events.splice(599, 0, "{malformed");
    fs.writeFileSync(feedFile, `${events.join("\n")}\n`);

    expect(readFeedEvents(cwd, 2).map(event => event.preview?.split(":")[0])).toEqual(["598", "599"]);
  });

  it("assigns a strictly increasing seq at write time, even for equal timestamps", () => {
    const ts = new Date("2026-01-01T00:00:00.000Z").toISOString();
    // Two writers, same millisecond: identity must still be distinct.
    appendFeedEvent(cwd, { ts, agent: "AgentOne", type: "task.done", target: "task-1" });
    appendFeedEvent(cwd, { ts, agent: "AgentOne", type: "crew.idle" });

    const events = readFeedEvents(cwd, 20);
    expect(events.map(event => event.ts)).toEqual([ts, ts]);
    expect(events.map(event => event.seq)).toEqual([1, 2]);

    // The sequence survives pruning: it is part of the line, not a position.
    pruneFeed(cwd, 1);
    expect(readFeedEvents(cwd, 20).map(event => event.seq)).toEqual([2]);
  });

  it("returns no events for non-positive limits", () => {
    logFeedEvent(cwd, "AgentOne", "join");

    expect(readFeedEvents(cwd, 0)).toEqual([]);
    expect(readFeedEvents(cwd, -5)).toEqual([]);
  });

  it("isolates feeds between project directories", () => {
    const otherCwd = createTempCrewDirs().cwd;

    logFeedEvent(cwd, "AgentOne", "join");

    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
    expect(readFeedEvents(otherCwd, 20)).toEqual([]);
  });

  it("prunes events within the project-scoped feed", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "a.ts");
    logFeedEvent(cwd, "AgentOne", "edit", "b.ts");
    logFeedEvent(cwd, "AgentOne", "test", undefined, "passed");

    pruneFeed(cwd, 2);

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(["edit", "test"]);
    expect(events[0]?.target).toBe("b.ts");
  });

  it("reports a dropped append when the feed lock cannot be acquired", () => {
    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    const guard = acquireDirMutex(path.join(path.dirname(feedFile), ".feed-seq"));
    try {
      expect(appendFeedEvent(cwd, {
        ts: new Date().toISOString(),
        agent: "AgentOne",
        type: "task.done",
        target: "task-1",
      })).toBe(false);
    } finally {
      releaseDirMutex(guard);
    }
    expect(readFeedEvents(cwd, 20)).toEqual([]);
  });

  it("does not prune while an append holds the feed-sequence guard", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "a.ts");
    logFeedEvent(cwd, "AgentOne", "edit", "b.ts");
    logFeedEvent(cwd, "AgentOne", "test", undefined, "passed");

    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    const guard = acquireDirMutex(path.join(path.dirname(feedFile), ".feed-seq"));
    try {
      // Contention means skip this prune; it must not rewrite unguarded.
      pruneFeed(cwd, 1);
    } finally {
      releaseDirMutex(guard);
    }
    expect(readFeedEvents(cwd, 20)).toHaveLength(4);

    // A later append keeps its own identity and a guarded prune preserves it.
    appendFeedEvent(cwd, {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "task.done",
      target: "task-1",
    });
    pruneFeed(cwd, 2);
    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.seq)).toEqual([4, 5]);
    expect(events[1]?.target).toBe("task-1");
  });

  it("formats planning events with previews and marks them as crew events", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-11T10:00:00.000Z").toISOString(),
      agent: "Planner",
      type: "plan.pass.start",
      target: "docs/PRD.md",
      preview: "pass 2/3",
    });

    expect(line).toContain("[Crew]");
    expect(line).toContain("planning pass started");
    expect(line).toContain("pass 2/3");
    expect(isCrewEvent("plan.pass.start")).toBe(true);
    expect(isCrewEvent("plan.done")).toBe(true);
    expect(isCrewEvent("message")).toBe(false);
  });

  it("formats DM message events using target for direction", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "Hey, are you exporting the User type?",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("→ OakBear");
    expect(line).toContain("Hey, are you exporting the User type?");
  });

  it("formats broadcast message events with ✦ indicator", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      preview: "Starting task-1 — creating src/auth.ts",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("✦");
    expect(line).toContain("Starting task-1");
    expect(line).not.toContain("→");
  });

  it("truncates long message previews in formatFeedLine", () => {
    const longMsg = "A".repeat(150);
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "Agent",
      type: "message",
      target: "Peer",
      preview: longMsg,
    });
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(200);
  });

  it("normalizes multiline preview text into a single line", () => {
    logFeedEvent(cwd, "AgentOne", "message", "Peer", "Line one\nLine two\tLine three");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.preview).toBe("Line one Line two Line three");

    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "AgentOne",
      type: "commit",
      preview: "feat(scope): add thing\n\nBody details",
    });
    expect(line).toContain("feat(scope): add thing Body details");
    expect(line).not.toContain("\n");
  });

  it("returns an empty array when the feed file does not exist", () => {
    const freshCwd = createTempCrewDirs().cwd;
    expect(readFeedEvents(freshCwd, 20)).toEqual([]);
  });
});
