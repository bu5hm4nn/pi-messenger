import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatFeedLine, logFeedEvent, readFeedEvents, type FeedEvent } from "../feed.ts";
import {
  CommitHeadTracker,
  MAX_TRACKED_COMMIT_HEADS,
  NOT_A_REPOSITORY,
  UNBORN_HEAD,
  decideCommitEvent,
  decideCommitEventForCall,
  hasHeadTransition,
  isGitCommitCommand,
  probeHead,
  readHeadReflog,
  readHeadState,
  rememberHeadBeforeCall,
  setGitProbeCounter,
  type GitProbeKind,
  type HeadReflogEntry,
  type HeadState,
} from "../git-commit.ts";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";

/**
 * Hermetic git environment for the whole file.
 *
 * These tests run real git, and both the fixtures (`git()` below) and the production
 * readers in git-commit.ts inherit `process.env`. Sanitizing it once, for the file, keeps
 * the two in sync: a developer's global `commit.gpgsign`/`core.hooksPath`/`init.templateDir`
 * cannot break a fixture commit, and an inherited `GIT_REFLOG_ACTION` cannot rewrite the
 * reflog subjects this suite asserts on. Every inherited `GIT_*` override is cleared; only
 * the identity git needs to create commits is set.
 */
const SANITIZED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Pi Messenger Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Pi Messenger Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Never discover a repository above the temp dir, so "outside a repository" is stable
  // even when the operator keeps their tmpdir inside a checkout.
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};

const inheritedGitEnv = new Map<string, string>();

beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("GIT_")) continue;
    inheritedGitEnv.set(key, process.env[key] as string);
    delete process.env[key];
  }
  Object.assign(process.env, SANITIZED_GIT_ENV);
});

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) delete process.env[key];
  }
  for (const [key, value] of inheritedGitEnv) process.env[key] = value;
});

afterEach(() => {
  setGitProbeCounter(undefined);
});

/** Run a shell command; inherits the sanitized process env, like the production readers. */
function run(command: string, cwd: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function git(args: string, cwd: string): string {
  return run(`git ${args}`, cwd);
}

/** `--template=` ignores any configured init.templateDir (hooks could break a commit). */
function initRepo(cwd: string): string {
  git("init -q -b main --template=", cwd);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  git("add .", cwd);
  git('commit -qm "init"', cwd);
  return git("rev-parse HEAD", cwd);
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  fs.writeFileSync(path.join(cwd, file), content);
  git("add .", cwd);
  git(`commit -qm "${message}"`, cwd);
  return git("rev-parse HEAD", cwd);
}

function head(sha: string, shortSha: string, subject: string): HeadState {
  return { sha, shortSha, subject };
}

function reflog(sha: string, subject: string): HeadReflogEntry {
  return { sha, subject };
}

/** Run `fn` while recording every git probe it causes, in order. */
function recordProbes(fn: () => void): GitProbeKind[] {
  const probes: GitProbeKind[] = [];
  setGitProbeCounter(kind => probes.push(kind));
  try {
    fn();
  } finally {
    setGitProbeCounter(undefined);
  }
  return probes;
}

/** Mirror of the hook's feed side effect: only a decision writes a commit event. */
function logIfDecided(cwd: string, decision: { preview: string } | undefined): void {
  if (decision) logFeedEvent(cwd, "AgentOne", "commit", undefined, decision.preview);
}

function commitEvents(cwd: string): FeedEvent[] {
  return readFeedEvents(cwd, 20).filter(event => event.type === "commit");
}

describe("isGitCommitCommand", () => {
  it("keeps the previous regex semantics", () => {
    expect(isGitCommitCommand("git commit -m \"x\"")).toBe(true);
    expect(isGitCommitCommand("cd repo && git  commit --amend")).toBe(true);
    expect(isGitCommitCommand("echo 'git commit -m not-a-commit'")).toBe(true);
    expect(isGitCommitCommand("git add a.txt && git commit --no-edit")).toBe(true);
    expect(isGitCommitCommand("git status")).toBe(false);
    // Word boundary: "legit commit" is not a `git commit` command
    expect(isGitCommitCommand("legit commit")).toBe(false);
  });
});

describe("decideCommitEvent", () => {
  it("returns undefined when HEAD did not move", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("a".repeat(40), "aaaaaaa", "init");

    expect(
      decideCommitEvent({ headBefore: before, headAfter: after, newestReflog: reflog(after.sha, "commit: init") }),
    ).toBeUndefined();
  });

  it("returns undefined when the head before is missing", () => {
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship it");

    expect(
      decideCommitEvent({
        headBefore: undefined,
        headAfter: after,
        newestReflog: reflog(after.sha, "commit: feat: ship it"),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the head after is missing", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");

    expect(
      decideCommitEvent({ headBefore: before, headAfter: undefined, newestReflog: reflog(before.sha, "commit: init") }),
    ).toBeUndefined();
  });

  it("names the new short SHA and subject when a commit moved HEAD", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship the feed fix");

    const decision = decideCommitEvent({
      headBefore: before,
      headAfter: after,
      newestReflog: reflog(after.sha, "commit: feat: ship the feed fix"),
    });

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe("bbbbbbb feat: ship the feed fix");
    expect(decision!.lastToolCall).toBe("commit: bbbbbbb feat: ship the feed fix");
  });

  it("names the first commit of a repository whose HEAD was unborn", () => {
    const after = head("b".repeat(40), "bbbbbbb", "init: first commit");

    const decision = decideCommitEvent({
      headBefore: UNBORN_HEAD,
      headAfter: after,
      newestReflog: reflog(after.sha, "commit (initial): init: first commit"),
    });

    // "" -> real SHA is the initial commit, so the event is deserved
    expect(decision).toBeDefined();
    expect(decision!.preview).toBe("bbbbbbb init: first commit");
  });

  it("returns undefined when HEAD is still unborn after the attempt", () => {
    // "" -> "": the first commit failed, so nothing landed
    expect(
      decideCommitEvent({ headBefore: UNBORN_HEAD, headAfter: UNBORN_HEAD, newestReflog: undefined }),
    ).toBeUndefined();
  });

  it("returns undefined when the state before is unreadable even though HEAD is unborn after", () => {
    // An unreadable headBefore is not the same claim as an unborn one: stay silent
    expect(
      decideCommitEvent({ headBefore: undefined, headAfter: UNBORN_HEAD, newestReflog: undefined }),
    ).toBeUndefined();
  });

  it("returns undefined when the newest reflog entry is unreadable", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship it");

    // Fail closed: HEAD moved, but with no operation evidence nothing is proved
    expect(decideCommitEvent({ headBefore: before, headAfter: after, newestReflog: undefined })).toBeUndefined();
  });

  it("returns undefined when the reflog entry describes an older HEAD", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship it");

    expect(
      decideCommitEvent({ headBefore: before, headAfter: after, newestReflog: reflog(before.sha, "commit: feat: ship it") }),
    ).toBeUndefined();
  });

  it("returns undefined when a non-commit operation moved HEAD", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: existing work");

    for (const subject of [
      "checkout: moving from main to feature",
      "reset: moving to HEAD~1",
      "rebase (finish): returning to refs/heads/main",
      // A fast-forward merge moves HEAD without creating a commit
      "merge other: Fast-forward",
    ]) {
      expect(decideCommitEvent({ headBefore: before, headAfter: after, newestReflog: reflog(after.sha, subject) })).toBeUndefined();
    }
  });

  it("accepts every commit-producing reflog subject", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: x");

    for (const prefix of [
      "commit:",
      "commit (amend):",
      "commit (initial):",
      "commit (merge):",
      // `git commit --no-edit` finishing a conflicted cherry-pick (git 2.39.5)
      "commit (cherry-pick):",
      // The same operation on git versions that annotate the rebase
      "commit (rebase):",
    ]) {
      const decision = decideCommitEvent({
        headBefore: before,
        headAfter: after,
        newestReflog: reflog(after.sha, `${prefix} feat: x`),
      });
      expect(decision!.preview).toBe("bbbbbbb feat: x");
    }
  });

  it("anchors the commit subject at the start of the reflog entry", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: x");

    for (const subject of [
      "cherry-pick: feat: x",
      "rebase (pick): commit: feat: x",
      "xcommit: feat: x",
      "merge other: Merge made by the 'ort' strategy.",
    ]) {
      expect(decideCommitEvent({ headBefore: before, headAfter: after, newestReflog: reflog(after.sha, subject) })).toBeUndefined();
    }
  });

  it("emits for a repository created inside the call", () => {
    const after = head("b".repeat(40), "bbbbbbb", "init: first commit");

    // A directory that was not a repository at tool_call has no prior HEAD; the reflog
    // gate still has to prove that a commit produced the new one.
    const decision = decideCommitEvent({
      headBefore: NOT_A_REPOSITORY,
      headAfter: after,
      newestReflog: reflog(after.sha, "commit (initial): init: first commit"),
    });

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe("bbbbbbb init: first commit");
  });

  it("stays silent when a call that started outside a repository only ran git init", () => {
    // NOT_A_REPOSITORY -> unborn: a repository appeared, but no commit landed
    expect(
      decideCommitEvent({ headBefore: NOT_A_REPOSITORY, headAfter: UNBORN_HEAD, newestReflog: undefined }),
    ).toBeUndefined();
  });

  it("stays silent when a call that started outside a repository read no HEAD after", () => {
    expect(
      decideCommitEvent({ headBefore: NOT_A_REPOSITORY, headAfter: undefined, newestReflog: undefined }),
    ).toBeUndefined();
  });

  it("still requires the reflog when the call started outside a repository", () => {
    const after = head("b".repeat(40), "bbbbbbb", "feat: x");

    // HEAD appeared, but checkout/clone/reset are not commits either
    expect(
      decideCommitEvent({
        headBefore: NOT_A_REPOSITORY,
        headAfter: after,
        newestReflog: reflog(after.sha, "reset: moving to origin/main"),
      }),
    ).toBeUndefined();
    expect(
      decideCommitEvent({ headBefore: NOT_A_REPOSITORY, headAfter: after, newestReflog: undefined }),
    ).toBeUndefined();
  });

  it("never renders a stray leading space when the short SHA is empty", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "", "feat: subject only");

    const decision = decideCommitEvent({
      headBefore: before,
      headAfter: after,
      newestReflog: reflog(after.sha, "commit: feat: subject only"),
    });

    expect(decision!.preview).toBe("feat: subject only");
    expect(decision!.lastToolCall).toBe("commit: feat: subject only");
  });

  it("trims the subject and tolerates an empty one", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const padded = head("b".repeat(40), "bbbbbbb", "  spaced subject  ");
    const empty = head("c".repeat(40), "ccccccc", "");

    expect(
      decideCommitEvent({ headBefore: before, headAfter: padded, newestReflog: reflog(padded.sha, "commit: x") })!.preview,
    ).toBe("bbbbbbb spaced subject");
    expect(
      decideCommitEvent({ headBefore: before, headAfter: empty, newestReflog: reflog(empty.sha, "commit: x") })!.preview,
    ).toBe("ccccccc");
    expect(
      decideCommitEvent({ headBefore: before, headAfter: empty, newestReflog: reflog(empty.sha, "commit: x") })!.lastToolCall,
    ).toBe("commit: ccccccc");
  });
});

describe("hasHeadTransition", () => {
  it("only reports a transition for two readable, different SHAs", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: x");

    expect(hasHeadTransition({ headBefore: before, headAfter: after })).toBe(true);
    expect(hasHeadTransition({ headBefore: before, headAfter: before })).toBe(false);
    expect(hasHeadTransition({ headBefore: undefined, headAfter: after })).toBe(false);
    expect(hasHeadTransition({ headBefore: before, headAfter: undefined })).toBe(false);
  });

  it("treats a not-a-repository snapshot as unborn", () => {
    const after = head("b".repeat(40), "bbbbbbb", "feat: x");

    // The call can create and commit a repository, so this is a candidate...
    expect(hasHeadTransition({ headBefore: NOT_A_REPOSITORY, headAfter: after })).toBe(true);
    // ...but it is not a HEAD move until a real commit appears.
    expect(hasHeadTransition({ headBefore: NOT_A_REPOSITORY, headAfter: UNBORN_HEAD })).toBe(false);
    expect(hasHeadTransition({ headBefore: NOT_A_REPOSITORY, headAfter: undefined })).toBe(false);
  });
});

describe("probeHead", () => {
  it("classifies a repository with commits", () => {
    const cwd = createTempCrewDirs().cwd;
    const base = initRepo(cwd);

    expect(probeHead(cwd)).toEqual({
      kind: "head",
      state: { sha: base, shortSha: git("rev-parse --short HEAD", cwd), subject: "init" },
    });
  });

  it("classifies a repository whose HEAD is unborn", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);

    expect(probeHead(cwd)).toEqual({ kind: "head", state: UNBORN_HEAD });
  });

  it("classifies a directory that is not a repository as not-a-repository", () => {
    const cwd = createTempCrewDirs().cwd;

    expect(probeHead(cwd)).toEqual({ kind: "not-a-repository" });
  });
});

describe("readHeadState", () => {
  it("reads the current HEAD of a repository", () => {
    const cwd = createTempCrewDirs().cwd;
    const base = initRepo(cwd);

    const state = readHeadState(cwd);

    expect(state).toBeDefined();
    expect(state!.sha).toBe(base);
    expect(state!.shortSha).toBe(git("rev-parse --short HEAD", cwd));
    expect(state!.subject).toBe("init");
  });

  it("returns undefined outside a repository", () => {
    const cwd = createTempCrewDirs().cwd;

    expect(readHeadState(cwd)).toBeUndefined();
  });

  it("does not mistake a bare directory for an unborn repository", () => {
    const cwd = createTempCrewDirs().cwd;
    const nested = path.join(cwd, "nested", "deeper");
    fs.mkdirSync(nested, { recursive: true });

    expect(readHeadState(cwd)).toBeUndefined();
    expect(readHeadState(nested)).toBeUndefined();
  });

  it("reports UNBORN_HEAD in a fresh repository before the first commit", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);

    expect(readHeadState(cwd)).toEqual(UNBORN_HEAD);
  });

  it("reports the real HEAD once a commit exists", () => {
    const cwd = createTempCrewDirs().cwd;
    const base = initRepo(cwd);

    const state = readHeadState(cwd);

    expect(state).not.toEqual(UNBORN_HEAD);
    expect(state!.sha).toBe(base);
  });
});

describe("readHeadReflog", () => {
  it("reads the newest HEAD reflog entry for the current HEAD", () => {
    const cwd = createTempCrewDirs().cwd;
    const base = initRepo(cwd);

    const entry = readHeadReflog(cwd);

    expect(entry).toBeDefined();
    expect(entry!.sha).toBe(base);
    expect(entry!.subject).toBe("commit (initial): init");
  });

  it("reads the operation that produced a later HEAD", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    commitFile(cwd, "feature.txt", "shipped\n", "feat: add feature.txt");

    const entry = readHeadReflog(cwd);

    expect(entry!.sha).toBe(git("rev-parse HEAD", cwd));
    expect(entry!.subject).toBe("commit: feat: add feature.txt");
  });

  it("returns undefined outside a repository", () => {
    const cwd = createTempCrewDirs().cwd;

    expect(readHeadReflog(cwd)).toBeUndefined();
  });

  it("returns undefined when HEAD has no reflog entry yet", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);

    expect(readHeadReflog(cwd)).toBeUndefined();
  });
});

describe("CommitHeadTracker", () => {
  it("remembers and takes a HEAD snapshot by tool call id", () => {
    const tracker = new CommitHeadTracker();
    const state = head("a".repeat(40), "aaaaaaa", "init");

    tracker.remember("call-1", state);

    expect(tracker.take("call-1")).toEqual(state);
  });

  it("deletes on take, so a second take misses", () => {
    const tracker = new CommitHeadTracker();
    tracker.remember("call-1", head("a".repeat(40), "aaaaaaa", "init"));

    expect(tracker.take("call-1")).toBeDefined();
    expect(tracker.take("call-1")).toBeUndefined();
  });

  it("returns undefined for an id it never saw", () => {
    const tracker = new CommitHeadTracker();
    tracker.remember("call-1", UNBORN_HEAD);

    expect(tracker.take("other-call")).toBeUndefined();
    // A miss must not disturb the entry it did not ask for
    expect(tracker.take("call-1")).toEqual(UNBORN_HEAD);
  });

  it("round-trips the not-a-repository marker by identity", () => {
    const tracker = new CommitHeadTracker();
    tracker.remember("call-1", NOT_A_REPOSITORY);

    expect(tracker.take("call-1")).toBe(NOT_A_REPOSITORY);
  });

  it("is bounded at MAX_TRACKED_COMMIT_HEADS, dropping the oldest id first", () => {
    const tracker = new CommitHeadTracker();
    const state = head("a".repeat(40), "aaaaaaa", "init");

    // Fill to the bound, then one more: only the first id should be gone
    for (let i = 0; i <= MAX_TRACKED_COMMIT_HEADS; i++) {
      tracker.remember(`call-${i}`, state);
    }

    expect(tracker.size).toBe(MAX_TRACKED_COMMIT_HEADS);
    expect(tracker.take("call-0")).toBeUndefined();
    expect(tracker.take("call-1")).toEqual(state);
    expect(tracker.take(`call-${MAX_TRACKED_COMMIT_HEADS}`)).toEqual(state);
    // take() shrinks the map; the cap is an upper bound, not a fixed size
    expect(tracker.size).toBeLessThan(MAX_TRACKED_COMMIT_HEADS);
  });
});

describe("commit feed event from a real repository", () => {
  it("reports the first commit of a brand new repository", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);
    fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
    git("add .", cwd);

    // HEAD is unborn before the first commit, which is a state, not a failed read
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    git('commit -qm "init: first commit"', cwd);

    const decision = decideCommitEventForCall(tracker, "call-1", cwd);

    expect(decision).toBeDefined();
    const shortSha = git("rev-parse --short HEAD", cwd);
    expect(decision!.preview).toBe(`${shortSha} init: first commit`);
    expect(decision!.lastToolCall).toBe(`commit: ${shortSha} init: first commit`);
  });

  it("reports nothing when the first commit of a fresh repository fails", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    // Nothing staged: git exits non-zero and HEAD stays unborn
    expect(() => git('commit -m "x"', cwd)).toThrow();

    expect(decideCommitEventForCall(tracker, "call-1", cwd)).toBeUndefined();
    expect(readHeadState(cwd)).toEqual(UNBORN_HEAD);
  });

  it("reports a real commit with its short SHA and message", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    commitFile(cwd, "feature.txt", "shipped\n", "feat: add feature.txt");

    const decision = decideCommitEventForCall(tracker, "call-1", cwd);

    expect(decision).toBeDefined();
    const shortSha = git("rev-parse --short HEAD", cwd);
    expect(decision!.preview).toBe(`${shortSha} feat: add feature.txt`);
    expect(decision!.lastToolCall).toBe(`commit: ${shortSha} feat: add feature.txt`);
  });

  it("reports nothing for a failed commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    expect(() => git('commit -m "nothing staged"', cwd)).toThrow();

    expect(decideCommitEventForCall(tracker, "call-1", cwd)).toBeUndefined();
  });

  it("reports nothing for a no-op commit attempt", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    commitFile(cwd, "feature.txt", "shipped\n", "feat: add feature.txt");
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    // Nothing staged and nothing changed: git exits non-zero and HEAD stays put
    expect(() => git('commit -m "again"', cwd)).toThrow();

    expect(decideCommitEventForCall(tracker, "call-1", cwd)).toBeUndefined();
  });

  it("takes the message from git, not from the command text", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const headBefore = readHeadState(cwd);

    fs.writeFileSync(path.join(cwd, "msg.txt"), "subject from file\n\nbody ignored by the subject line\n");
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    git("commit -q -F msg.txt", cwd);

    const decision = decideCommitEvent({
      headBefore,
      headAfter: readHeadState(cwd),
      newestReflog: readHeadReflog(cwd),
    });

    expect(decision!.preview).toBe(`${git("rev-parse --short HEAD", cwd)} subject from file`);
  });

  it("still reports the commit when a compound command fails afterwards", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    let isError = false;
    try {
      run('git commit -qm "feat: add feature.txt" && exit 1', cwd);
    } catch {
      isError = true;
    }
    expect(isError).toBe(true);

    // The commit landed even though the tool result is an error: the event is deserved,
    // so the decision must not consult event.isError.
    const decision = decideCommitEventForCall(tracker, "call-1", cwd);

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe(`${git("rev-parse --short HEAD", cwd)} feat: add feature.txt`);
  });

  it("writes no commit event for a command that only mentions git commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const command = "echo 'git commit -m not-a-commit'";

    expect(isGitCommitCommand(command)).toBe(true);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);
    run(command, cwd);
    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));

    expect(commitEvents(cwd)).toHaveLength(0);
  });

  it("writes no commit event when a checkout moves HEAD for a non-commit reason", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    git("checkout -q -b feature", cwd);
    commitFile(cwd, "feature.txt", "shipped\n", "feat: feature work");
    git("checkout -q main", cwd);

    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);
    const mainSha = readHeadState(cwd)!.sha;

    // The command mentions `git commit`, but checkout is what moved HEAD
    const command = "git checkout -q feature && echo 'git commit'";
    expect(isGitCommitCommand(command)).toBe(true);
    run(command, cwd);

    const headAfter = readHeadState(cwd);
    expect(headAfter!.sha).not.toBe(mainSha);
    // The gate sees a real HEAD move, and the reflog is what rejects it
    expect(readHeadReflog(cwd)!.sha).toBe(headAfter!.sha);
    expect(readHeadReflog(cwd)!.subject).toBe("checkout: moving from main to feature");

    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));
    expect(commitEvents(cwd)).toHaveLength(0);
  });

  it("writes no commit event when a later non-commit reflog entry hides the commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    git("checkout -q -b feature", cwd);
    git('commit --allow-empty -qm "feat: feature work"', cwd);
    git("checkout -q main", cwd);

    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    // The commit lands, but the newest reflog entry is the checkout: fail closed
    run('git commit --allow-empty -qm "feat: empty" && git checkout -q feature', cwd);

    expect(readHeadReflog(cwd)!.subject).toBe("checkout: moving from main to feature");

    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));
    expect(commitEvents(cwd)).toHaveLength(0);
  });

  it("reports an amended commit from its amend reflog entry", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    commitFile(cwd, "feature.txt", "shipped\n", "feat: add feature.txt");
    // Amend the commit that just landed, as a second command in the same bash call
    git("commit --amend -qm 'feat: amended'", cwd);

    const entry = readHeadReflog(cwd);
    expect(entry!.subject).toBe("commit (amend): feat: amended");

    const decision = decideCommitEventForCall(tracker, "call-1", cwd);

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe(`${git("rev-parse --short HEAD", cwd)} feat: amended`);
  });

  it("reports a cherry-pick finished with git commit --no-edit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    commitFile(cwd, "a.txt", "base\n", "base");

    // A feature commit that conflicts with a main-side change to the same file
    git("checkout -q -b feature", cwd);
    commitFile(cwd, "a.txt", "feature\n", "feature change");
    git("checkout -q main", cwd);
    commitFile(cwd, "a.txt", "main\n", "main change");

    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    // The cherry-pick conflicts and exits non-zero, leaving CHERRY_PICK_HEAD behind
    expect(() => git("cherry-pick feature", cwd)).toThrow();
    expect(git("status --porcelain", cwd)).toContain("UU a.txt");

    fs.writeFileSync(path.join(cwd, "a.txt"), "resolved\n");
    // Resolving and finishing is a plain commit command, so it must be attributed
    const finish = "git add a.txt && git commit --no-edit -q";
    expect(isGitCommitCommand(finish)).toBe(true);
    run(finish, cwd);

    // git 2.39.5 writes this subject; the allowlist must accept it
    expect(readHeadReflog(cwd)!.subject).toBe("commit (cherry-pick): feature change");

    const decision = decideCommitEventForCall(tracker, "call-1", cwd);

    expect(decision).toBeDefined();
    const shortSha = git("rev-parse --short HEAD", cwd);
    expect(decision!.preview).toBe(`${shortSha} feature change`);
    expect(decision!.lastToolCall).toBe(`commit: ${shortSha} feature change`);
  });

  it("reports a repository created and committed inside one bash call", () => {
    const cwd = createTempCrewDirs().cwd;

    // A file exists, but the directory is not a repository yet: the probe must say so
    fs.writeFileSync(path.join(cwd, "README.md"), "# fresh\n");
    expect(readHeadState(cwd)).toBeUndefined();
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    run('git init -q -b main --template= && git add . && git commit -qm "init: fresh repo"', cwd);

    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));

    const shortSha = git("rev-parse --short HEAD", cwd);
    const events = commitEvents(cwd);
    expect(events).toHaveLength(1);
    expect(events[0].preview).toBe(`${shortSha} init: fresh repo`);
  });

  it("writes no commit event when a call that started outside a repository only ran git init", () => {
    const cwd = createTempCrewDirs().cwd;
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    git("init -q -b main --template=", cwd);

    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));

    expect(commitEvents(cwd)).toHaveLength(0);
  });

  it("writes no commit event for a call that started and stayed outside a repository", () => {
    const cwd = createTempCrewDirs().cwd;
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    run("echo 'git commit -m nothing'", cwd);

    logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));

    expect(commitEvents(cwd)).toHaveLength(0);
  });
});

describe("git probe bounds", () => {
  it("pays one HEAD probe at tool_call in a repository with commits", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();

    const probes = recordProbes(() => rememberHeadBeforeCall(tracker, "call-1", cwd));

    expect(probes).toEqual(["head"]);
  });

  it("pays the work-tree fallback at tool_call outside a repository", () => {
    const cwd = createTempCrewDirs().cwd;
    const tracker = new CommitHeadTracker();

    const probes = recordProbes(() => rememberHeadBeforeCall(tracker, "call-1", cwd));

    expect(probes).toEqual(["head", "work-tree"]);
    expect(tracker.take("call-1")).toBe(NOT_A_REPOSITORY);
  });

  it("pays the work-tree fallback at tool_call in an unborn repository", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main --template=", cwd);
    const tracker = new CommitHeadTracker();

    const probes = recordProbes(() => rememberHeadBeforeCall(tracker, "call-1", cwd));

    expect(probes).toEqual(["head", "work-tree"]);
    expect(tracker.take("call-1")).toEqual(UNBORN_HEAD);
  });

  it("pays two probes at tool_result for a landed commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);
    commitFile(cwd, "feature.txt", "shipped\n", "feat: add feature.txt");

    let decision: { preview: string } | undefined;
    const probes = recordProbes(() => {
      decision = decideCommitEventForCall(tracker, "call-1", cwd);
    });

    expect(probes).toEqual(["head", "reflog"]);
    expect(decision).toBeDefined();
  });

  it("pays no reflog probe at tool_result when HEAD did not move", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    let decision: { preview: string } | undefined;
    const probes = recordProbes(() => {
      decision = decideCommitEventForCall(tracker, "call-1", cwd);
    });

    // One probe: the reflog cannot add anything to an unchanged HEAD
    expect(probes).toEqual(["head"]);
    expect(decision).toBeUndefined();
  });

  it("pays at most the work-tree fallback at tool_result when the HEAD read fails", () => {
    const cwd = createTempCrewDirs().cwd;
    const tracker = new CommitHeadTracker();
    rememberHeadBeforeCall(tracker, "call-1", cwd);

    let decision: { preview: string } | undefined;
    const probes = recordProbes(() => {
      decision = decideCommitEventForCall(tracker, "call-1", cwd);
    });

    // HEAD + the fallback that tells "unborn" from "not a repository"; no reflog probe
    expect(probes).toEqual(["head", "work-tree"]);
    expect(decision).toBeUndefined();
  });

  it("pays three probes across a commit-looking call: one before, two after", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const tracker = new CommitHeadTracker();

    // tool_call, then tool_result, exactly as the hook runs them
    const before = recordProbes(() => rememberHeadBeforeCall(tracker, "call-1", cwd));
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    run('git commit -qm "feat: add feature.txt"', cwd);
    const after = recordProbes(() => {
      logIfDecided(cwd, decideCommitEventForCall(tracker, "call-1", cwd));
    });

    expect(before).toEqual(["head"]);
    expect(after).toEqual(["head", "reflog"]);
  });
});

describe("commit event backward compatibility", () => {
  it("renders a commit line with the new preview", () => {
    const event: FeedEvent = {
      ts: new Date().toISOString(),
      agent: "AgentOne",
      type: "commit",
      preview: "abc1234 feat: add feature.txt",
    };

    expect(formatFeedLine(event)).toContain('committed "abc1234 feat: add feature.txt"');
  });

  it("keeps the existing event shape when read back", () => {
    const cwd = createTempCrewDirs().cwd;

    logFeedEvent(cwd, "AgentOne", "commit", undefined, "abc1234 feat: add feature.txt");

    const [event] = readFeedEvents(cwd, 20);
    expect(event.type).toBe("commit");
    expect(event.agent).toBe("AgentOne");
    expect(event.target).toBeUndefined();
    expect(event.preview).toBe("abc1234 feat: add feature.txt");
  });
});
