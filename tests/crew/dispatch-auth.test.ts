import { afterEach, describe, expect, it } from "vitest";
import { trustedMailedDispatchToken, type AgentMailMessage } from "../../lib.ts";
import * as store from "../../crew/store.ts";
import { executeTaskAction } from "../../crew/task-actions.ts";
import { createTempCrewDirs } from "../helpers/temp-dirs.ts";

function message(overrides: Partial<AgentMailMessage>): AgentMailMessage {
  return {
    id: "msg-1",
    from: "crew-orchestrator",
    to: "WarmWorker",
    text: "assignment",
    timestamp: new Date().toISOString(),
    replyTo: null,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.PI_CREW_WORKER;
  delete process.env.PI_LOBBY_ID;
});

describe("dispatch assignment authentication", () => {
  it("accepts only the exact live reservation for the recorded warm lobby instance", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "WarmWorker")!;
    store.startTask(cwd, task.id, "WarmWorker", { dispatchToken: claimed.dispatch_token });

    const current = store.getTask(cwd, task.id);
    const good = message({
      taskId: task.id,
      dispatchToken: claimed.dispatch_token,
      lobbyId: "lobby-1",
    });
    expect(trustedMailedDispatchToken(good, {
      isCrewWorker: true,
      selfName: "WarmWorker",
      lobbyId: "lobby-1",
      task: current,
    })).toBe(claimed.dispatch_token);

    // A different warm instance with a reused/forged name is refused.
    expect(trustedMailedDispatchToken(good, {
      isCrewWorker: true,
      selfName: "WarmWorker",
      lobbyId: "lobby-2",
      task: current,
    })).toBeUndefined();
  });

  it("rejects a replayed assignment while leaving the newer reservation intact", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");

    const old = store.claimTaskForDispatch(cwd, task.id, "WarmWorker")!;
    store.startTask(cwd, task.id, "WarmWorker", { dispatchToken: old.dispatch_token });
    store.resetTask(cwd, task.id);
    const current = store.claimTaskForDispatch(cwd, task.id, "WarmWorker")!;
    store.startTask(cwd, task.id, "WarmWorker", { dispatchToken: current.dispatch_token });

    const replayed = message({
      taskId: task.id,
      dispatchToken: old.dispatch_token,
      lobbyId: "lobby-1",
    });
    expect(trustedMailedDispatchToken(replayed, {
      isCrewWorker: true,
      selfName: "WarmWorker",
      lobbyId: "lobby-1",
      task: store.getTask(cwd, task.id),
    })).toBeUndefined();

    const after = store.getTask(cwd, task.id)!;
    expect(after.dispatch_token).toBe(current.dispatch_token);
    expect(after.assigned_to).toBe("WarmWorker");
    expect(after.status).toBe("in_progress");
  });

  it("cold workers never accept a token from mail", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "ColdWorker")!;
    store.startTask(cwd, task.id, "ColdWorker", { dispatchToken: claimed.dispatch_token });

    expect(trustedMailedDispatchToken(message({
      to: "ColdWorker",
      taskId: task.id,
      dispatchToken: claimed.dispatch_token,
      lobbyId: "lobby-1",
    }), {
      isCrewWorker: true,
      selfName: "ColdWorker",
      lobbyId: undefined, // cold worker: spawn env is the only token source
      task: store.getTask(cwd, task.id),
    })).toBeUndefined();
  });

  it("rejects assignment mail whose task id does not select the token", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const other = store.createTask(cwd, "Task two", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "WarmWorker")!;
    store.startTask(cwd, task.id, "WarmWorker", { dispatchToken: claimed.dispatch_token });

    expect(trustedMailedDispatchToken(message({
      taskId: other.id,
      dispatchToken: claimed.dispatch_token,
      lobbyId: "lobby-1",
    }), {
      isCrewWorker: true,
      selfName: "WarmWorker",
      lobbyId: "lobby-1",
      task: store.getTask(cwd, other.id),
    })).toBeUndefined();
  });
});

describe("tokenless crew task actions", () => {
  it("refuses a worker without a token on token-bearing block/reset attempts", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "CrewWorker")!;
    store.startTask(cwd, task.id, "CrewWorker", { dispatchToken: claimed.dispatch_token });

    process.env.PI_CREW_WORKER = "1";
    const blocked = executeTaskAction(cwd, "block", task.id, "CrewWorker", "no token");
    const reset = executeTaskAction(cwd, "reset", task.id, "CrewWorker");

    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("dispatch_token_required");
    expect(blocked.message).toContain("operator sessions with no crew identity");
    expect(reset.success).toBe(false);
    expect(reset.error).toBe("dispatch_token_required");

    const after = store.getTask(cwd, task.id)!;
    expect(after.status).toBe("in_progress");
    expect(after.dispatch_token).toBe(claimed.dispatch_token);
  });

  it("keeps the unfenced operator takeover path for sessions without crew identity", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "CrewWorker")!;
    store.startTask(cwd, task.id, "CrewWorker", { dispatchToken: claimed.dispatch_token });

    delete process.env.PI_CREW_WORKER;
    delete process.env.PI_LOBBY_ID;
    const blocked = executeTaskAction(cwd, "block", task.id, "Operator", "operator takeover");
    expect(blocked.success).toBe(true);
    expect(store.getTask(cwd, task.id)?.status).toBe("blocked");
  });

  it("accepts a worker that presents the live token", () => {
    const { cwd } = createTempCrewDirs();
    store.createPlan(cwd, "docs/PRD.md");
    const task = store.createTask(cwd, "Task one", "Desc");
    const claimed = store.claimTaskForDispatch(cwd, task.id, "CrewWorker")!;
    store.startTask(cwd, task.id, "CrewWorker", { dispatchToken: claimed.dispatch_token });

    process.env.PI_CREW_WORKER = "1";
    const blocked = executeTaskAction(cwd, "block", task.id, "CrewWorker", "real blocker", {
      dispatchToken: claimed.dispatch_token,
    });
    expect(blocked.success).toBe(true);
    expect(store.getTask(cwd, task.id)?.status).toBe("blocked");
  });
});
