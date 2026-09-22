/**
 * Crew - Work Handler
 * 
 * Spawns workers for ready tasks with concurrency control.
 * Simplified: works on current plan's tasks
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Dirs } from "../../lib.ts";
import type { CrewParams, AppendEntryFn } from "../types.ts";
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
      store.updateTask(cwd, task.id, {
        status: "blocked",
        blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
      });
      store.appendTaskProgress(cwd, task.id, "system",
        `Auto-blocked after ${task.attempt_count} attempts (max: ${config.work.maxAttemptsPerTask})`);
      logFeedEvent(cwd, "crew", "task.block", task.id, `Max attempts (${config.work.maxAttemptsPerTask}) reached`);
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

  // Assign tasks to lobby workers first (they're already running and warmed up)
  const prdLabel = store.getPlanLabel(plan);
  const lobbyAssigned = new Set<string>();
  const lobbyWorkers = getAvailableLobbyWorkers(cwd);
  for (const lobbyWorker of lobbyWorkers) {
    const task = readyTasks.find(t => !lobbyAssigned.has(t.id));
    if (!task) break;

    const others = readyTasks.filter(t => t.id !== task.id);
    const prompt = buildWorkerPrompt(task, prdLabel, cwd, config, others, skills, teamStore.buildTeamPromptContext(cwd, task));
    store.updateTask(cwd, task.id, {
      status: "in_progress",
      started_at: new Date().toISOString(),
      base_commit: store.getBaseCommit(cwd),
      assigned_to: lobbyWorker.name,
      attempt_count: task.attempt_count + 1,
    });
    if (!assignTaskToLobbyWorker(lobbyWorker, task.id, prompt, dirs.inbox)) {
      store.updateTask(cwd, task.id, { status: "todo", assigned_to: undefined });
      continue;
    }
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to lobby worker ${lobbyWorker.name} (attempt ${task.attempt_count + 1})`);
    logFeedEvent(cwd, lobbyWorker.name, "task.start", task.id, task.title);
    lobbyAssigned.add(task.id);
  }
  cleanupUnassignedAliveFiles(cwd);

  // Build prompts for remaining tasks — spawnAgents throttles via autonomousState.concurrency
  const remainingTasks = readyTasks.filter(t => !lobbyAssigned.has(t.id));
  const teamRoles = teamStore.resolveRoles(cwd);
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
    store.appendTaskProgress(cwd, task.id, "system", `Assigned to crew-worker`);

    return {
      agent: "crew-worker",
      task: prompt,
      taskId: task.id,
      modelOverride: taskModel,
    };
  });

  const workerResults = await spawnAgents(
    workerTasks,
    cwd,
    {
      signal,
      messengerDirs: { registry: dirs.registry, inbox: dirs.inbox },
    }
  );

  // Process results
  const succeeded: string[] = [];
  const failed: string[] = [];
  const indeterminate: string[] = [];
  const blocked: string[] = [];

  // A worker that exited without clean task.done bookkeeping: its work may
  // have landed on disk. Mark indeterminate instead of failed.
  const markIndeterminate = (taskId: string, taskStatus: string | undefined, why: string) => {
    const task = store.getTask(cwd, taskId);
    // Embed the pre-exit base commit: task.start overwrites base_commit on the
    // re-attempt, so the reconcile instruction would otherwise lose its anchor.
    const baseRef = task?.base_commit ? ` Prior attempt base commit: ${task.base_commit}.` : "";
    store.appendTaskProgress(cwd, taskId, "system",
      `Worker exited before task.done (status was ${taskStatus ?? "unknown"}) — indeterminate: work may have landed. Re-attempt must FIRST reconcile: run git log/diff against the task base commit and review/reuse any landed work before re-implementing.${baseRef} ${why}`);
    indeterminate.push(taskId);
  };

  // A worker that exited before task.start: the task was never claimed, so
  // nothing was expected to land — but a protocol-violating worker can still
  // have edited files, so label it indeterminate with a distinct message.
  const markNeverStarted = (taskId: string, why: string) => {
    store.appendTaskProgress(cwd, taskId, "system",
      `Worker exited before task.start — task never claimed. Verify disk only if unexpected. ${why}`);
    indeterminate.push(taskId);
  };

  type ResetOutcome = "blocked" | "todo" | "missing";

  // Reset a task whose in_progress worker exited. The attempt for an
  // in_progress task was already consumed by the worker's task.start.
  const resetInterruptedTask = (taskId: string, task: { attempt_count?: number } | undefined): ResetOutcome => {
    if (!task) return "missing";
    if ((task.attempt_count ?? 0) >= config.work.maxAttemptsPerTask) {
      store.updateTask(cwd, taskId, {
        status: "blocked",
        blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
        assigned_to: undefined,
      });
      logFeedEvent(cwd, "crew", "task.block", taskId, "Max attempts reached after worker exit");
      return "blocked";
    }
    store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined });
    return "todo";
  };

  // Reset a task the worker exited BEFORE claiming (task.start never ran):
  // attempt_count was never persisted on the spawnAgents dispatch path, so
  // consume an attempt here or the maxAttemptsPerTask backstop is bypassed
  // and autonomous retries are bounded only by maxWaves.
  const resetNeverStartedTask = (taskId: string, task: { attempt_count?: number } | undefined): ResetOutcome => {
    if (!task) return "missing";
    const nextAttempt = (task.attempt_count ?? 0) + 1;
    if (nextAttempt > config.work.maxAttemptsPerTask) {
      store.updateTask(cwd, taskId, {
        status: "blocked",
        blocked_reason: `Max attempts (${config.work.maxAttemptsPerTask}) reached`,
        assigned_to: undefined,
        attempt_count: nextAttempt,
      });
      logFeedEvent(cwd, "crew", "task.block", taskId, "Max attempts reached after worker exit");
      return "blocked";
    }
    store.updateTask(cwd, taskId, { status: "todo", assigned_to: undefined, attempt_count: nextAttempt });
    return "todo";
  };

  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const taskId = r.taskId;
    if (!taskId) {
      failed.push(`unknown-result-${i}`);
      continue;
    }
    const task = store.getTask(cwd, taskId);

    if (r.exitCode === 0) {
      if (task?.status === "done") {
        succeeded.push(taskId);
      } else if (task?.status === "blocked") {
        blocked.push(taskId);
      } else if (task?.status === "in_progress") {
        const outcome = resetInterruptedTask(taskId, task);
        if (outcome === "blocked") {
          blocked.push(taskId);
        } else {
          markIndeterminate(taskId, task.status,
            r.wasGracefullyShutdown ? "Graceful shutdown." : "Worker exited with code 0 without task.done.");
        }
      } else if (task?.status === "todo") {
        const outcome = resetNeverStartedTask(taskId, task);
        if (outcome === "blocked") {
          blocked.push(taskId);
        } else {
          markNeverStarted(taskId, r.wasGracefullyShutdown ? "Graceful shutdown." : "Worker exited with code 0 without task.done.");
        }
      } else {
        failed.push(taskId);
      }
    } else {
      if (r.wasGracefullyShutdown) {
        if (task?.status === "done") {
          succeeded.push(taskId);
        } else if (task?.status === "blocked") {
          blocked.push(taskId);
        } else if (task?.status === "in_progress") {
          const outcome = resetInterruptedTask(taskId, task);
          if (outcome === "blocked") {
            blocked.push(taskId);
          } else {
            markIndeterminate(taskId, task.status, "Graceful shutdown.");
          }
        } else if (task?.status === "todo") {
          const outcome = resetNeverStartedTask(taskId, task);
          if (outcome === "blocked") {
            blocked.push(taskId);
          } else {
            markNeverStarted(taskId, "Graceful shutdown.");
          }
        } else {
          failed.push(taskId);
        }
      } else if (autonomous && task?.status === "in_progress") {
        store.appendTaskProgress(cwd, taskId, "system", `Worker crashed: ${r.error ?? "Unknown error"}`);
        store.blockTask(cwd, taskId, `Worker failed: ${r.error ?? "Unknown error"}`);
        blocked.push(taskId);
      } else {
        if (task?.status === "in_progress") {
          store.appendTaskProgress(cwd, taskId, "system", `Worker failed: ${r.error ?? "Unknown error"}`);
          // Non-autonomous: previously left stuck in_progress forever; reset so
          // the next wave can retry (or block at max attempts).
          const outcome = resetInterruptedTask(taskId, task);
          if (outcome === "blocked") {
            blocked.push(taskId);
            continue;
          }
        } else if (task?.status === "todo") {
          // Worker crashed before claiming the task. Consume an attempt here
          // too — otherwise a crash-looping worker is bounded only by maxWaves,
          // never by maxAttemptsPerTask.
          const outcome = resetNeverStartedTask(taskId, task);
          if (outcome === "blocked") {
            blocked.push(taskId);
            continue;
          }
        }
        failed.push(taskId);
      }
    }
  }

  // Auto-review succeeded tasks
  if (config.review.enabled && succeeded.length > 0) {
    const hasReviewer = availableAgents.some(a => a.name === "crew-reviewer");
    if (hasReviewer) {
      for (const taskId of [...succeeded]) {
        if (signal?.aborted) break;
        const task = store.getTask(cwd, taskId);
        if (!task || !task.base_commit) continue;
        if ((task.review_count ?? 0) >= config.review.maxIterations) continue;

        if (task.status === "blocked" || /duplicate/i.test(task.blocked_reason ?? "")) {
          if (task.status !== "blocked") {
            store.blockTask(cwd, taskId, task.blocked_reason ?? "Duplicate task");
          }
          succeeded.splice(succeeded.indexOf(taskId), 1);
          blocked.push(taskId);
          logFeedEvent(cwd, "crew", "task.review", taskId,
            `skipped — blocked: ${task.blocked_reason ?? task.status}`);
          continue;
        }

        const rr = await reviewImplementation(cwd, taskId, config.models?.reviewer ?? sessionModel);
        const verdict = rr.details?.verdict as string | undefined;
        if (!verdict) {
          store.appendTaskProgress(cwd, taskId, "system",
            `Auto-review skipped: ${rr.details?.error ?? "unknown"}`);
          continue;
        }

        const reviewCount = (task.review_count ?? 0) + 1;
        store.updateTask(cwd, taskId, { review_count: reviewCount });

        if (verdict === "SHIP") {
          logFeedEvent(cwd, "crew", "task.review", taskId, "SHIP");
        } else if (verdict === "NEEDS_WORK") {
          store.resetTask(cwd, taskId);
          logFeedEvent(cwd, "crew", "task.review", taskId, "NEEDS_WORK — reset for retry");
          succeeded.splice(succeeded.indexOf(taskId), 1);
          failed.push(taskId);
        } else {
          const lastReview = store.getTask(cwd, taskId)?.last_review;
          const summary = lastReview?.summary
            ? lastReview.summary.split("\n")[0].slice(0, 120)
            : "Major issues found";
          store.blockTask(cwd, taskId, `Reviewer: ${summary}`);
          logFeedEvent(cwd, "crew", "task.review", taskId, "MAJOR_RETHINK — blocked");
          succeeded.splice(succeeded.indexOf(taskId), 1);
          blocked.push(taskId);
        }
      }
    }
  }

  syncCompletedCount(cwd);

  // Save current wave number BEFORE addWaveResult increments it
  const currentWave = autonomous ? autonomousState.waveNumber : 1;
  
  if (autonomous) {
    addWaveResult({
      waveNumber: currentWave,
      tasksAttempted: remainingTasks.map(t => t.id),
      succeeded,
      failed,
      indeterminate,
      blocked,
      timestamp: new Date().toISOString()
    });

    if (signal?.aborted) {
      stopAutonomous("manual");
      appendEntry("crew-state", autonomousState);
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
**Tasks attempted:** ${remainingTasks.length}${lobbyAssigned.size > 0 ? ` (+${lobbyAssigned.size} lobby)` : ""}
**Progress:** ${progress}
${statusText}${lobbyText}${rejectedTasksText(finalRejected)}${nextText}

${continueText}`;

  return result(text, {
    mode: "work",
    prd: plan.prd,
    wave: currentWave,
    attempted: remainingTasks.map(t => t.id),
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
