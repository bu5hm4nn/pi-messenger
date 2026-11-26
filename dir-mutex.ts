/**
 * Cross-process directory mutex.
 *
 * A held guard is a directory that contains exactly one marker file named
 * `<hostname>-<pid>-<uuid>`. Acquisition stages a private sibling directory
 * with that marker in it and renames the stage onto the guard path. Directory
 * rename is atomic, so exactly one contender installs its marker; everyone
 * else observes the guard as occupied.
 *
 * Occupied means EEXIST / ENOTEMPTY on POSIX. On Windows `MoveFileEx` cannot
 * replace an existing directory and reports EPERM / EACCES (and EBUSY while a
 * delete is still pending), so those are retried as transient contention.
 *
 * Release unlinks only the caller's own marker and then removes the guard
 * directory if (and only if) it is empty. A guard with a successor marker is
 * left alone: the successor owns it now.
 *
 * Reclaim requires *verified death*: the guard must contain exactly one
 * marker, it must belong to this host, parse as a canonical pid, and
 * `process.kill(pid, 0)` must fail with ESRCH. Every other outcome (EPERM,
 * unknown host, unparseable/malformed marker, zero or multiple markers) means
 * ALIVE. There is no age-based stealing: a paused-but-alive holder must never
 * lose the lock, because that would allow overlapping read-modify-write.
 *
 * Shared boards across PID namespaces (containers) are explicitly unsupported,
 * alongside network shares: host/pid identity from another namespace cannot
 * prove liveness here, so such markers are always treated as ALIVE.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface DirMutexHandle {
  guardPath: string;
  markerName: string;
}

export interface DirMutexOptions {
  timeoutMs?: number;
  retryMs?: number;
}

export const DIR_MUTEX_DEFAULT_TIMEOUT_MS = 5000;
export const DIR_MUTEX_DEFAULT_RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// =============================================================================
// Holder liveness
// =============================================================================

export type DirMutexLiveness = "alive" | "dead" | "unknown";
export type DirMutexLivenessProbe = (pid: number) => DirMutexLiveness;

function defaultLivenessProbe(pid: number): DirMutexLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    // ESRCH is the only outcome that proves the process is gone. EPERM means
    // it exists but belongs to someone else; anything else is unverifiable.
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

let livenessProbe: DirMutexLivenessProbe = defaultLivenessProbe;

/** Any throw (e.g. an injected EPERM probe) is unverifiable, never death. */
function probeLiveness(pid: number): DirMutexLiveness {
  try {
    return livenessProbe(pid);
  } catch {
    return "unknown";
  }
}

/**
 * Test seam for liveness probing. Passing null restores the real probe; the
 * production path never installs an override.
 */
export function setDirMutexLivenessProbe(probe: DirMutexLivenessProbe | null): void {
  livenessProbe = probe ?? defaultLivenessProbe;
}

// =============================================================================
// Marker inspection
// =============================================================================

export interface ParsedMarker {
  host: string;
  pid: number;
}

/**
 * Parse the exact `<hostname>-<pid>-<uuid>` format. Hostnames may contain
 * dashes, so the fixed-width uuid anchors the split and the pid is the
 * canonical decimal segment immediately before it. Anything else is
 * unparseable and must be treated as ALIVE by reclaim.
 */
export function parseMarkerName(name: string): ParsedMarker | null {
  if (name.length < 36 + 3) return null;
  const uuid = name.slice(-36);
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) return null;
  // The character immediately before the fixed-width uuid must be the '-'
  // separator. Without this check `host-123x<uuid>` would parse as host
  // "host-123", treating a malformed marker as canonical.
  if (name.slice(-(36 + 1), -36) !== "-") return null;
  const rest = name.slice(0, -(36 + 1));
  const dash = rest.lastIndexOf("-");
  if (dash <= 0) return null;
  const pidText = rest.slice(dash + 1);
  // Canonical positive decimal pid: no sign, spaces, leading zeroes or "1e3".
  if (!/^[1-9][0-9]*$/.test(pidText)) return null;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { host: rest.slice(0, dash), pid };
}

interface GuardState {
  exists: boolean;
  markers: string[];
}

function readGuardState(guardPath: string): GuardState {
  try {
    return { exists: true, markers: fs.readdirSync(guardPath) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { exists: code !== "ENOENT", markers: [] };
  }
}

export function dirMutexHeld(guardPath: string): boolean {
  const state = readGuardState(guardPath);
  return state.exists;
}

function observedMarkers(guardPath: string): string[] {
  return readGuardState(guardPath).markers;
}

// =============================================================================
// Reclaim / cleanup
// =============================================================================

function removeEmptyGuard(guardPath: string): boolean {
  try {
    fs.rmdirSync(guardPath);
    return true;
  } catch {
    // ENOTEMPTY: a successor installed its marker; ENOENT: already gone.
    return false;
  }
}

/**
 * Reclaim a guard only when its marker is verified dead on this host.
 *
 * Returns true when this call removed the dead marker (and the then-empty
 * guard directory). Returns false when the guard is alive-looking, when
 * another reclaimer won the unlink (ENOENT), or when a successor installed
 * itself before the empty-directory removal (ENOTEMPTY). Callers treat false
 * as "go back to acquiring".
 */
export function tryReclaimDirMutex(guardPath: string): boolean {
  const state = readGuardState(guardPath);
  if (!state.exists) return false;
  if (state.markers.length === 0) {
    // A crash between marker unlink and rmdir leaves an empty guard; anyone
    // may remove it.
    return removeEmptyGuard(guardPath);
  }
  // Death-based reclaim is only safe for the single-marker invariant. A
  // malformed or multi-marker guard could hide a live holder, so it is ALIVE.
  if (state.markers.length !== 1) return false;

  const marker = state.markers[0];
  const host = os.hostname();
  const parsed = parseMarkerName(marker);
  if (!parsed) return false;
  if (parsed.host !== host) return false;
  if (probeLiveness(parsed.pid) !== "dead") return false;
  try {
    fs.unlinkSync(path.join(guardPath, marker));
  } catch {
    // ENOENT: another reclaimer already removed the marker. Any other error
    // means we could not prove ownership; leave the guard alone either way.
    return false;
  }

  return removeEmptyGuard(guardPath);
}

// =============================================================================
// Acquire / release
// =============================================================================

function stageAndRename(guardPath: string, markerName: string): void {
  const dir = path.dirname(guardPath);
  fs.mkdirSync(dir, { recursive: true });
  const stagePath = path.join(dir, `.stage-${randomUUID()}`);
  fs.mkdirSync(stagePath);
  try {
    fs.writeFileSync(
      path.join(stagePath, markerName),
      JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }),
      { flag: "wx" },
    );
    fs.renameSync(stagePath, guardPath);
  } finally {
    // A successful rename moved the stage away; a failed one leaves our
    // private directory behind and nobody else owns it.
    if (fs.existsSync(stagePath)) {
      try { fs.rmSync(stagePath, { recursive: true, force: true }); } catch {}
    }
  }
}

export class DirMutexTimeoutError extends Error {
  readonly guardPath: string;
  readonly observedMarkers: string[];
  readonly holderPid: number | null;

  constructor(guardPath: string, observed: string[], lastCode?: string) {
    const marker = observed[0];
    const pid = marker ? parseMarkerName(marker)?.pid ?? null : null;
    const holder = observed.length > 0 ? observed.join(", ") : "an unreadable guard directory";
    super(
      `Timed out waiting for filesystem guard ${guardPath} (held by ${holder}${pid ? `, pid ${pid}` : ""}${lastCode ? `, last error ${lastCode}` : ""}). ` +
      `Stop all crew writers for this project, then remove the named marker file and the (now empty) guard directory, then retry.`,
    );
    this.name = "DirMutexTimeoutError";
    this.guardPath = guardPath;
    this.observedMarkers = observed;
    this.holderPid = pid;
  }
}

function isRetryableContention(code: string | undefined): boolean {
  if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES") return true;
  // Windows reports a delete-pending directory as EBUSY; it clears on its own.
  // Implemented for Windows, but not validated on this Linux host.
  return process.platform === "win32" && (code === "EBUSY" || code === "EACCES");
}

/**
 * Acquire the guard, retrying contested acquisitions up to the deadline.
 * Reclaim happens only for verified-dead markers; a live-looking holder is
 * waited out. On timeout this throws DirMutexTimeoutError with the guard path,
 * observed marker and holder pid.
 */
export function acquireDirMutex(guardPath: string, options: DirMutexOptions = {}): DirMutexHandle {
  const timeoutMs = options.timeoutMs ?? DIR_MUTEX_DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DIR_MUTEX_DEFAULT_RETRY_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let observed: string[] = [];
  let lastCode: string | undefined;

  for (;;) {
    const markerName = `${os.hostname()}-${process.pid}-${randomUUID()}`;
    try {
      stageAndRename(guardPath, markerName);
      return { guardPath, markerName };
    } catch (err) {
      lastCode = (err as NodeJS.ErrnoException).code;
      observed = observedMarkers(guardPath);
      // Any failure is retried to the deadline. Contention additionally gets
      // a verified-death reclaim attempt; other errors are never force-fixed.
      if (isRetryableContention(lastCode)) {
        tryReclaimDirMutex(guardPath);
      }
      if (Date.now() >= deadline) {
        throw new DirMutexTimeoutError(guardPath, observed, lastCode);
      }
      sleepSync(retryMs);
    }
  }
}

/**
 * Single-shot acquisition used where waiting is worse than skipping
 * (deletePlan's per-task sweep). No retry and no waiting for a live holder.
 */
export function tryAcquireDirMutex(guardPath: string): DirMutexHandle | null {
  if (dirMutexHeld(guardPath)) {
    tryReclaimDirMutex(guardPath);
  }
  const markerName = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  try {
    stageAndRename(guardPath, markerName);
    return { guardPath, markerName };
  } catch {
    return null;
  }
}

/**
 * Release our marker and the now-empty guard. Unlinking a marker that a
 * reclaimer already removed is a no-op: touching anything else could destroy
 * a successor's guard.
 */
export function releaseDirMutex(handle: DirMutexHandle): void {
  try {
    fs.unlinkSync(path.join(handle.guardPath, handle.markerName));
  } catch {
    return;
  }
  try {
    fs.rmdirSync(handle.guardPath);
  } catch {
    // ENOTEMPTY: a successor installed its marker; leave it.
  }
}
