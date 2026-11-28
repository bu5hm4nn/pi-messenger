import type { AgentProgress } from "../../crew/utils/progress.ts";

export function makeAgentProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
  return {
    agent: "test",
    status: "completed",
    recentTools: [],
    toolCallCount: 0,
    tokens: 0,
    durationMs: 0,
    ...overrides,
  };
}
