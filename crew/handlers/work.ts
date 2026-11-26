/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Dirs } from "../../lib.ts";
import { generateMemorableName } from "../../lib.ts";
import type { CrewParams, AppendEntryFn, ReviewFeedback, Task } from "../types.ts";
import { result } from "../utils/result.ts";
import { resolveModel, spawnAgents } from "../agents.ts";
import { loadCrewConfig } from "../utils/config.ts";
import { discoverCrewAgents, discoverCrewSkills } from "../utils/discover.ts";
import { buildWorkerPrompt } from "../prompt.ts";
import * as teamStore from "../team/store.ts";
import { reviewImplementation } from "./review.ts";
import * as store from "../store.ts";
import { getCrewDir } from "../store.ts";
import { autonomousState, isAutonomousForCwd, startAutonomous, stopAutonomous, addWaveResult, clampConcurrency } from "../state.ts";
import { getAvailableLobbyWorkers, assignTaskToLobbyWorker, cleanupUnassignedAliveFiles } from "../lobby.ts";
import { logFeedEvent } from "../../feed.ts";
import { approvalTaskSummaries } from "../utils/task-format.ts";

function revisionHint(taskId: string): string {
  return `pi_messenger({ action: "task.revise", id: "${taskId}", prompt: "Address approval feedback" })`;
}

function rejectedTasksText(tasks: { id: string; title: string; approval?: { feedback?: string } }[]): string {
  if (tasks.length === 0) return "";
  return `\n\nRejected tasks need revision:\n${tasks.map(t => `  - ${t.id}: ${t.title}${t.approval?.feedback ? ` — ${t.approval.feedback}` : ""}\n    Revise with: \`${revisionHint(t.id)}\``).join("\n")}`;
}

export async function execute(
  params: CrewParams,
  dirs: Dirs,
  ctx: ExtensionContext,
  appendEntry: AppendEntryFn,
  signal?: AbortSignal,
  sessionModel?: string,
) {
  const cwd = ctx.cwd;
  const config = loadCrewConfig(getCrewDir(cwd));
  const { autonomous, concurrency: concurrencyOverride } = params;

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("No plan found. Create one first:\n\n  pi_messenger({ action: \"plan\" })\n  pi_messenger({ action: \"plan\", prd: \"path/to/PRD.md\" })", {
      mode: "work",
      error: "no_plan"
    });
  }

  // Check for worker agent
  const availableAgents = discoverCrewAgents(cwd);
  const hasWorker = availableAgents.some(a => a.name === "crew-worker");
  if (!hasWorker) {
    return result("Error: crew-worker agent not found. Required for task execution.", {
      mode: "work",
      error: "no_worker"
    });
  }

  store.autoCompleteMilestones(cwd);
  syncCompletedCount(cwd);

  // Get ready tasks — auto-block any that exceeded max attempts
  const allReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const readyTasks: typeof allReady = [];
  const needsApproval: typeof allReady = [];
  const rejected: typeof allReady = [];
  for (const task of allReady) {
    if (teamStore.taskNeedsRevision(task)) {
      rejected.push(task);
    } else if (teamStore.taskPendingApproval(task)) {
      needsApproval.push(task);
    } else if (task.attempt_count >= config.work.maxAttemptsPerTask) {
      // Re-check under the guard: a reservation acquired between the ready-task
      // snapshot and this write must survive instead of being clobbered.
      const blocked = store.blockTask(cwd, task.id, `Max attempts (${config.work.maxAttemptsPerTask}) reached`, {
        expectedStatus: "todo",
        requireNoDispatchToken: true,
        minAttemptCount: config.work.maxAttemptsPerTask,
      });
      if (blocked) {
        store.appendTaskProgress(cwd, task.id, "system",
          `Auto-blocked after ${task.attempt_count} attempts (max: ${config.work.maxAttemptsPerTask})`);
        logFeedEvent(cwd, "crew", "task.block", task.id, `Max attempts (${config.work.maxAttemptsPerTask}) reached`);
      }
    } else {
      readyTasks.push(task);
    }
  }

  if (readyTasks.length === 0) {
    const tasks = store.getTasks(cwd);
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const blocked = tasks.filter(t => t.status === "blocked");
    const done = tasks.filter(t => t.status === "done");

    let reason = "";
    if (done.length === tasks.length) {
      reason = "🎉 All tasks are done! Plan is complete.";
    } else if (inProgress.length > 0) {
      reason = `${inProgress.length} task(s) in progress: ${inProgress.map(t => t.id).join(", ")}`;
    } else if (rejected.length > 0) {
      reason = "No startable tasks; rejected tasks need revision.";
    } else if (needsApproval.length > 0) {
      reason = "No startable tasks; ready tasks need lead approval.";
    } else if (blocked.length > 0) {
      reason = `${blocked.length} task(s) blocked: ${blocked.map(t => `${t.id} (${t.blocked_reason})`).join(", ")}`;
    } else {
      reason = "All remaining tasks have unmet dependencies.";
    }

    const approvalText = needsApproval.length > 0
      ? `\n\nNeeds approval:\n${needsApproval.map(t => `  - ${t.id}: ${t.title}`).join("\n")}`
      : "";

    const revisionText = rejectedTasksText(rejected);

    return result(`No ready tasks.\n\n${reason}${approvalText}${revisionText}`, {
      mode: "work",
      prd: plan.prd,
      ready: [],
      reason,
      needsApproval: approvalTaskSummaries(needsApproval),
      rejected: approvalTaskSummaries(rejected),
      inProgress: inProgress.map(t => t.id),
      blocked: blocked.map(t => t.id)
    });
  }

  // Determine concurrency
  const requestedConcurrency = concurrencyOverride
    ?? (autonomous && isAutonomousForCwd(cwd)
      ? autonomousState.concurrency
      : config.concurrency.workers);
  autonomousState.concurrency = clampConcurrency(requestedConcurrency, config.concurrency.max);

  // If autonomous mode, set up state and persist (only on first wave or cwd change)
  if (autonomous && !isAutonomousForCwd(cwd)) {
    startAutonomous(cwd, autonomousState.concurrency);
    appendEntry("crew-state", autonomousState);
  }

  const skills = discoverCrewSkills(cwd);

  // A progress note must never abort a wave: the task guard timeout it reports
  // is precisely the case where another writer may also be contending the
  // progress file.
  const appendProgressSafe = (taskId: string, message: string): void => {
    try {
      store.appendTaskProgress(cwd, taskId, "system", message);
    } catch (err) {
      console.error(`[pi-messenger] progress note for ${taskId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Assign tasks to lobby workers first (they're already running and warmed up)
  const prdLabel = store.getPlanLabel(plan);
  const lobbyAssigned = new Set<string>();
  // Per-task launch failures while assigning to warm workers: excluded from
  // the regular spawn queue and reported with the wave's failed receipts.
  const lobbyLaunchFailed = new Set<string>();
  // Actual launch outcomes, not the input queue: a warm failure still counts
  // as attempted and is reported in the wave's failed list.
  const attemptedTaskIds = new Set<string>();
  const lobbyWorkers = getAvailableLobbyWorkers(cwd);
  for (const lobbyWorker of lobbyWorkers) {
    const task = readyTasks.find(t => !lobbyAssigned.has(t.id) && !lobbyLaunchFailed.has(t.id));
    if (!task) break;

    // A lobby claim is a dispatch: it reserves the task, charges the attempt
    // and is released again if delivery to the worker fails. A guard timeout
    // rejects only THIS task; the rest of the wave keeps launching.
    let claimed: Task | null = null;
    try {
      claimed = store.claimTaskForDispatch(cwd, task.id, lobbyWorker.name, {
        maxAttempts: config.work.maxAttemptsPerTask,
      });
    } catch (err) {
      if (err instanceof store.TaskLockTimeoutError) {
        appendProgressSafe(task.id,
          `Lobby dispatch claim timed out for ${task.id}: ${err.message}`);
        attemptedTaskIds.add(task.id);
        lobbyLaunchFailed.add(task.id);
        continue;
      }
      throw err;
    }
    if (!claimed || !claimed.dispatch_token) continue;
    const dispatchToken = claimed.dispatch_token;

    const others = readyTasks.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));
    const baseCommit = store.getBaseCommit(cwd); // git outside the guard
    let started: Task | null = null;
    try {
      started = store.startTask(cwd, task.id, lobbyWorker.name, { baseCommit, dispatchToken });
    } catch (err) {
      if (err instanceof store.TaskLockTimeoutError) {
        attemptedTaskIds.add(task.id);
        lobbyLaunchFailed.add(task.id);
        let releaseError: unknown;
        try {
          store.releaseDispatch(cwd, task.id, dispatchToken);
        } catch (releaseErr) {
          releaseError = releaseErr;
        }
        if (releaseError instanceof store.TaskLockTimeoutError) {
          // Double timeout: the reservation is still held by this lobby
          // identity but no worker ever received it. Leave a visible recovery
          // instruction instead of a silently stuck task.
          appendProgressSafe(task.id,
            `Lobby dispatch start timed out for ${task.id} and the best-effort release also timed out; ` +
            `task remains claimed by ${lobbyWorker.name} (${dispatchToken.slice(0, 8)}) with no worker. ` +
            `Stop all crew writers, then retry task.reset ${task.id} or remove the named task guard. ` +
            `Start error: ${err.message}`);
        } else {
          appendProgressSafe(task.id,
            `Lobby dispatch start timed out for ${task.id}: ${err.message}`);
        }
        continue;
      }
      throw err;
    }
    if (!started) {
      attemptedTaskIds.add(task.id);
      lobbyLaunchFailed.add(task.id);
      appendProgressSafe(task.id,
        `Lobby dispatch start refused for ${task.id} (reservation ${dispatchToken.slice(0, 8)} released); task was not delivered to ${lobbyWorker.name}.`);
      try {
        store.releaseDispatch(cwd, task.id, dispatchToken);
      } catch (err) {
        appendProgressSafe(task.id,
          `Best-effort release after refused start for ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (!assignTaskToLobbyWorker(lobbyWorker, task.id, prompt, dirs.inbox, dispatchToken)) {
      attemptedTaskIds.add(task.id);
      lobbyLaunchFailed.add(task.id);
      appendProgressSafe(task.id,
        `Lobby delivery to ${lobbyWorker.name} failed for ${task.id}; reservation ${dispatchToken.slice(0, 8)} released.`);
      try {
        store.exitAttempt(cwd, task.id, {
          owner: lobbyWorker.name,
          dispatchToken,
          maxAttempts: config.work.maxAttemptsPerTask,
        });
      } catch (err) {
        appendProgressSafe(task.id,
          `Best-effort release after delivery failure for ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    appendProgressSafe(task.id, `Assigned to lobby worker ${lobbyWorker.name} (attempt ${claimed.attempt_count})`);
    logFeedEvent(cwd, lobbyWorker.name, "task.start", task.id, task.title);
    attemptedTaskIds.add(task.id);
    lobbyAssigned.add(task.id);
  }
  cleanupUnassignedAliveFiles(cwd);

  // Build prompts for remaining tasks — spawnAgents throttles via autonomousState.concurrency
  const remainingTasks = readyTasks.filter(t => !lobbyAssigned.has(t.id) && !lobbyLaunchFailed.has(t.id));
  const teamRoles = teamStore.resolveRoles(cwd);
  for (const task of remainingTasks) attemptedTaskIds.add(task.id);
  // Preserve plan order while reflecting actual launch outcomes.
  const attemptedTaskIdsList = readyTasks
    .filter(t => attemptedTaskIds.has(t.id))
    .map(t => t.id);
  const workerTasks = remainingTasks.map(task => {
    const roleName = teamStore.resolveRoleName(cwd, task.role);
    const roleModel = roleName ? teamRoles[roleName]?.model : undefined;
    const taskModel = resolveModel(
      task.model,
      params.model,
      roleModel,
      config.models?.worker,
      sessionModel,
    );
    const others = readyTasks.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));
    // Unique per-dispatch identity: the memorable name stays for display, the
    // suffix makes it safe to fence delayed receipts even when two waves draw
    // the same adjective+noun pair. Ownership is persisted by runAgent at the
    // actual launch point, not here while the queue is built.
    const workerName = `${generateMemorableName()}-${randomUUID().slice(0, 4)}`;

    return {
      agent: "crew-worker",
      workerName,
      task: prompt,
      taskId: task.id,
      modelOverride: taskModel,
    };
  });

  // Mark the run stopped as soon as the signal fires, not after receipts are
  // processed. Aborting the work tool can leave workers draining while their
  // receipts are classified; a lobby worker closing during that window is part
  // of the cancellation, not the crew going idle, so the autonomous flag must
  // already be cleared when its close handler runs.
  let abortHandled = false;
  const handleAbort = () => {
    if (abortHandled) return;
    abortHandled = true;
    if (isAutonomousForCwd(cwd)) {
      stopAutonomous("manual");
      appendEntry("crew-state", autonomousState);
    }
  };
  if (signal) {
    if (signal.aborted) handleAbort();
    else signal.addEventListener("abort", handleAbort, { once: true });
  }

  let workerResults;
  try {
    workerResults = await spawnAgents(
      workerTasks,
      cwd,
      {
        signal,
        messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
      }
    );
  } catch (err) {
    signal?.removeEventListener("abort", handleAbort);
    throw err;
  }

  // Process results
  const succeeded: string[] = [];
  const failed: string[] = [];
  const indeterminate: string[] = [];
  const blocked: string[] = [];
  failed.push(...lobbyLaunchFailed);
  // Completed tasks whose completion is attributable to the receipt that
  // reported them. Only these enter auto-review; a different worker's done
  // record is still reported but must not be reset/blocked by this receipt's
  // asynchronous review verdict.
  const reviewable = new Map<string, { owner?: string; token?: string }>();

  // A worker that exited without clean task.done bookkeeping: its work may
  // have landed on disk. Use the snapshot taken under the ownership fence for
  // the base commit — reset helpers clear base_commit, and task.start
  // overwrites it on the next attempt.
  const appendIndeterminateNote = (taskId: string, task: { base_commit?: string; status?: string } | undefined, why: string) => {
    const baseRef = task?.base_commit ? ` Prior attempt base commit: ${task.base_commit}.` : "";
    store.appendTaskProgress(cwd, taskId, "system",
      `Worker exited before task.done (status was ${task?.status ?? "unknown"}) — indeterminate: work may have landed. Re-attempt must FIRST reconcile: run git log/diff against the task base commit and review/reuse any landed work before re-implementing.${baseRef} ${why}`);
  };

  const noteStateChanged = (taskId: string, owner: string | undefined, reason?: string) => {
    const current = store.getTask(cwd, taskId);
    store.appendTaskProgress(cwd, taskId, "system",
      `Ignored result from ${owner ?? "unknown worker"}: task state changed while processing (now ${current?.status ?? "missing"}${current?.assigned_to ? `, assigned to ${current.assigned_to}` : ""}${reason ? `, ${reason}` : ""}); left untouched.`);
  };

  // Notes are written only after the guarded exit accepted this attempt, from
  // the validated prior-attempt snapshot it returned. A refusal returns no
  // previous snapshot, so a late mismatch can never produce a misleading
  // reconcile note for work this receipt did not own.
  const appendExitReconcileNote = (
    taskId: string,
    previous: Task | null,
    why: string,
  ): void => {
    if (!previous) return;
    const baseRef = previous.base_commit ? ` Prior attempt base commit: ${previous.base_commit}.` : "";
    if (previous.status === "todo") {
      store.appendTaskProgress(cwd, taskId, "system",
        `Worker exited before task.start — work may not have started — verify state before retrying.${baseRef} ${why}`);
    } else {
      store.appendTaskProgress(cwd, taskId, "system",
        `Worker exited before task.done (status was ${previous.status}) — indeterminate: work may have landed. Re-attempt must FIRST reconcile: run git log/diff against the task base commit and review/reuse any landed work before re-implementing.${baseRef} ${why}`);
    }
  };

  // Release a task whose worker exited without finishing. The attempt was
  // already charged by the dispatch claim, so the shared guarded exit only
  // returns the reservation to todo or blocks at the cap: it never re-charges,
  // and it never touches a task owned by a newer dispatch. Both the receipt
  // paths below and the lobby close handler use this same mutation.
  const exitOwnedAttempt = (
    taskId: string,
    owner: string | undefined,
    dispatchToken: string | undefined,
  ): store.ExitAttemptResult => {
    const result = store.exitAttempt(cwd, taskId, {
      owner,
      dispatchToken,
      maxAttempts: config.work.maxAttemptsPerTask,
    });
    if (result.outcome === "blocked") {
      logFeedEvent(cwd, "crew", "task.block", taskId, "Max attempts reached after worker exit");
    }
    return result;
  };

  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const taskId = r.taskId;
    if (!taskId) {
      failed.push(`unknown-result-${i}`);
      continue;
    }
    try {
      const task = store.getTask(cwd, taskId);

    // Skipped dispatch: the launch-point claim found the task already claimed
    // by another process. It must not be reported as this wave's failure.
    if (r.skipped) {
      store.appendTaskProgress(cwd, taskId, "system",
        `Dispatch skipped: ${r.error ?? "task no longer claimable"}.`);
      continue;
    }

    // A claim guard timeout is a typed per-task launch failure: this task was
    // never reserved, so it is neither failed over nor mutated. Other workers
    // in the batch have already been awaited and still drain below.
    if (r.errorCode === "task_lock_timeout") {
      store.appendTaskProgress(cwd, taskId, "system",
        `Dispatch claim timed out: ${r.error ?? "task guard timeout"}`);
      failed.push(taskId);
      continue;
    }

    // Ownership fence: a receipt can arrive after a later wave has re-claimed
    // and started the task. Mutating on status alone would reset or block the
    // new owner's in_progress task and orphan its work. The receipt carries
    // the dispatch token minted at its launch; a mismatch leaves the task
    // entirely untouched. The per-dispatch workerName (recorded as assigned_to
    // at launch and by task.start) is the fallback for tokenless dispatches
    // such as lobby assignments. Done/blocked tasks have already had
    // assigned_to cleared by their worker, so they are not mutable here and
    // are classified as before.
    const receiptOwner = r.workerName;
    const receiptToken = r.dispatchToken;
    if (task && (task.status === "todo" || task.status === "in_progress")) {
      if (receiptToken) {
        if (task.dispatch_token !== receiptToken) {
          store.appendTaskProgress(cwd, taskId, "system",
            `Ignored stale result from dispatch ${receiptToken.slice(0, 8)}: task holds a different reservation (status ${task.status}${task.assigned_to ? `, assigned to ${task.assigned_to}` : ""}); left untouched.`);
          continue;
        }
      } else if (!receiptOwner) {
        store.appendTaskProgress(cwd, taskId, "system",
          `Ignored unattributable result from ${r.agent}: receipt carries no worker identity (task status ${task.status}, assigned to ${task.assigned_to ?? "no worker"}).`);
        continue;
      } else if (task.assigned_to !== receiptOwner) {
        store.appendTaskProgress(cwd, taskId, "system",
          `Ignored stale result from ${receiptOwner}: task is currently assigned to ${task.assigned_to ?? "no worker"} (status ${task.status}).`);
        continue;
      }
    }

    // Review attribution: a tokenless completion (lobby/manual) is attributed
    // by its recorded completer.
    const markReviewable = () => {
      if (!task || task.status !== "done") return;
      if (!receiptToken && !receiptOwner) return;
      if (receiptToken ? task.completed_dispatch === receiptToken : task.completed_by === receiptOwner) {
        reviewable.set(taskId, { owner: receiptOwner, token: receiptToken });
      }
    };

    if (r.exitCode === 0) {
      if (task?.status === "done") {
        succeeded.push(taskId);
        markReviewable();
      } else if (task?.status === "blocked") {
        blocked.push(taskId);
      } else if (task?.status === "in_progress") {
        const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
        if (exit.outcome === "blocked" || exit.outcome === "todo") {
          appendExitReconcileNote(taskId, exit.previous,
            r.wasGracefullyShutdown ? "Graceful shutdown." : "Worker exited with code 0 without task.done.");
          if (exit.outcome === "blocked") blocked.push(taskId);
          else indeterminate.push(taskId);
        } else if (exit.outcome === "changed") {
          noteStateChanged(taskId, receiptOwner, exit.reason);
        }
      } else if (task?.status === "todo") {
        const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
        if (exit.outcome === "blocked" || exit.outcome === "todo") {
          appendExitReconcileNote(taskId, exit.previous,
            r.wasGracefullyShutdown ? "Graceful shutdown." : "Worker exited with code 0 without task.done.");
          if (exit.outcome === "blocked") blocked.push(taskId);
          else indeterminate.push(taskId);
        } else if (exit.outcome === "changed") {
          noteStateChanged(taskId, receiptOwner, exit.reason);
        }
      } else {
        failed.push(taskId);
      }
    } else {
      if (r.wasGracefullyShutdown) {
        if (task?.status === "done") {
          succeeded.push(taskId);
          markReviewable();
        } else if (task?.status === "blocked") {
          blocked.push(taskId);
        } else if (task?.status === "in_progress") {
          const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
          if (exit.outcome === "blocked" || exit.outcome === "todo") {
            appendExitReconcileNote(taskId, exit.previous, "Graceful shutdown.");
            if (exit.outcome === "blocked") blocked.push(taskId);
            else indeterminate.push(taskId);
          } else if (exit.outcome === "changed") {
            noteStateChanged(taskId, receiptOwner, exit.reason);
          }
        } else if (task?.status === "todo") {
          const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
          if (exit.outcome === "blocked" || exit.outcome === "todo") {
            appendExitReconcileNote(taskId, exit.previous, "Graceful shutdown.");
            if (exit.outcome === "blocked") blocked.push(taskId);
            else indeterminate.push(taskId);
          } else if (exit.outcome === "changed") {
            noteStateChanged(taskId, receiptOwner, exit.reason);
          }
        } else {
          failed.push(taskId);
        }
      } else if (autonomous && task?.status === "in_progress") {
        const blockedTask = store.blockTask(cwd, taskId, `Worker failed: ${r.error ?? "Unknown error"}`, {
          owner: receiptOwner,
          dispatchToken: receiptToken,
        });
        // Report blocked and record the crash anchor only for the fenced write
        // that actually committed; a refusal must leave the newer attempt's
        // task and progress untouched.
        if (blockedTask) {
          store.appendTaskProgress(cwd, taskId, "system", `Worker crashed: ${r.error ?? "Unknown error"}`);
          appendIndeterminateNote(taskId, blockedTask, `Worker crashed: ${r.error ?? "Unknown error"}`);
          blocked.push(taskId);
        } else {
          noteStateChanged(taskId, receiptOwner, "crash block refused");
        }
      } else {
        if (task?.status === "in_progress") {
          // Non-autonomous: previously left stuck in_progress forever; reset so
          // the next wave can retry (or block at max attempts). The reconcile
          // note uses only the snapshot the guarded exit validated.
          const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
          if (exit.outcome === "blocked" || exit.outcome === "todo") {
            store.appendTaskProgress(cwd, taskId, "system", `Worker failed: ${r.error ?? "Unknown error"}`);
            appendExitReconcileNote(taskId, exit.previous, `Worker failed: ${r.error ?? "Unknown error"}`);
          }
          if (exit.outcome === "blocked") {
            blocked.push(taskId);
            continue;
          }
          if (exit.outcome === "changed") {
            noteStateChanged(taskId, receiptOwner, exit.reason);
            continue;
          }
          if (exit.outcome === "missing") continue;
        } else if (task?.status === "todo") {
          // Worker crashed before claiming the task. Consume an attempt here
          // too — otherwise a crash-looping worker is bounded only by maxWaves,
          // never by maxAttemptsPerTask. The validated snapshot selects the
          // never-started wording even when this attempt exhausts the budget.
          const exit = exitOwnedAttempt(taskId, receiptOwner, receiptToken);
          if (exit.outcome === "blocked" || exit.outcome === "todo") {
            store.appendTaskProgress(cwd, taskId, "system", `Worker failed: ${r.error ?? "Unknown error"}`);
            appendExitReconcileNote(taskId, exit.previous, `Worker failed: ${r.error ?? "Unknown error"}`);
          }
          if (exit.outcome === "blocked") {
            blocked.push(taskId);
            continue;
          }
          if (exit.outcome === "changed") {
            noteStateChanged(taskId, receiptOwner, exit.reason);
            continue;
          }
          if (exit.outcome === "missing") continue;
        }
        failed.push(taskId);
      }
    }
    } catch (err) {
      // One contended receipt must never abort the rest of the batch. Log the
      // typed guard failure (with its recovery text), mark only this receipt's
      // task failed, and continue draining.
      const message = err instanceof Error ? err.message : String(err);
      const typed = err instanceof store.TaskLockTimeoutError
        ? "task guard timeout"
        : "unexpected receipt failure";
      appendProgressSafe(taskId, `Receipt processing failed for ${taskId} (${typed}): ${message}`);
      console.error(`[pi-messenger] receipt processing for ${taskId} failed (${typed}): ${message}`);
      failed.push(taskId);
      continue;
    }
  }

  // Auto-review succeeded tasks. Only completions attributable to the
  // receipt's own dispatch enter this loop: a slower wave's exit-0 receipt may
  // arrive after another worker already completed the task, and its review
  // verdict must not reset/block that worker's record.
  if (config.review.enabled && reviewable.size > 0) {
    const hasReviewer = availableAgents.some(a => a.name === "crew-reviewer");
    if (hasReviewer) {
      for (const taskId of [...succeeded]) {
        if (signal?.aborted) break;
        const attribution = reviewable.get(taskId);
        if (!attribution) continue;
        const task = store.getTask(cwd, taskId);
        if (!task || !task.base_commit) continue;
        const stillAttributed = attribution.token !== undefined
          ? task.completed_dispatch === attribution.token
          : task.completed_by === attribution.owner;
        if (!stillAttributed) continue;
        if ((task.review_count ?? 0) >= config.review.maxIterations) continue;

        if (task.status === "blocked" || /duplicate/i.test(task.blocked_reason ?? "")) {
          const alreadyBlocked = task.status === "blocked";
          // If the task was read as done, revalidate the completion attribution
          // inside the blocking mutation: a newer completion must not be
          // blocked by this receipt's stale duplicate marker.
          const blockedTask = alreadyBlocked
            ? null
            : store.blockTask(cwd, taskId, task.blocked_reason ?? "Duplicate task", {
              expectedStatus: "done",
              ...(attribution.token !== undefined ? { completedDispatch: attribution.token } : {}),
              ...(attribution.owner !== undefined ? { completedBy: attribution.owner } : {}),
            });
          if (!alreadyBlocked && !blockedTask) {
            store.appendTaskProgress(cwd, taskId, "system",
              `Auto-review duplicate skip discarded: completion is no longer attributed to ${attribution.owner ?? attribution.token ?? "this dispatch"}.`);
            logFeedEvent(cwd, "crew", "task.review", taskId, "skipped — completion changed");
            continue;
          }
          succeeded.splice(succeeded.indexOf(taskId), 1);
          blocked.push(taskId);
          logFeedEvent(cwd, "crew", "task.review", taskId,
            `skipped — blocked: ${task.blocked_reason ?? task.status}`);
          continue;
        }

        // The reviewer only computes feedback; reviewImplementation no longer
        // persists last_review. The verdict is applied below in one guarded
        // mutation, so a completion that changed while the reviewer ran is
        // discarded instead of being reset/blocked.
        const rr = await reviewImplementation(cwd, taskId, config.models?.reviewer ?? sessionModel);
        const feedback = rr.details?.feedback as ReviewFeedback | undefined;
        const verdict = feedback?.verdict;
        if (!feedback || !verdict) {
          store.appendTaskProgress(cwd, taskId, "system",
            `Auto-review skipped: ${rr.details?.error ?? "unknown"}`);
          continue;
        }

        const applied = store.applyReview(cwd, taskId, feedback, {
          status: "done",
          dispatchToken: attribution.token,
          owner: attribution.owner,
        });
        if (!applied) {
          store.appendTaskProgress(cwd, taskId, "system",
            `Auto-review result (${verdict}) discarded: completion is no longer attributed to ${attribution.owner ?? attribution.token ?? "this dispatch"}.`);
          logFeedEvent(cwd, "crew", "task.review", taskId, "skipped — completion changed");
          continue;
        }

        if (verdict === "SHIP") {
          logFeedEvent(cwd, "crew", "task.review", taskId, "SHIP");
        } else if (verdict === "NEEDS_WORK") {
          logFeedEvent(cwd, "crew", "task.review", taskId, "NEEDS_WORK — reset for retry");
          succeeded.splice(succeeded.indexOf(taskId), 1);
          failed.push(taskId);
        } else {
          logFeedEvent(cwd, "crew", "task.review", taskId, "MAJOR_RETHINK — blocked");
          succeeded.splice(succeeded.indexOf(taskId), 1);
          blocked.push(taskId);
        }
      }
    }
  }

  syncCompletedCount(cwd);

  // The drain window is over: a later abort is handled by the post-processing
  // branch below.
  signal?.removeEventListener("abort", handleAbort);

  // Save current wave number BEFORE addWaveResult increments it
  const currentWave = autonomous ? autonomousState.waveNumber : 1;
  
  if (autonomous) {
    addWaveResult({
      waveNumber: currentWave,
      tasksAttempted: attemptedTaskIdsList,
      succeeded,
      failed,
      indeterminate,
      blocked,
      timestamp: new Date().toISOString()
    });

    if (signal?.aborted) {
      // The abort listener already stopped the run; only persist state if it
      // somehow has not (e.g. re-entered with an already-aborted signal).
      if (isAutonomousForCwd(cwd)) {
        stopAutonomous("manual");
        appendEntry("crew-state", autonomousState);
      }
    } else {
      const nextReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" }).filter(t => !teamStore.taskNeedsApproval(t));
      const allTasks = store.getTasks(cwd);
      const allDone = allTasks.every(t => t.status === "done");
      const allBlockedOrDone = allTasks.every(t => t.status === "done" || t.status === "blocked");

      if (allDone) {
        stopAutonomous("completed");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_complete", {
          prd: plan.prd,
          status: "completed",
          totalWaves: currentWave,
          totalTasks: allTasks.length
        });
      } else if (allBlockedOrDone || nextReady.length === 0) {
        stopAutonomous("blocked");
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_blocked", {
          prd: plan.prd,
          status: "blocked",
          blockedTasks: allTasks.filter(t => t.status === "blocked").map(t => t.id)
        });
      } else {
        appendEntry("crew-state", autonomousState);
        appendEntry("crew_wave_continue", {
          prd: plan.prd,
          nextWave: autonomousState.waveNumber,
          readyTasks: nextReady.map(t => t.id)
        });
      }
    }
  }

  // Build result
  const updatedPlan = store.getPlan(cwd);
  const progress = updatedPlan 
    ? `${updatedPlan.completed_count}/${updatedPlan.task_count}`
    : "unknown";

  const nextReady = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const actionableNextReady = nextReady.filter(t => !teamStore.taskNeedsApproval(t));
  const finalNeedsApproval = nextReady.filter(teamStore.taskPendingApproval);
  const finalRejected = nextReady.filter(teamStore.taskNeedsRevision);

  let statusText = "";
  if (succeeded.length > 0) statusText += `\n✅ Completed: ${succeeded.join(", ")}`;
  if (indeterminate.length > 0) statusText += `\n⚠️ Indeterminate: ${indeterminate.join(", ")} — worker exited before task.done; verify commits/tests on disk`;
  if (failed.length > 0) statusText += `\n❌ Failed: ${failed.join(", ")}`;
  if (blocked.length > 0) statusText += `\n🚫 Blocked: ${blocked.join(", ")}`;
  if (finalNeedsApproval.length > 0) statusText += `\n🛑 Needs approval: ${finalNeedsApproval.map(t => t.id).join(", ")}`;
  if (finalRejected.length > 0) statusText += `\n↩️ Rejected: ${finalRejected.map(t => t.id).join(", ")}`;
  const nextText = actionableNextReady.length > 0
    ? `\n\n**Ready for next wave:** ${actionableNextReady.map(t => t.id).join(", ")}`
    : "";
  const continueText = autonomous && !signal?.aborted && actionableNextReady.length > 0
    ? "Autonomous mode: Continuing to next wave..."
    : signal?.aborted && autonomous
      ? "Autonomous mode stopped (cancelled)."
      : "";

  const lobbyText = lobbyAssigned.size > 0
    ? `\n🏢 Lobby workers assigned: ${Array.from(lobbyAssigned).join(", ")}`
    : "";

  const text = `# Work Wave ${currentWave}

**PRD:** ${store.getPlanLabel(plan)}
**Tasks attempted:** ${attemptedTaskIdsList.length}${lobbyAssigned.size > 0 ? ` (+${lobbyAssigned.size} lobby)` : ""}
**Progress:** ${progress}
${statusText}${lobbyText}${rejectedTasksText(finalRejected)}${nextText}

${continueText}`;

  return result(text, {
    mode: "work",
    prd: plan.prd,
    wave: currentWave,
    attempted: attemptedTaskIdsList,
    succeeded,
    failed,
    indeterminate,
    blocked,
    needsApproval: approvalTaskSummaries(finalNeedsApproval),
    rejected: approvalTaskSummaries(finalRejected),
    nextReady: actionableNextReady.map(t => t.id),
    autonomous: !!autonomous
  });
}

function syncCompletedCount(cwd: string): void {
  const plan = store.getPlan(cwd);
  if (!plan) return;
  const doneCount = store.getTasks(cwd).filter(t => t.status === "done").length;
  if (plan.completed_count !== doneCount) {
    store.updatePlan(cwd, { completed_count: doneCount });
  }
}
