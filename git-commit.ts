/**
 * Pi Messenger - Commit feed event decision
 *
 * The bash hook must only announce a commit that actually happened. Command text is
 * not evidence: a failed commit, a commit with nothing staged, and a command that
 * merely mentions `git commit` (an echo, a commit-message string) all leave the
 * repository untouched.
 *
 * The reliable signal is the HEAD transition plus the operation recorded in the HEAD
 * reflog. Comparing HEAD before and after the tool call rejects both failure modes
 * without trusting the tool result. That matters for compound commands such as
 * `git commit -m x && npm test`: the commit landed even though the tool result is an
 * error, and the event is still deserved. So this decision deliberately does NOT gate
 * on `event.isError`.
 *
 * A HEAD move alone is not enough: checkout, reset and rebase also move HEAD. The newest
 * reflog entry names the operation that produced this HEAD, and only a `commit:` subject
 * (with its amend/initial/merge/cherry-pick/rebase variants) counts as a commit.
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

/**
 * Marker for "the cwd was not a git work tree when the call started". Distinct from an
 * unreadable snapshot (`undefined`: timeout, malformed output), because only this state
 * can legitimately turn into a repository inside the same bash call (`git init && ...`).
 */
export const NOT_A_REPOSITORY = Symbol("not-a-repository");

/** A remembered pre-call HEAD: a real state, or the not-a-repository marker. */
export type HeadSnapshot = HeadState | typeof NOT_A_REPOSITORY;

/** Newest HEAD reflog entry: the commit it points at and the operation that wrote it. */
export interface HeadReflogEntry {
  /** Full 40-char SHA of the commit the newest reflog entry describes. */
  sha: string;
  /** Reflog subject, e.g. `commit: feat: x`, `commit (amend): x`, `checkout: moving from a to b`. */
  subject: string;
}

/** A commit feed event decision: preview for the feed, and the activity line. */
export interface CommitFeedDecision {
  preview: string;
  lastToolCall: string;
}

/**
 * What a bounded git probe asks. The probe counter below reports these kinds; the calls
 * themselves stay private and synchronous.
 */
export type GitProbeKind = "head" | "rev-parse-verify" | "work-tree" | "reflog";

const GIT_TIMEOUT_MS = 2000;

/**
 * Commit-producing reflog subjects. Anchored on purpose: the subject must start with
 * `commit`. `cherry-pick` is what `git commit --no-edit` writes when it finishes a
 * conflicted cherry-pick (git 2.39.5); `rebase` is the same operation on git versions that
 * annotate it instead of writing a plain `commit:`.
 */
const COMMIT_REFLOG_SUBJECT = /^commit( \((amend|initial|merge|cherry-pick|rebase)\))?:/;

let probeCounter: ((kind: GitProbeKind) => void) | undefined;
let probeFailureInjector: ((kind: GitProbeKind) => boolean) | undefined;

/**
 * Test seam: observe the git probes this module issues. Production leaves it unset, so
 * the only cost is one `undefined` check per probe; the probes themselves stay synchronous
 * and bounded by GIT_TIMEOUT_MS.
 */
export function setGitProbeCounter(counter: ((kind: GitProbeKind) => void) | undefined): void {
  probeCounter = counter;
}

/**
 * Test seam: make the next probe of a kind fail with a synthetic non-timeout error, so
 * the probe's own catch path runs exactly as it would for a transient git failure. Like
 * the counter it is unset in production, where the only cost is one `undefined` check.
 */
export function setGitProbeFailureInjector(
  injector: ((kind: GitProbeKind) => boolean) | undefined,
): void {
  probeFailureInjector = injector;
}

function countProbe(kind: GitProbeKind): void {
  probeCounter?.(kind);
}

function failProbeIfInjected(kind: GitProbeKind): void {
  if (probeFailureInjector?.(kind)) throw new Error(`injected git probe failure: ${kind}`);
}

/** Same semantics as the previous `isGitCommit` in index.ts. */
export function isGitCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/.test(command);
}

/**
 * Result of one bounded HEAD probe:
 * - `head` — a real state, possibly `UNBORN_HEAD` for a repository without commits,
 * - `not-a-repository` — a confirmed work-tree probe says cwd is not a work tree,
 * - `unreadable` — timeout, malformed output, or a transient probe failure; it proves
 *   nothing and never emits.
 */
export type HeadProbe =
  | { kind: "head"; state: HeadState }
  | { kind: "not-a-repository" }
  | { kind: "unreadable" };

/** One bounded git call classifying HEAD of `cwd`. */
export function probeHead(cwd: string): HeadProbe {
  try {
    countProbe("head");
    failProbeIfInjected("head");
    // NUL-separated so a subject containing spaces or punctuation stays intact.
    const raw = execSync("git log -1 --format=%H%x00%h%x00%s", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [sha, shortSha, subject] = raw.replace(/\r?\n$/, "").split("\0");
    if (!sha || !shortSha) return { kind: "unreadable" };
    return {
      kind: "head",
      state: { sha: sha.trim(), shortSha: shortSha.trim(), subject: (subject ?? "").trim() },
    };
  } catch (error) {
    // A timed-out read says nothing about HEAD, so it stays unreadable. The same reasoning
    // applies to every other failure: believing `git log` would let a transient failure in
    // a born repository be remembered as UNBORN_HEAD, and the next successful read of the
    // unchanged HEAD would pass the transition check and invent a commit event.
    if (isTimeoutError(error)) return { kind: "unreadable" };
    // `git log` also fails in a genuine unborn repository and outside a repository. Ask
    // whether HEAD itself names a commit before believing the log failure: a readable SHA
    // proves the repository is born, so the log read was transient and must stay
    // unreadable (never remembered as unborn).
    const headEvidence = probeVerifyHead(cwd);
    if (headEvidence !== "unborn") return { kind: "unreadable" };
    // HEAD does not resolve, so cwd is either an unborn repository or not a work tree.
    // Only a confirmed work-tree answer may be remembered; a failed work-tree probe
    // proves nothing and must not fabricate either state.
    const workTree = probeWorkTree(cwd);
    if (workTree === "probe-error") return { kind: "unreadable" };
    return workTree === "inside"
      ? { kind: "head", state: UNBORN_HEAD }
      : { kind: "not-a-repository" };
  }
}

/**
 * HEAD of `cwd`, or `undefined` when it cannot be read. Callers that must tell "no
 * repository yet" apart from "unreadable" use `probeHead` instead.
 */
export function readHeadState(cwd: string): HeadState | undefined {
  const probe = probeHead(cwd);
  return probe.kind === "head" ? probe.state : undefined;
}

/** execSync signals a timeout with code ETIMEDOUT (and SIGTERM to the child). */
function isTimeoutError(error: unknown): boolean {
  const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
  return code === "ETIMEDOUT" || signal === "SIGTERM";
}

/**
 * git's own answer that no repository was found: exit 128 with the plumbing's definitive
 * "not a git repository" diagnostic. This is a confirmed outside answer, not a failed
 * probe. Any other failure (EMFILE, a spawn error, an unreadable/corrupt repository) must
 * not be mistaken for it, or the sentinel would be fabricated and a later read could
 * announce a false first commit.
 */
function isNotARepositoryError(error: unknown): boolean {
  const { status, stderr } = (error ?? {}) as { status?: unknown; stderr?: unknown };
  if (status !== 128) return false;
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "";
  return /not a git repository/i.test(text);
}

/**
 * What the `git rev-parse --verify -q HEAD` probe proved. `born` means HEAD resolves to a
 * commit, so a preceding `git log` failure was transient. `unborn` is git's definite "no
 * such ref" answer (an unborn HEAD or no repository). `probe-error` means the probe itself
 * failed, which proves nothing and must fail closed.
 */
type HeadEvidence = "born" | "unborn" | "probe-error";

/** Bounded call that tests whether HEAD resolves to a commit. Paid only on log failure. */
function probeVerifyHead(cwd: string): HeadEvidence {
  try {
    countProbe("rev-parse-verify");
    failProbeIfInjected("rev-parse-verify");
    const out = execSync("git rev-parse --verify -q HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A successful verify prints the SHA. Exit 0 with no output is malformed: fail closed.
    return out.trim() ? "born" : "probe-error";
  } catch (error) {
    if (isTimeoutError(error)) return "probe-error";
    // A plain nonzero exit is git's answer that the ref does not resolve. Anything else
    // (spawn failure, unreadable result) proves nothing.
    const { status } = (error ?? {}) as { status?: unknown };
    return typeof status === "number" && status !== 0 ? "unborn" : "probe-error";
  }
}

/**
 * What `git rev-parse --is-inside-work-tree` learned: a confirmed answer, or a failed
 * probe. A failure must never be folded into "outside": doing so fabricates a
 * not-a-repository marker and lets the next successful read announce a false first commit.
 */
type WorkTreeProbe = "inside" | "outside" | "probe-error";

/** Third bounded call, paid only when HEAD does not resolve, to classify cwd. */
function probeWorkTree(cwd: string): WorkTreeProbe {
  try {
    countProbe("work-tree");
    failProbeIfInjected("work-tree");
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      // The catch below matches git's plumbing diagnostic to tell a confirmed "outside"
      // from a failed probe; pin its locale so a translated message cannot silently turn
      // a genuine non-repository into "unreadable".
      env: { ...process.env, LC_ALL: "C" },
    });
    // "false" is a confirmed answer (a bare repository is not a work tree).
    return out.trim() === "true" ? "inside" : "outside";
  } catch (error) {
    // git's definitive "not a git repository" is also a confirmed outside answer; it is
    // what preserves the sentinel for a directory that is not a repository yet.
    if (isNotARepositoryError(error)) return "outside";
    // Timeout, missing git, or a transient spawn/read failure: no answer at all. Folding
    // this into "outside" would fabricate the sentinel and invent a first commit later.
    return "probe-error";
  }
}

/**
 * One bounded call for the newest HEAD reflog entry, or `undefined` when there is none,
 * the cwd is not a repository, HEAD is unborn, or the read fails. Fail closed: without a
 * readable entry the caller cannot prove a commit, so it stays silent.
 */
export function readHeadReflog(cwd: string): HeadReflogEntry | undefined {
  try {
    countProbe("reflog");
    failProbeIfInjected("reflog");
    // %H is the commit the entry points at; %gs is the operation that wrote it, e.g.
    // `commit: subject` or `checkout: moving from main to feature`.
    const raw = execSync("git reflog -1 --format=%H%x00%gs", {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [sha, subject] = raw.replace(/\r?\n$/, "").split("\0");
    if (!sha) return undefined;
    return { sha: sha.trim(), subject: (subject ?? "").trim() };
  } catch {
    // An unreadable reflog (no entries, reflogs disabled, timeout) proves nothing.
    return undefined;
  }
}

/** Maximum remembered tool calls; past this the oldest id is dropped. */
export const MAX_TRACKED_COMMIT_HEADS = 64;

/**
 * Pre-call HEAD per tool call id, so the tool result can tell whether the call moved HEAD.
 * Bounded drop-oldest: a long session cannot grow it without limit, and a forgotten id
 * simply produces no event instead of a wrong one.
 */
export class CommitHeadTracker {
  private readonly heads = new Map<string, HeadSnapshot>();
  private readonly limit: number;

  constructor(limit: number = MAX_TRACKED_COMMIT_HEADS) {
    this.limit = limit;
  }

  remember(toolCallId: string, snapshot: HeadSnapshot): void {
    this.heads.set(toolCallId, snapshot);
    while (this.heads.size > this.limit) {
      const oldest = this.heads.keys().next();
      if (oldest.done) break;
      this.heads.delete(oldest.value);
    }
  }

  /** Get and forget: a call is decided once, and a later retry must not reuse the state. */
  take(toolCallId: string): HeadSnapshot | undefined {
    const snapshot = this.heads.get(toolCallId);
    this.heads.delete(toolCallId);
    return snapshot;
  }

  get size(): number {
    return this.heads.size;
  }
}

/**
 * tool_call side of the hook: remember the pre-call HEAD for this tool call. A cwd that is
 * not a repository yet is remembered as NOT_A_REPOSITORY, because the same bash call may
 * run `git init` and commit; an unreadable read (timeout or a transient probe failure) is
 * not remembered at all, so no later successful read can turn it into a false event.
 */
export function rememberHeadBeforeCall(
  tracker: CommitHeadTracker,
  toolCallId: string,
  cwd: string,
): void {
  const probe = probeHead(cwd);
  if (probe.kind === "head") tracker.remember(toolCallId, probe.state);
  else if (probe.kind === "not-a-repository") tracker.remember(toolCallId, NOT_A_REPOSITORY);
}

/**
 * tool_result side of the hook: decide the commit event for this tool call, consuming its
 * remembered HEAD. The reflog probe is paid only when a HEAD transition could still
 * produce an event, so a failed or unrelated call costs no more than the HEAD read.
 */
export function decideCommitEventForCall(
  tracker: CommitHeadTracker,
  toolCallId: string,
  cwd: string,
): CommitFeedDecision | undefined {
  const headBefore = tracker.take(toolCallId);
  const headAfter = readHeadState(cwd);
  const newestReflog = hasHeadTransition({ headBefore, headAfter }) ? readHeadReflog(cwd) : undefined;
  return decideCommitEvent({ headBefore, headAfter, newestReflog });
}

/** A directory that was not a repository before the call had no HEAD at all. */
function normalizeHeadBefore(snapshot: HeadSnapshot | undefined): HeadState | undefined {
  return snapshot === NOT_A_REPOSITORY ? UNBORN_HEAD : snapshot;
}

/**
 * Pure pre-check: could these two snapshots describe a commit landing? A remembered
 * `NOT_A_REPOSITORY` counts as unborn, so `no repository -> real SHA` is a transition; a
 * missing (unreadable) side never is. A real HEAD that becomes unborn is HEAD destruction
 * (an orphan checkout, `update-ref -d`), never a commit, so it is rejected here before the
 * caller pays for a reflog probe. The reflog gate decides the rest.
 */
export function hasHeadTransition(input: {
  headBefore?: HeadSnapshot;
  headAfter?: HeadState;
}): boolean {
  const headBefore = normalizeHeadBefore(input.headBefore);
  if (!headBefore || !input.headAfter) return false;
  // Real SHA -> UNBORN_HEAD destroys HEAD; it cannot be the commit being announced. The
  // opposite direction, "" -> real, stays a candidate: it is the repository's first commit.
  if (headBefore.sha !== "" && input.headAfter.sha === "") return false;
  return headBefore.sha !== input.headAfter.sha;
}

/**
 * Pure decision: emit a commit feed event only when HEAD moved between the two reads AND
 * the newest HEAD reflog entry says a commit produced it. The preview comes from git
 * (`shortSha` + `subject`), never from the command text, so `-F`, heredocs and repeated
 * `-m` flags all report the real message.
 *
 * An unborn `headBefore` (empty `sha`, i.e. `UNBORN_HEAD`) is a real state, not a missing
 * one: `"" -> <real sha>` is the repository's first commit and deserves the event, while
 * `"" -> ""` means the first commit failed and stays silent. The same holds for a call
 * that started in a directory which was not a repository yet. The opposite move, a real
 * SHA -> unborn, destroys HEAD (an orphan checkout, `update-ref -d`) and is rejected by
 * `hasHeadTransition` before the reflog probe. A missing state (`undefined`) is unreadable,
 * so it never produces an event.
 *
 * Do not replace the reflog check with a parent/ancestry check. That was tested
 * empirically and does not discriminate: with main=A and a feature branch whose tip is a
 * child of A, both `git checkout feature && echo 'git commit'` and a real `git commit`
 * leave the new HEAD's first parent equal to A.
 *
 * Fail closed: an unreadable reflog, and a commit followed by a later non-commit reflog
 * entry in the same bash call (the newest entry is then a checkout or switch), both emit
 * nothing.
 */
export function decideCommitEvent(input: {
  headBefore?: HeadSnapshot;
  headAfter?: HeadState;
  newestReflog?: HeadReflogEntry;
}): CommitFeedDecision | undefined {
  const { headAfter, newestReflog } = input;
  if (!headAfter || !hasHeadTransition(input)) return undefined;
  if (!newestReflog) return undefined;
  // A reflog entry for an older HEAD cannot explain the current one.
  if (newestReflog.sha !== headAfter.sha) return undefined;
  if (!COMMIT_REFLOG_SUBJECT.test(newestReflog.subject)) return undefined;

  // Filter empty parts so an absent short SHA cannot leave a leading space.
  const preview = [headAfter.shortSha.trim(), (headAfter.subject ?? "").trim()].filter(Boolean).join(" ");
  return { preview, lastToolCall: `commit: ${preview}` };
}
