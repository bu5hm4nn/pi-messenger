/**
 * Pi Messenger - Commit feed event decision
 *
 * The bash hook must only announce a commit that actually happened. Command text is
 * not evidence: a failed commit, a commit with nothing staged, and a command that
 * merely mentions `git commit` (an echo, a commit-message string) all leave the
 * repository untouched.
 *
 * The reliable signal is the HEAD transition. A commit is the only command that moves
 * HEAD, so comparing HEAD before and after the tool call rejects both failure modes
 * without trusting the tool result. That matters for compound commands such as
 * `git commit -m x && npm test`: the commit landed even though the tool result is an
 * error, and the event is still deserved. So this decision deliberately does NOT gate
 * on `event.isError`.
 */

import { execSync } from "node:child_process";

export interface HeadState {
  /**
   * Full 40-char commit SHA of HEAD. Empty means "HEAD is unborn": the cwd is inside a
   * git work tree, but the repository has no commits yet (a fresh `git init`).
   */
  sha: string;
  /** Abbreviated SHA, as git prints it; empty when `sha` is empty. */
  shortSha: string;
  /** First line of the commit message; may be empty. */
  subject: string;
}

/**
 * HEAD of a repository that exists but has no commits yet. Distinguishes "unborn" from
 * "unreadable" (undefined), so the first real commit in a fresh repository is not lost.
 */
export const UNBORN_HEAD: HeadState = { sha: "", shortSha: "", subject: "" };

const GIT_TIMEOUT_MS = 2000;

/** Same semantics as the previous `isGitCommit` in index.ts. */
export function isGitCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}

/**
 * One bounded git call describing HEAD, or:
 * - `UNBORN_HEAD` when cwd is inside a git work tree whose HEAD has no commits yet,
 * - `undefined` when cwd is not a git work tree, git is missing, or the read fails.
 */
export function readHeadState(cwd: string): HeadState | undefined {
  try {
    // NUL-separated so a subject containing spaces or punctuation stays intact.
    const raw = execSync("git log -1 --format=%H%x00%h%x00%s", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [sha, shortSha, subject] = raw.replace(/\r?\n$/, "").split("\0");
    if (!sha || !shortSha) return undefined;
    return { sha: sha.trim(), shortSha: shortSha.trim(), subject: (subject ?? "").trim() };
  } catch (error) {
    // A timed-out read says nothing about HEAD, so it stays unreadable. Paying the second
    // call here could mislabel a real repository as "unborn" and invent an event later.
    if (isTimeoutError(error)) return undefined;
    // `git log` fails both outside a repository and in one whose HEAD is unborn.
    return isInsideWorkTree(cwd) ? UNBORN_HEAD : undefined;
  }
}

/** execSync signals a timeout with code ETIMEDOUT (and SIGTERM to the child). */
function isTimeoutError(error: unknown): boolean {
  const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
  return code === "ETIMEDOUT" || signal === "SIGTERM";
}

/**
 * Second bounded call, paid only on the `git log` failure path, to tell an unborn HEAD
 * apart from "not a repository". Returns false for bare repositories and for any error.
 */
function isInsideWorkTree(cwd: string): boolean {
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Pure decision: emit a commit feed event only when HEAD moved between the two reads.
 * The preview comes from git (`shortSha` + `subject`), never from the command text, so
 * `-F`, heredocs and repeated `-m` flags all report the real message.
 *
 * An unborn `headBefore` (empty `sha`, i.e. `UNBORN_HEAD`) is a real state, not a missing
 * one: `"" -> <real sha>` is the repository's first commit and deserves the event, while
 * `"" -> ""` means the first commit failed and stays silent. A missing state (`undefined`)
 * is unreadable, so it never produces an event.
 */
export function decideCommitEvent(input: {
  headBefore?: HeadState;
  headAfter?: HeadState;
}): { preview: string; lastToolCall: string } | undefined {
  const { headBefore, headAfter } = input;
  if (!headBefore || !headAfter) return undefined;
  if (headBefore.sha === headAfter.sha) return undefined;

  // Filter empty parts so an absent short SHA cannot leave a leading space.
  const preview = [headAfter.shortSha.trim(), (headAfter.subject ?? "").trim()].filter(Boolean).join(" ");
  return { preview, lastToolCall: `commit: ${preview}` };
}
