import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatFeedLine, logFeedEvent, readFeedEvents, type FeedEvent } from "../feed.ts";
import {
  decideCommitEvent,
  isGitCommitCommand,
  readHeadState,
  UNBORN_HEAD,
  type HeadState,
} from "../git-commit.ts";
import { createTempCrewDirs } from "./helpers/temp-dirs.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", env: GIT_ENV }).trim();
}

function initRepo(cwd: string): string {
  git("init -q -b main", cwd);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  git("add .", cwd);
  git("commit -qm init", cwd);
  return git("rev-parse HEAD", cwd);
}

function head(sha: string, shortSha: string, subject: string): HeadState {
  return { sha, shortSha, subject };
}

describe("isGitCommitCommand", () => {
  it("keeps the previous regex semantics", () => {
    expect(isGitCommitCommand("git commit -m \"x\"")).toBe(true);
    expect(isGitCommitCommand("cd repo && git  commit --amend")).toBe(true);
    expect(isGitCommitCommand("echo 'git commit -m not-a-commit'")).toBe(true);
    expect(isGitCommitCommand("git status")).toBe(false);
    // Word boundary: "legit commit" is not a `git commit` command
    expect(isGitCommitCommand("legit commit")).toBe(false);
  });
});

describe("decideCommitEvent", () => {
  it("returns undefined when HEAD did not move", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("a".repeat(40), "aaaaaaa", "init");

    expect(decideCommitEvent({ headBefore: before, headAfter: after })).toBeUndefined();
  });

  it("returns undefined when the head before is missing", () => {
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship it");

    expect(decideCommitEvent({ headBefore: undefined, headAfter: after })).toBeUndefined();
  });

  it("returns undefined when the head after is missing", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");

    expect(decideCommitEvent({ headBefore: before, headAfter: undefined })).toBeUndefined();
  });

  it("names the new short SHA and subject when HEAD moved", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "bbbbbbb", "feat: ship the feed fix");

    const decision = decideCommitEvent({ headBefore: before, headAfter: after });

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe("bbbbbbb feat: ship the feed fix");
    expect(decision!.lastToolCall).toBe("commit: bbbbbbb feat: ship the feed fix");
  });

  it("names the first commit of a repository whose HEAD was unborn", () => {
    const after = head("b".repeat(40), "bbbbbbb", "init: first commit");

    const decision = decideCommitEvent({ headBefore: UNBORN_HEAD, headAfter: after });

    // "" -> real SHA is the initial commit, so the event is deserved
    expect(decision).toBeDefined();
    expect(decision!.preview).toBe("bbbbbbb init: first commit");
    expect(decision!.lastToolCall).toBe("commit: bbbbbbb init: first commit");
  });

  it("returns undefined when HEAD is still unborn after the attempt", () => {
    // "" -> "": the first commit failed, so nothing landed
    expect(decideCommitEvent({ headBefore: UNBORN_HEAD, headAfter: UNBORN_HEAD })).toBeUndefined();
  });

  it("returns undefined when the state before is unreadable even though HEAD is unborn after", () => {
    // An unreadable headBefore is not the same claim as an unborn one: stay silent
    expect(decideCommitEvent({ headBefore: undefined, headAfter: UNBORN_HEAD })).toBeUndefined();
  });

  it("never renders a stray leading space when the short SHA is empty", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const after = head("b".repeat(40), "", "feat: subject only");

    const decision = decideCommitEvent({ headBefore: before, headAfter: after });

    expect(decision!.preview).toBe("feat: subject only");
    expect(decision!.lastToolCall).toBe("commit: feat: subject only");
  });

  it("trims the subject and tolerates an empty one", () => {
    const before = head("a".repeat(40), "aaaaaaa", "init");
    const padded = head("b".repeat(40), "bbbbbbb", "  spaced subject  ");
    const empty = head("c".repeat(40), "ccccccc", "");

    expect(decideCommitEvent({ headBefore: before, headAfter: padded })!.preview).toBe("bbbbbbb spaced subject");
    expect(decideCommitEvent({ headBefore: before, headAfter: empty })!.preview).toBe("ccccccc");
    expect(decideCommitEvent({ headBefore: before, headAfter: empty })!.lastToolCall).toBe("commit: ccccccc");
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
    git("init -q -b main", cwd);

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

describe("commit feed event from a real repository", () => {
  it("reports the first commit of a brand new repository", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main", cwd);
    fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
    git("add .", cwd);

    // HEAD is unborn before the first commit, which is a state, not a failed read
    const headBefore = readHeadState(cwd);
    expect(headBefore).toEqual(UNBORN_HEAD);

    git('commit -qm "init: first commit"', cwd);

    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision).toBeDefined();
    const shortSha = git("rev-parse --short HEAD", cwd);
    expect(decision!.preview).toBe(`${shortSha} init: first commit`);
    expect(decision!.lastToolCall).toBe(`commit: ${shortSha} init: first commit`);
  });

  it("reports nothing when the first commit of a fresh repository fails", () => {
    const cwd = createTempCrewDirs().cwd;
    git("init -q -b main", cwd);
    const headBefore = readHeadState(cwd);
    expect(headBefore).toEqual(UNBORN_HEAD);

    // Nothing staged: git exits non-zero and HEAD stays unborn
    expect(() => git('commit -m "x"', cwd)).toThrow();

    const headAfter = readHeadState(cwd);
    expect(headAfter).toEqual(UNBORN_HEAD);
    expect(decideCommitEvent({ headBefore, headAfter })).toBeUndefined();
  });

  it("reports a real commit with its short SHA and message", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const headBefore = readHeadState(cwd);

    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    git('commit -qm "feat: add feature.txt"', cwd);

    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision).toBeDefined();
    const shortSha = git("rev-parse --short HEAD", cwd);
    expect(decision!.preview).toBe(`${shortSha} feat: add feature.txt`);
    expect(decision!.lastToolCall).toBe(`commit: ${shortSha} feat: add feature.txt`);
  });

  it("reports nothing for a failed commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const headBefore = readHeadState(cwd);

    expect(() => git('commit -m "nothing staged"', cwd)).toThrow();

    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision).toBeUndefined();
    expect(git("rev-parse HEAD", cwd)).toBe(headBefore!.sha);
  });

  it("reports nothing for a no-op commit attempt", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    git('commit -qm "feat: add feature.txt"', cwd);
    const headBefore = readHeadState(cwd);

    // Nothing staged and nothing changed: git exits non-zero and HEAD stays put
    let failed = false;
    try {
      git('commit -m "again"', cwd);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    expect(decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) })).toBeUndefined();
  });

  it("takes the message from git, not from the command text", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const headBefore = readHeadState(cwd);

    fs.writeFileSync(path.join(cwd, "msg.txt"), "subject from file\n\nbody ignored by the subject line\n");
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);
    git("commit -q -F msg.txt", cwd);

    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision!.preview).toBe(`${git("rev-parse --short HEAD", cwd)} subject from file`);
  });

  it("still reports the commit when a compound command fails afterwards", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const headBefore = readHeadState(cwd);
    fs.writeFileSync(path.join(cwd, "feature.txt"), "shipped\n");
    git("add .", cwd);

    let isError = false;
    try {
      execSync('git commit -qm "feat: add feature.txt" && exit 1', {
        cwd,
        encoding: "utf-8",
        env: GIT_ENV,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      isError = true;
    }
    expect(isError).toBe(true);

    // The commit landed even though the tool result is an error: the event is deserved,
    // so the decision must not consult event.isError.
    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision).toBeDefined();
    expect(decision!.preview).toBe(`${git("rev-parse --short HEAD", cwd)} feat: add feature.txt`);
  });

  it("writes no commit event for a command that only mentions git commit", () => {
    const cwd = createTempCrewDirs().cwd;
    initRepo(cwd);
    const command = "echo 'git commit -m not-a-commit'";

    expect(isGitCommitCommand(command)).toBe(true);
    const headBefore = readHeadState(cwd);
    execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const decision = decideCommitEvent({ headBefore, headAfter: readHeadState(cwd) });

    expect(decision).toBeUndefined();

    // Mirror the hook: only a decision writes a feed event
    if (decision) logFeedEvent(cwd, "AgentOne", "commit", undefined, decision.preview);
    expect(readFeedEvents(cwd, 20).filter(e => e.type === "commit")).toHaveLength(0);
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
