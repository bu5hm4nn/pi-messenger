import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export function createMockContext(cwd: string = process.cwd()): ExtensionContext {
  // The handlers under test only use this subset of the SDK context.
  const context = {
    hasUI: true,
    cwd,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn(),
    } satisfies Pick<ExtensionContext["ui"], "notify" | "setStatus" | "custom"> & {
      theme: Pick<ExtensionContext["ui"]["theme"], "fg">;
    },
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "test-session",
    } satisfies Pick<ExtensionContext["sessionManager"], "getEntries" | "getSessionId">,
    model: "test-model",
  };
  return context as unknown as ExtensionContext;
}
