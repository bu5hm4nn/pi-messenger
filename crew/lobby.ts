/**
 * Crew - Lobby Workers
 *
 * Spawns idle workers that join the mesh, explore the project, and chat
 * while waiting for task assignments. When tasks become available, they
 * receive assignments via steer message and transition to work mode.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateMemorableName } from "../lib.ts";
import { resolveThinking, modelHasThinkingSuffix, pushModelArgs, getPiCommand, resolveModel } from "./agents.ts";
import { discoverCrewAgents } from "./utils/discover.ts";
import { loadCrewConfig, type CrewConfig } from "./utils/config.ts";
import {
  createProgress,
  parseJsonlLine,
  updateProgress,
} from "./utils/progress.ts";
import { updateLiveWorker, removeLiveWorker } from "./live-progress.ts";
import * as store from "./store.ts";
import { isAutonomousForCwd } from "./state.ts";
import { getLiveWorkers } from "./registry.ts";
import { logFeedEvent } from "../feed.ts";
import {
  registerWorker,
  unregisterWorker,
  getLobbyWorkers as registryGetLobbyWorkers,
  getAvailableLobbyWorkers as registryGetAvailableLobbyWorkers,
  getLobbyWorkerCount as registryGetLobbyWorkerCount,
  hasActiveWorker,
  type LobbyWorkerEntry,
} from "./registry.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");

// Idle advisories are transition-based: report on entering the idle state,
// not on an elapsed-time window, so two distinct transitions inside a couple
// of seconds both surface. Intentional teardown suppresses detection entirely.
const idleActive = new Map<string, boolean>();
const intentionalShutdown = new Set<string>();

export const LOBBY_TOKEN_BUDGETS: Record<string, number> = {
  none: 10_000,
  minimal: 20_000,
  moderate: 50_000,
  chatty: 100_000,
};

export type LobbyWorker = LobbyWorkerEntry;

function lobbyTaskId(id: string): string {
  return `__lobby-${id}__`;
}

export interface LobbySpawnOptions {
  /** Task this worker is being spawned for (single-task spawn path). */
  taskId?: string;
  /** Dispatch reservation minted for that task. */
  dispatchToken?: string;
  /** Pre-allocated display name (the claim records the same identity). */
  name?: string;
}

function allocateLobbyWorkerName(cwd: string): string {
  let name = generateMemorableName();
  for (let i = 0; i < 5; i++) {
    const existing = registryGetLobbyWorkers(cwd);
    const collision = existing.some(w => w.name === name && w.proc.exitCode === null);
    if (!collision) break;
    name = generateMemorableName();
  }
  return name;
}

export function spawnLobbyWorker(
  cwd: string,
  promptOverride?: string,
  sessionModel?: string,
  options?: LobbySpawnOptions,
): LobbyWorker | null {
  const agents = discoverCrewAgents(cwd);
  const workerConfig = agents.find(a => a.name === "crew-worker");
  if (!workerConfig) return null;

  const crewDir = store.getCrewDir(cwd);
  const config = loadCrewConfig(crewDir);
  // A new worker means the crew has left the idle state (and a fresh run is no
  // longer an intentional shutdown).
  intentionalShutdown.delete(cwd);
  idleActive.delete(cwd);
  const id = randomUUID().slice(0, 6);
  const name = options?.name ?? allocateLobbyWorkerName(cwd);
  const prompt = promptOverride ?? buildLobbyPrompt(cwd, config);

  // `-ne` (--no-extensions) disables automatic extension discovery and the
  // built-in extensions for the worker session; only explicitly passed
  // `--extension` paths load. Those paths are EXTENSION_DIR (pi-messenger) plus
  // path-valued `tools` frontmatter entries of the crew-worker agent. A project
  // that explicitly lists another extension (intercom, scrumble, …) will load
  // it — `-ne` guarantees no automatic discovery, not isolation. Without it,
  // every extension installed for the orchestrator also loads inside the
  // crew worker and can deliver messages mid-prompt (the intercom/watcher
  // crash).
  const args = ["--mode", "json", "--no-session", "-ne", "-p"];
  const model = resolveModel(undefined, undefined, undefined, config.models?.worker, sessionModel, workerConfig.model);
  if (model) pushModelArgs(args, model);

  const thinking = resolveThinking(
    config.thinking?.worker,
    workerConfig.thinking,
  );
  if (thinking && !modelHasThinkingSuffix(model)) {
    args.push("--thinking", thinking);
  }

  if (workerConfig.tools?.length) {
    const builtinTools: string[] = [];
    const extensionPaths: string[] = [];
    for (const tool of workerConfig.tools) {
      if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
        extensionPaths.push(tool);
      } else {
        builtinTools.push(tool);
      }
    }
    if (builtinTools.length > 0) args.push("--tools", builtinTools.join(","));
    for (const ext of extensionPaths) args.push("--extension", ext);
  }

  args.push("--extension", EXTENSION_DIR);

  let promptTmpDir: string | null = null;
  if (workerConfig.systemPrompt) {
    promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-lobby-"));
    const promptPath = path.join(promptTmpDir, "crew-worker.md");
    fs.writeFileSync(promptPath, workerConfig.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
  }

  args.push(prompt);

  const envOverrides = config.work.env ?? {};
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
    PI_AGENT_NAME: name,
    PI_CREW_WORKER: "1",
    PI_LOBBY_ID: id,
    // Dispatch token is attached by the extension; workers never copy it.
    ...(options?.dispatchToken ? { PI_CREW_DISPATCH: options.dispatchToken } : {}),
  };

  const proc = spawn(getPiCommand(), args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const aliveFile = path.join(crewDir, `lobby-${id}.alive`);
  try { fs.writeFileSync(aliveFile, "", { mode: 0o600 }); } catch {}

  const taskId = lobbyTaskId(id);
  const worker: LobbyWorkerEntry = {
    type: "lobby",
    lobbyId: id,
    name,
    cwd,
    proc,
    taskId,
    startedAt: Date.now(),
    assignedTaskId: options?.taskId ?? null,
    dispatchToken: options?.dispatchToken,
    coordination: config.coordination ?? "chatty",
    promptTmpDir,
    aliveFile,
  };

  registerWorker(worker);

  const progress = createProgress("crew-worker");

  let jsonlBuffer = "";
  proc.stdout?.on("data", (data) => {
    try {
      jsonlBuffer += data.toString();
      const lines = jsonlBuffer.split("\n");
      jsonlBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseJsonlLine(line);
        if (event) {
          updateProgress(progress, event, worker.startedAt);
          const displayId = worker.assignedTaskId ?? taskId;
          updateLiveWorker(cwd, displayId, {
            taskId: displayId,
            agent: "crew-worker",
            name,
            progress: { ...progress, recentTools: progress.recentTools.map(t => ({ ...t })) },
            startedAt: worker.startedAt,
          });
          if (!worker.assignedTaskId) {
            const currentConfig = loadCrewConfig(crewDir);
            const budget = LOBBY_TOKEN_BUDGETS[currentConfig.coordination ?? "chatty"] ?? LOBBY_TOKEN_BUDGETS.chatty;
            if (progress.tokens > budget) {
              proc.kill("SIGTERM");
            }
          }
        }
      }
    } catch {}
  });

  proc.on("close", (exitCode) => {
    try {
    const displayId = worker.assignedTaskId ?? taskId;
    removeLiveWorker(cwd, displayId);
    unregisterWorker(cwd, taskId);
    if (worker.promptTmpDir) {
      try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
    if (worker.assignedTaskId) {
      // One shared guarded exit: the ownership/token check and the write happen
      // inside the mutation, so a task that was reassigned or completed while
      // this worker was dying is left untouched. A guard timeout is logged and
      // swallowed: a dying worker must never crash the lobby host.
      const config = loadCrewConfig(store.getCrewDir(cwd));
      let exit: store.ExitAttemptResult | null = null;
      try {
        exit = store.exitAttempt(cwd, worker.assignedTaskId, {
          owner: worker.name,
          dispatchToken: worker.dispatchToken,
          maxAttempts: config.work.maxAttemptsPerTask,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof store.TaskLockTimeoutError) {
          console.error(`[pi-messenger] lobby exit for ${worker.assignedTaskId} timed out: ${message}`);
        } else {
          console.error(`[pi-messenger] lobby exit for ${worker.assignedTaskId} failed: ${message}`);
        }
      }

      if (exit?.outcome === "blocked" || exit?.outcome === "todo") {
        // The shared exit returns the validated prior-attempt snapshot. Record
        // the reconcile note for BOTH owned outcomes (todo and cap-block), so a
        // final allowed attempt still carries its base anchor.
        const prior = exit.previous ?? exit.task;
        const baseRef = prior?.base_commit ? ` Prior attempt base commit: ${prior.base_commit}.` : "";
        const neverStarted = exit.previous?.status === "todo";
        const wording = neverStarted
          ? "before task.start — work may not have started — verify state before retrying."
          : "before task.done — indeterminate: work may have landed; verify commits/tests on disk before re-implementing.";
        const suffix = exit.outcome === "blocked" ? " Blocked at max attempts." : " Reset to todo.";
        try {
          store.appendTaskProgress(cwd, worker.assignedTaskId, "system",
            `Lobby worker ${worker.name} exited (code ${exitCode ?? "unknown"}) ${wording}${baseRef}${suffix}`);
        } catch (progressErr) {
          // A dying worker must never crash the lobby host because another
          // writer holds the progress append path.
          console.error(`[pi-messenger] lobby progress note for ${worker.assignedTaskId} failed: ${progressErr instanceof Error ? progressErr.message : progressErr}`);
        }
        if (exit.outcome === "blocked") {
          logFeedEvent(cwd, worker.name, "task.block", worker.assignedTaskId, `Max attempts reached`);
        } else {
          logFeedEvent(cwd, worker.name, "task.reset", worker.assignedTaskId, "worker exited");
        }
      } else if (exit?.outcome === "changed") {
        // Owner/token mismatch: only the rejection reason, never a reset or
        // reconcile note that could be mistaken for this worker's attempt.
        const current = store.getTask(cwd, worker.assignedTaskId);
        try {
          store.appendTaskProgress(cwd, worker.assignedTaskId, "system",
            `Ignored stale exit from ${worker.name}: task holds a different reservation or completion (status ${current?.status ?? "missing"}); left untouched.`);
        } catch (progressErr) {
          console.error(`[pi-messenger] lobby stale-exit note for ${worker.assignedTaskId} failed: ${progressErr instanceof Error ? progressErr.message : progressErr}`);
        }
      }
    } else {
      logFeedEvent(cwd, worker.name, "leave", undefined, `Lobby worker exited (code ${exitCode ?? "unknown"})`);
    }
    // Crew-empty detection: fires from the lobby close handler only — regular
    // spawnAgents workers are awaited synchronously by work.execute(), so a
    // lobby worker exiting autonomously is the one case where the orchestrator
    // is NOT already in control and an idle advisory is meaningful.
    // Intentional teardown (session shutdown) suppresses it: those close
    // handlers can run while the autonomous flag is still set, but they are
    // not a crew going idle. Node serializes close handlers, so marking
    // idleActive on the first report suppresses duplicate simultaneous exits;
    // a later lobby-worker spawn clears the flag, allowing the next genuine
    // transition to report.
    try {
      if (intentionalShutdown.has(cwd)) {
        idleActive.delete(cwd);
        return;
      }
      if (isAutonomousForCwd(cwd)) {
        // getLiveWorkers treats any process that has not exited as live.
        // Deliberately no !proc.killed check: `killed` means a signal was sent,
        // not that the process died — excluding such workers could fire idle
        // while a shutdown-in-flight worker is still running.
        const liveOthers = getLiveWorkers(cwd).filter(w => w !== worker);
        const outstanding = store.getTasks(cwd).filter(t => t.status === "todo" || t.status === "in_progress");
        const idleNow = liveOthers.length === 0 && outstanding.length > 0;
        if (!idleNow) {
          idleActive.set(cwd, false);
          return;
        }
        if (idleActive.get(cwd)) return;
        // Mark the transition reported only after the append actually landed.
        // A feed-lock timeout leaves it unreported so a later close re-emits the
        // same transition; a successful append gates the re-emit.
        const reported = logFeedEvent(cwd, "crew", "crew.idle", undefined,
          `All crew workers exited with outstanding work: ${outstanding.map(t => t.id).join(", ")}. Autonomous continuation should resume them; if the session stopped, run pi_messenger({ action: "work", autonomous: true }).`);
        if (reported) idleActive.set(cwd, true);
      } else {
        idleActive.set(cwd, false);
      }
    } catch (e) {
      console.error(`[pi-messenger] crew.idle detection failed: ${e instanceof Error ? e.message : e}`);
    }
    } catch (e) {
      // The close callback runs in the orchestrator's process and must never
      // throw: log and leave the reservation for the next recovery pass.
      console.error(`[pi-messenger] lobby close handler failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  updateLiveWorker(cwd, taskId, {
    taskId,
    agent: "crew-worker",
    name,
    progress: { ...progress, recentTools: [] },
    startedAt: worker.startedAt,
  });

  return worker;
}

export function getLobbyWorkerCount(cwd: string): number {
  return registryGetLobbyWorkerCount(cwd);
}

export function getAvailableLobbyWorkers(cwd: string): LobbyWorker[] {
  return registryGetAvailableLobbyWorkers(cwd);
}

export function assignTaskToLobbyWorker(
  worker: LobbyWorker,
  taskId: string,
  taskPrompt: string,
  inboxDir: string,
  dispatchToken?: string,
): boolean {
  if (worker.assignedTaskId) return false;
  if (worker.proc.exitCode !== null) return false;

  const targetInbox = path.join(inboxDir, worker.name);
  try { fs.mkdirSync(targetInbox, { recursive: true }); } catch {}

  const msg = {
    id: randomUUID(),
    from: "crew-orchestrator",
    to: worker.name,
    text: `# ⚡ TASK ASSIGNMENT — SWITCH TO WORK MODE

Drop your current activity and work on this task immediately.

**IMPORTANT:** This task is already claimed and started for you — do NOT call \`task.start\`. Follow the assignment below, including any Team role or read-only instructions, then mark complete with \`task.done\`.

${taskPrompt}`,
    timestamp: new Date().toISOString(),
    replyTo: null,
    // Structured (not prompt text) so the worker extension can attach the
    // trusted reservation to task.done/block/reset without the model typing it.
    // The task id and lobby instance let the receiver verify the message
    // against the live reservation and the exact warm worker it was written for.
    ...(dispatchToken ? { dispatchToken, taskId, lobbyId: worker.lobbyId } : {}),
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = path.join(targetInbox, `${Date.now()}-${random}.json`);
  const aliveFile = worker.aliveFile;
  if (aliveFile) {
    try { fs.unlinkSync(aliveFile); } catch {}
  }
  try {
    fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));
  } catch {
    if (aliveFile) {
      try { fs.writeFileSync(aliveFile, "", { mode: 0o600 }); } catch {}
    }
    return false;
  }

  removeLiveWorker(worker.cwd, lobbyTaskId(worker.lobbyId));
  worker.assignedTaskId = taskId;
  // The warm worker was spawned before the claim, so it has no dispatch token
  // in its environment. Carry the minted token on the registry entry so the
  // close handler fences with the reservation rather than a reusable name.
  worker.dispatchToken = dispatchToken;
  return true;
}

export function killLobbyWorkerForTask(cwd: string, taskId: string): boolean {
  const all = registryGetLobbyWorkers(cwd);
  for (const worker of all) {
    if (worker.assignedTaskId !== taskId) continue;
    if (worker.proc.exitCode === null) {
      worker.proc.kill("SIGTERM");
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
    return true;
  }
  return false;
}

export function shutdownLobbyWorkers(cwd: string): void {
  // Session shutdown is intentional teardown, not the crew going idle: the
  // autonomous flag may still be set while close handlers fire.
  intentionalShutdown.add(cwd);
  idleActive.delete(cwd);
  const all = registryGetLobbyWorkers(cwd);
  for (const worker of all) {
    if (worker.proc.exitCode === null) {
      worker.proc.kill("SIGTERM");
    }
    const displayId = worker.assignedTaskId ?? worker.taskId;
    removeLiveWorker(cwd, displayId);
    unregisterWorker(cwd, worker.taskId);
    if (worker.promptTmpDir) {
      try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
    }
    if (worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
  }

  const crewDir = store.getCrewDir(cwd);
  try {
    for (const f of fs.readdirSync(crewDir)) {
      if (f.startsWith("lobby-") && f.endsWith(".alive")) {
        try { fs.unlinkSync(path.join(crewDir, f)); } catch {}
      }
    }
  } catch {}
}

export function cleanupUnassignedAliveFiles(cwd: string): void {
  const workers = registryGetLobbyWorkers(cwd);
  for (const worker of workers) {
    if (!worker.assignedTaskId && worker.aliveFile) {
      try { fs.unlinkSync(worker.aliveFile); } catch {}
    }
  }
}

export function spawnWorkerForTask(
  cwd: string,
  taskId: string,
  taskPrompt: string,
  sessionModel?: string,
): LobbyWorker | null {
  const task = store.getTask(cwd, taskId);
  if (!task || task.status !== "todo" || task.dispatch_token) return null;
  if (hasActiveWorker(cwd, taskId)) return null;

  const config = loadCrewConfig(store.getCrewDir(cwd));
  // The worker identity must exist before the claim: the reservation records
  // assigned_to, and both task.start and the receipt are fenced by it.
  const workerName = allocateLobbyWorkerName(cwd);
  let claimed: Awaited<ReturnType<typeof store.claimTaskForDispatch>>;
  try {
    claimed = store.claimTaskForDispatch(cwd, taskId, workerName, {
      maxAttempts: config.work.maxAttemptsPerTask,
    });
  } catch (err) {
    // A guard timeout rejects only this spawn; callers continue their loop.
    if (err instanceof store.TaskLockTimeoutError) return null;
    throw err;
  }
  if (!claimed || !claimed.dispatch_token) return null;
  const dispatchToken = claimed.dispatch_token;

  const baseCommit = store.getBaseCommit(cwd); // git never runs inside the guard
  let started: Awaited<ReturnType<typeof store.startTask>>;
  try {
    started = store.startTask(cwd, taskId, workerName, { baseCommit, dispatchToken });
  } catch (err) {
    if (err instanceof store.TaskLockTimeoutError) {
      try { store.releaseDispatch(cwd, taskId, dispatchToken); } catch {}
      return null;
    }
    throw err;
  }
  if (!started) {
    store.releaseDispatch(cwd, taskId, dispatchToken);
    return null;
  }

  const worker = spawnLobbyWorker(cwd, taskPrompt, sessionModel, {
    taskId,
    dispatchToken,
    name: workerName,
  });
  if (!worker) {
    // Launch failed after the claim: release this dispatch's reservation.
    store.exitAttempt(cwd, taskId, {
      owner: workerName,
      dispatchToken,
      maxAttempts: config.work.maxAttemptsPerTask,
    });
    return null;
  }

  removeLiveWorker(cwd, lobbyTaskId(worker.lobbyId));
  if (worker.aliveFile) {
    try { fs.unlinkSync(worker.aliveFile); } catch {}
  }
  store.appendTaskProgress(cwd, taskId, "system", `Assigned to worker ${worker.name} (attempt ${claimed.attempt_count})`);
  logFeedEvent(cwd, worker.name, "task.start", taskId, task.title);

  return worker;
}

export function removeLobbyWorkerByIndex(cwd: string): boolean {
  const available = registryGetAvailableLobbyWorkers(cwd);
  if (available.length === 0) return false;
  const worker = available[0];
  if (worker.proc.exitCode === null) {
    worker.proc.kill("SIGTERM");
  }
  removeLiveWorker(cwd, worker.taskId);
  unregisterWorker(cwd, worker.taskId);
  if (worker.promptTmpDir) {
    try { fs.rmSync(worker.promptTmpDir, { recursive: true, force: true }); } catch {}
  }
  if (worker.aliveFile) {
    try { fs.unlinkSync(worker.aliveFile); } catch {}
  }
  return true;
}

function buildLobbyPrompt(cwd: string, config: CrewConfig): string {
  const plan = store.getPlan(cwd);
  const prdPath = plan?.prd;
  const level = config.coordination ?? "chatty";

  let prompt = `# Crew Lobby

You're a crew worker waiting for the team's plan to be finalized. There's no task for you yet — hang tight.

## Step 1: Join the Mesh

\`\`\`typescript
pi_messenger({ action: "join" })
\`\`\`

## Step 2: Get Familiar

`;

  if (level === "none") {
    prompt += `Skip this step — you'll get full context when your task arrives.

`;
  } else if (prdPath) {
    prompt += `Read the PRD to understand what the team is building:

\`\`\`typescript
read("${prdPath}")
\`\`\`

`;
  }

  if (level === "chatty" || level === "moderate") {
    prompt += `Briefly explore the project structure to get oriented. Don't go deep — save your budget for the actual task.

`;
  }

  if (level === "chatty") {
    prompt += `## Step 3: Share Your Findings

Post updates to the team feed while you wait — the user watches it live. Other workers will see your broadcasts when they receive their task assignment.

- **Introduce yourself** — broadcast a greeting when you join
- **Share observations** — broadcast anything interesting you notice about the PRD
- **Respond to DMs** — if someone messages you directly, reply briefly

**Hard limit: send at most 5 messages total (broadcasts + DMs combined).** After that, stop messaging and wait quietly. Save your context for the actual task.

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Hey team! Just joined. Reading the PRD now..." })
\`\`\`

After sending your messages, wait for a **TASK ASSIGNMENT** message.
`;
  } else if (level === "moderate") {
    prompt += `## Step 3: Brief Check-in

Announce yourself, then wait:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Joined the lobby. Reading the PRD..." })
\`\`\`

**Hard limit: send at most 2 messages total.** You may reply once if someone DMs you. Then stop messaging and wait.

Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else if (level === "minimal") {
    prompt += `## Step 3: Wait for Assignment

Announce your presence with one broadcast, then wait:

\`\`\`typescript
pi_messenger({ action: "broadcast", message: "Standing by for task assignment." })
\`\`\`

**Do NOT send any other messages.** Wait for a **TASK ASSIGNMENT** message to begin work.
`;
  } else {
    prompt += `## Step 3: Wait

**Do NOT send any messages, do NOT explore the codebase.** Wait for a **TASK ASSIGNMENT** message.
`;
  }

  prompt += `
## When You Receive a Task Assignment

You will receive a message with the header **⚡ TASK ASSIGNMENT**. When you get it:

1. Read the task details carefully — the assignment message has specific instructions
2. Reserve files you'll modify
3. Implement the feature following the spec
4. Run tests to verify
5. Commit your changes
6. Release reservations and mark complete

The task will already be claimed and started for you — do NOT call \`task.start\`. Switch to full work mode immediately — no more lobby chat.
`;

  return prompt;
}
