import { logFeedEvent } from "../feed.ts";
import * as store from "./store.ts";
import { loadCrewConfig } from "./utils/config.ts";
import { killWorkerByTask } from "./registry.ts";
import type { Task } from "./types.ts";

export type TaskAction = "start" | "block" | "unblock" | "reset" | "cascade-reset" | "delete" | "stop";

export interface TaskActionOptions {
  isWorkerActive?: (taskId: string) => boolean;
  /** Dispatch reservation carried by a spawned worker (PI_CREW_DISPATCH). */
  dispatchToken?: string;
  /** Override crew-identity detection (tests); production uses the env vars. */
  crewIdentity?: boolean;
}

export interface TaskActionResult {
  success: boolean;
  message: string;
  error?: string;
  task?: Task;
  resetTasks?: Task[];
  unmetDependencies?: string[];
}

export function executeTaskAction(
  cwd: string,
  action: TaskAction,
  taskId: string,
  agentName: string,
  reason?: string,
  options?: TaskActionOptions,
): TaskActionResult {
  const task = store.getTask(cwd, taskId);
  if (!task) return { success: false, error: "not_found", message: `Task ${taskId} not found` };

  // A worker session (cold or warm) has a crew identity. If it presents no
  // token while the task holds a live reservation, it must not fall back to
  // the unfenced operator path: that path is reserved for sessions with no
  // crew identity at all (an explicit human/operator takeover).
  const hasCrewIdentity = options?.crewIdentity
    ?? (process.env.PI_CREW_WORKER === "1" || process.env.PI_LOBBY_ID !== undefined);
  const hasDispatchToken = typeof options?.dispatchToken === "string" && options.dispatchToken.length > 0;
  const tokenBearing = typeof task.dispatch_token === "string" && task.dispatch_token.length > 0;
  const TOKEN_GATED_ACTIONS: ReadonlySet<TaskAction> = new Set([
    "start", "block", "unblock", "reset", "cascade-reset", "stop",
  ]);
  if (hasCrewIdentity && !hasDispatchToken && tokenBearing && TOKEN_GATED_ACTIONS.has(action)) {
    return {
      success: false,
      error: "dispatch_token_required",
      message:
        `Refusing ${action} on ${taskId}: worker ${agentName} has crew identity but no dispatch token, ` +
        `while task holds reservation ${task.dispatch_token!.slice(0, 8)}. ` +
        `A tokenless takeover is reserved for operator sessions with no crew identity.`,
    };
  }

  switch (action) {
    case "start": {
      if (task.milestone) {
        return { success: false, error: "milestone_not_startable", message: `Task ${taskId} is a milestone and cannot be started manually` };
      }
      if (task.status === "in_progress" && task.assigned_to === agentName) {
        return { success: true, message: `Already started ${taskId}`, task };
      }
      if (task.status !== "todo") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not todo` };
      }
      const config = loadCrewConfig(store.getCrewDir(cwd));
      if (config.dependencies !== "advisory") {
        const unmetDependencies = task.depends_on.filter(depId => store.getTask(cwd, depId)?.status !== "done");
        if (unmetDependencies.length > 0) {
          return {
            success: false,
            error: "unmet_dependencies",
            message: `Unmet dependencies: ${unmetDependencies.join(", ")}`,
            unmetDependencies,
          };
        }
      }
      // git runs before the guard: no spawn/git inside a mutation.
      const baseCommit = store.getBaseCommit(cwd);
      const started = store.startTask(cwd, taskId, agentName, {
        baseCommit,
        dispatchToken: options?.dispatchToken,
      });
      if (!started) return { success: false, error: "start_failed", message: `Failed to start ${taskId}` };
      logFeedEvent(cwd, agentName, "task.start", taskId, started.title);
      return { success: true, message: `Started ${taskId}`, task: started };
    }

    case "block": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} must be in_progress to block` };
      }
      if (!reason) {
        return { success: false, error: "missing_reason", message: `Reason required to block ${taskId}` };
      }
      // A worker session carries the trusted dispatch token; the mutation
      // re-checks it under the guard so a same-name successor is untouched.
      const blocked = store.blockTask(cwd, taskId, reason, {
        ...(options?.dispatchToken ? { dispatchToken: options.dispatchToken } : {}),
      });
      if (!blocked) return { success: false, error: "block_failed", message: `Failed to block ${taskId}` };
      logFeedEvent(cwd, agentName, "task.block", taskId, reason);
      return { success: true, message: `Blocked ${taskId}`, task: blocked };
    }

    case "unblock": {
      if (task.status !== "blocked") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not blocked` };
      }
      const unblocked = store.unblockTask(cwd, taskId, {
        ...(options?.dispatchToken ? { dispatchToken: options.dispatchToken } : {}),
      });
      if (!unblocked) return { success: false, error: "unblock_failed", message: `Failed to unblock ${taskId}` };
      logFeedEvent(cwd, agentName, "task.unblock", taskId, unblocked.title);
      return { success: true, message: `Unblocked ${taskId}`, task: unblocked };
    }

    case "reset": {
      if (options?.isWorkerActive?.(taskId)) {
        return { success: false, error: "active_worker", message: `Cannot reset ${taskId} while its worker is active` };
      }
      const resetTasks = store.resetTask(cwd, taskId, false, {
        ...(options?.dispatchToken ? { dispatchToken: options.dispatchToken } : {}),
      });
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, task.title);
      return { success: true, message: `Reset ${taskId}`, resetTasks };
    }

    case "cascade-reset": {
      const subtree = [task, ...store.getTransitiveDependents(cwd, taskId)];
      const activeTask = subtree.find(t => options?.isWorkerActive?.(t.id));
      if (activeTask) {
        return { success: false, error: "active_worker", message: `Cannot reset ${activeTask.id} while its worker is active` };
      }
      // The worker's token fences the root takeover; dependent resets remain
      // part of the same explicit cascade once the root is accepted.
      const resetTasks = store.resetTask(cwd, taskId, true, {
        ...(options?.dispatchToken ? { dispatchToken: options.dispatchToken } : {}),
      });
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, `cascade (${resetTasks.length} tasks)`);
      return { success: true, message: `Reset ${taskId} + ${Math.max(0, resetTasks.length - 1)} dependents`, resetTasks };
    }

    case "delete": {
      if (task.status === "in_progress" && options?.isWorkerActive?.(taskId)) {
        return { success: false, error: "active_worker", message: `Cannot delete ${taskId} while its worker is active` };
      }
      if (!store.deleteTask(cwd, taskId)) return { success: false, error: "delete_failed", message: `Failed to delete ${taskId}` };
      logFeedEvent(cwd, agentName, "task.delete", taskId, task.title);
      return { success: true, message: `Deleted ${taskId}` };
    }

    case "stop": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not in_progress` };
      }
      if (options?.isWorkerActive?.(taskId)) {
        killWorkerByTask(cwd, taskId);
        store.appendTaskProgress(cwd, taskId, agentName, "Worker stopped by user");
      } else {
        store.appendTaskProgress(cwd, taskId, agentName, "Task unassigned (no active worker)");
      }
      // Stop is an explicit takeover: reset through the lifecycle mutation so
      // the active dispatch token and completion attribution are invalidated.
      store.resetTask(cwd, taskId);
      logFeedEvent(cwd, agentName, "task.reset", taskId, "stopped");
      return { success: true, message: `Stopped ${taskId}` };
    }
  }
}
