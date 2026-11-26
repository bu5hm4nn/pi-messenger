/**
 * Crew - Sync Handler
 * 
 * Updates downstream specs after task completion.
 * Works with current plan's tasks.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewParams } from "../types.ts";
import { result } from "../utils/result.ts";
import { spawnAgents } from "../agents.ts";
import { discoverCrewAgents } from "../utils/discover.ts";
import { loadCrewConfig } from "../utils/config.ts";
import * as store from "../store.ts";

export async function execute(
  params: CrewParams,
  ctx: ExtensionContext,
  sessionModel?: string,
) {
  const cwd = ctx.cwd;
  const { target } = params;

  if (!target) {
    return result("Error: target (completed task ID) required for sync action.", {
      mode: "sync",
      error: "missing_target"
    });
  }

  // Verify plan exists
  const plan = store.getPlan(cwd);
  if (!plan) {
    return result("Error: No plan found.", {
      mode: "sync",
      error: "no_plan"
    });
  }

  // Verify task exists and is completed
  const task = store.getTask(cwd, target);
  if (!task) {
    return result(`Error: Task ${target} not found.`, {
      mode: "sync",
      error: "task_not_found",
      target
    });
  }

  if (task.status !== "done") {
    return result(`Error: Task ${target} is ${task.status}, not done. Sync is for completed tasks.`, {
      mode: "sync",
      error: "task_not_done",
      status: task.status
    });
  }

  // Check for plan-sync agent
  const config = loadCrewConfig(store.getCrewDir(cwd));
  const availableAgents = discoverCrewAgents(cwd);
  const hasSyncAgent = availableAgents.some(a => a.name === "crew-plan-sync");
  if (!hasSyncAgent) {
    return result("Error: crew-plan-sync agent not found.", {
      mode: "sync",
      error: "no_sync_agent"
    });
  }

  const allTasks = store.getTasks(cwd);
  
  // Find dependent tasks (tasks that depend on the completed task)
  const dependentTasks = allTasks.filter(t => 
    t.depends_on.includes(target) && t.status === "todo"
  );

  if (dependentTasks.length === 0) {
    return result(`No downstream tasks depend on ${target}. No sync needed.`, {
      mode: "sync",
      taskId: target,
      dependentTasks: [],
      synced: false
    });
  }

  // Get completed task details for context
  const taskSpec = store.getTaskSpec(cwd, target);
  const taskSummary = task.summary ?? "No summary";

  // Build task overview for dependent tasks
  const dependentOverview = dependentTasks.map(t => {
    const spec = store.getTaskSpec(cwd, t.id);
    return `### ${t.id}: ${t.title}

${spec || "*No spec*"}
`;
  }).join("\n");

  // Build sync prompt
  const prompt = `# Spec Sync Request

## Completed Task

**Task ID:** ${target}
**Title:** ${task.title}
**Summary:** ${taskSummary}

### Implementation Details

${taskSpec || "*No detailed spec*"}

## Dependent Tasks to Update

These tasks depend on the completed task and may need spec updates:

${dependentOverview}

## Your Task

1. Review what was implemented in the completed task
2. Check if any dependent task specs need updating based on the implementation
3. Update specs with relevant information (file locations, API details, etc.)
4. Output which specs were updated and why

Follow the output format in your instructions.`;

  // Spawn sync agent
  const [syncResult] = await spawnAgents([{
    agent: "crew-plan-sync",
    task: prompt,
    modelOverride: config.models?.analyst ?? sessionModel,
  }], cwd);

  if (syncResult.exitCode !== 0) {
    return result(`Error: Sync agent failed: ${syncResult.error ?? "Unknown error"}`, {
      mode: "sync",
      error: "sync_failed"
    });
  }

  // Parse sync results
  const updates = parseSyncUpdates(syncResult.output);

  // Apply updates to task specs
  let updatedCount = 0;
  let staleCount = 0;
  for (const update of updates) {
    const matchingTask = dependentTasks.find(t => 
      t.id === update.taskId || 
      t.title.toLowerCase().includes(update.taskId.toLowerCase())
    );

    if (matchingTask && update.newContent) {
      const current = store.getTask(cwd, matchingTask.id);
      if (!current) continue;
      const currentSpec = store.getTaskSpecFor(cwd, current) ?? "";
      
      // Append update to spec (don't replace)
      const updatedSpec = `${currentSpec}

---
*Updated after ${target} completion:*

${update.newContent}`;

      // The append was computed outside the guard, so it carries the
      // generation it was built from: a newer spec edit makes it stale and
      // aborts instead of overwriting.
      try {
        const applied = store.setTaskSpec(cwd, matchingTask.id, updatedSpec, {
          expectedGeneration: current.generation ?? 0,
        });
        if (applied) updatedCount++;
      } catch (err) {
        // A concurrent revise won this generation: skip the append instead of
        // overwriting it. Stale is a normal loser outcome, not a sync failure.
        if (!(err instanceof store.StaleTaskGenerationError)) throw err;
        staleCount++;
      }
    }
  }

  const readyTasks = store.getReadyTasks(cwd, { advisory: config.dependencies === "advisory" });
  const text = `# Sync Complete: ${target}

**Dependent tasks checked:** ${dependentTasks.length}
**Specs updated:** ${updatedCount}${staleCount > 0 ? ` (${staleCount} skipped: concurrent edit)` : ""}

${updates.length > 0 ? `## Updates\n${updates.map(u => `- **${u.taskId}**: ${u.reason}`).join("\n")}` : "## No Updates Needed\n\nDependent task specs are already up to date."}

${updatedCount > 0 ? `\n**Ready tasks:** ${readyTasks.map(t => t.id).join(", ") || "none"}` : ""}`;

  return result(text, {
    mode: "sync",
    taskId: target,
    dependentTasks: dependentTasks.map(t => t.id),
    updatedCount,
    updates: updates.map(u => ({ taskId: u.taskId, reason: u.reason }))
  });
}

// =============================================================================
// Sync Update Parsing
// =============================================================================

interface SyncUpdate {
  taskId: string;
  reason: string;
  newContent?: string;
}

/**
 * Parses sync updates from the sync agent output.
 * 
 * Expected format:
 * ### Updated: [task-id]
 * 
 * Changes made:
 * - Updated section X to reflect...
 * 
 * New content:
 * [content to add to spec]
 */
function parseSyncUpdates(output: string): SyncUpdate[] {
  const updates: SyncUpdate[] = [];

  // Match update blocks
  const updateRegex = /###\s*Updated:\s*(.+?)\n([\s\S]*?)(?=###|$)/gi;
  let match;

  while ((match = updateRegex.exec(output)) !== null) {
    const taskId = match[1].trim();
    const body = match[2].trim();

    // Extract reason (Changes made section)
    const reasonMatch = body.match(/Changes made:?\s*([\s\S]*?)(?=New content:|$)/i);
    const reason = reasonMatch 
      ? reasonMatch[1].trim().replace(/^[-*]\s*/gm, "").split("\n")[0].trim()
      : "Updated based on implementation";

    // Extract new content
    const contentMatch = body.match(/New content:?\s*([\s\S]*?)$/i);
    const newContent = contentMatch ? contentMatch[1].trim() : undefined;

    updates.push({ taskId, reason, newContent });
  }

  return updates;
}
