// Named windows (--target) shared by every command: the state directory, per-name locks, pid files, replace requests,
// acks, starting the window process, --close, --list and cleaning up old files.
//
// The launcher starts the window as a child process in its own session (detached) and exits after the page
// acknowledges that it loaded what it was given (ack). Bun's event loop does not run during webview.run(), so the
// window process cannot push anything to the page; the page polls a bound function to pick up replace requests.
//
// Each command keeps its own state directory (/tmp/<command>-<uid>/), so commands never see each other's windows.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "./lang.ts";

export const READY_TIMEOUT_MS = 20_000;
export const ACK_POLL_MS = 100;
// Long enough to wait for a previous launch to finish waiting for its ack (up to READY_TIMEOUT_MS)
export const LOCK_WAIT_MS = READY_TIMEOUT_MS + 5_000;
// Requests settle within READY_TIMEOUT_MS. Files left several times longer will never be read (a crashed window etc.)
export const STALE_FILE_MS = READY_TIMEOUT_MS * 5;
export const TARGET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export type ReplaceRequest = { requestId: string; url: string; pid: number };

export type WindowHostOptions = {
  // Command name. Used for the state directory and messages
  name: string;
  // The command's entry file. The window process is started as `<scriptPath> --window <config>`, and a pid is only
  // trusted while its process still runs that file for that target
  scriptPath: string;
  htmlPath: string;
  // Extra directories under the state directory (textboard's outbox)
  extraDirs?: string[];
  // Defaults to /tmp/<name>-<uid>. Changed by the tests only
  stateDir?: string;
};

export type WindowHost = ReturnType<typeof createWindowHost>;

export function createWindowHost(options: WindowHostOptions) {
  if (process.getuid === undefined) throw new Error(`${options.name} supports POSIX environments only`);
  const userId = process.getuid();
  // TMPDIR can differ between agent environments, so use a fixed place shared by every process of the same user.
  // Other users can write to /tmp, so use a 0700 directory named with the uid and check its owner
  const stateDir = options.stateDir ?? `/tmp/${options.name}-${userId}`;
  const targetsDir = join(stateDir, "targets");
  const acksDir = join(stateDir, "acks");
  const logsDir = join(stateDir, "logs");
  const boardsDir = join(stateDir, "boards");
  const extraDirs = (options.extraDirs ?? []).map((dir) => join(stateDir, dir));

  const pidPath = (target: string) => join(targetsDir, `${target}.pid`);
  const requestPath = (target: string) => join(targetsDir, `${target}.request.json`);
  const lockPath = (target: string) => join(targetsDir, `${target}.lock`);
  const ackPath = (requestId: string) => join(acksDir, `${requestId}.json`);
  const boardPath = (requestId: string) => join(boardsDir, `${requestId}.json`);

  // Using a directory or symlink created first by another user would let them plant request files or redirect writes
  function ensureStateDir(onBad: (dir: string) => never): void {
    try {
      mkdirSync(stateDir, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    const stat = lstatSync(stateDir);
    const isOwnPrivateDir = stat.isDirectory() && stat.uid === userId && (stat.mode & 0o077) === 0;
    if (!isOwnPrivateDir) onBad(stateDir);
    for (const dir of [targetsDir, acksDir, logsDir, boardsDir, ...extraDirs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Take the lock by the atomicity of mkdir. A lock left by a killed owner is taken over once it is older than the wait
  async function acquireTargetLock(target: string): Promise<boolean> {
    const path = lockPath(target);
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        mkdirSync(path);
        return true;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        let lockedAt: number;
        try {
          lockedAt = statSync(path).mtimeMs;
        } catch (statError) {
          // The holder released it between our mkdir and stat: try again right away
          if (isErrorCode(statError, "ENOENT")) continue;
          throw statError;
        }
        if (Date.now() - lockedAt > LOCK_WAIT_MS) rmSync(path, { recursive: true, force: true });
        await Bun.sleep(ACK_POLL_MS);
      }
    }
    return false;
  }

  function releaseTargetLock(target: string): void {
    rmSync(lockPath(target), { recursive: true, force: true });
  }

  // Clean up old files left unread in boards/ and acks/. Their readers normally delete them, but when the launcher
  // times out it leaves a board alone if the window may already be loading it, so a dead window's files stay behind
  function sweepStaleFiles(): void {
    const deadline = Date.now() - STALE_FILE_MS;
    for (const dir of [boardsDir, acksDir]) {
      for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        try {
          if (statSync(path).mtimeMs < deadline) rmSync(path, { force: true });
        } catch (error) {
          // The file's own reader took it while we were sweeping
          if (!isErrorCode(error, "ENOENT")) throw error;
        }
      }
    }
  }

  function readPid(target: string): number | null {
    const path = pidPath(target);
    if (!existsSync(path)) return null;
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  // Check that the process in the pid file is still this command's window for that name. Delete stale pid files
  function findWindowPid(target: string): number | null {
    const pid = readPid(target);
    if (pid === null) return null;
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    const args = ps.stdout.trim();
    // A pid may have been reused by a window of another name, so match the target in its arguments too
    const isThisTarget = args.includes(options.scriptPath) && args.includes("--window") && args.includes(`"target":"${target}"`);
    if (ps.status === 0 && isThisTarget) return pid;
    rmSync(pidPath(target), { force: true });
    return null;
  }

  function closeTarget(target: string, notOpen: (target: string) => string): number {
    const pid = findWindowPid(target);
    if (pid === null) {
      console.error(notOpen(target));
      return 1;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      // The window was closed between the check and the kill. It is closed either way, so this counts as success
      if (!isErrorCode(error, "ESRCH")) throw error;
    }
    rmSync(pidPath(target), { force: true });
    console.log(`closed target=${target} pid=${pid}`);
    return 0;
  }

  function listTargets(): void {
    for (const file of readdirSync(targetsDir)) {
      if (!file.endsWith(".pid")) continue;
      const target = file.slice(0, -".pid".length);
      const pid = findWindowPid(target);
      if (pid !== null) console.log(`${target}\tpid=${pid}`);
    }
  }

  function writeBoard(requestId: string, board: unknown): void {
    writeFileSync(boardPath(requestId), JSON.stringify(board));
  }

  // Read the board of a request and delete it right away, so boards/ does not fill up
  function takeBoard<B>(requestId: string): B {
    const path = boardPath(requestId);
    const board = JSON.parse(readFileSync(path, "utf8")) as B;
    rmSync(path, { force: true });
    return board;
  }

  // The destination pid is included so that a window opened later under the same name does not pick up an old request
  function writeReplaceRequest(target: string, request: ReplaceRequest): void {
    writeFileSync(requestPath(target), JSON.stringify(request));
  }

  // Called by the window process when the page polls. Returns the URL to switch to, if a request is addressed to it
  function takeReplaceRequest(target: string): string | null {
    const path = requestPath(target);
    if (!existsSync(path)) return null;
    const request = JSON.parse(readFileSync(path, "utf8")) as ReplaceRequest;
    rmSync(path);
    return request.pid === process.pid ? request.url : null;
  }

  function spawnWindow(params: { requestId: string; config: { target: string | null } & Record<string, unknown> }) {
    const logPath = join(logsDir, `${params.requestId}.log`);
    const logFd = openSync(logPath, "a");
    const child = spawn(process.execPath, [options.scriptPath, "--window", JSON.stringify(params.config)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return { child, logPath };
  }

  async function waitForAck<A>(params: { requestId: string; child: ChildProcess | null }): Promise<A | null> {
    const path = ackPath(params.requestId);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        const ack = JSON.parse(readFileSync(path, "utf8")) as A;
        rmSync(path);
        return ack;
      }
      if (params.child !== null && params.child.exitCode !== null) return null;
      await Bun.sleep(ACK_POLL_MS);
    }
    return null;
  }

  function writeAck(requestId: string, ack: unknown): void {
    writeFileSync(ackPath(requestId), JSON.stringify(ack));
  }

  // After the ack timed out, clean up only what the window has not taken yet. A replace request is deleted by the
  // window the moment its poll reads it, so if the request file still exists nobody will read the request or the
  // board. If it is gone, the window may be loading the board right now; deleting it would make a load that is just a
  // little late fail and leave the window empty with no ack. Leave it to the window's own load and to the next
  // sweepStaleFiles. A new window has no request file, so its board is always deleted
  function discardUnreceived(params: { target: string | null; requestId: string; replaced: boolean }): void {
    if (params.target === null) {
      rmSync(boardPath(params.requestId), { force: true });
      return;
    }
    if (!params.replaced || existsSync(requestPath(params.target))) {
      rmSync(requestPath(params.target), { force: true });
      rmSync(boardPath(params.requestId), { force: true });
    }
  }

  // Start of the window process: record the pid and drop a request that was written for the previous window and never taken
  function registerWindow(target: string | null): void {
    if (target === null) return;
    writeFileSync(pidPath(target), String(process.pid));
    rmSync(requestPath(target), { force: true });
  }

  // End of the window process. If the first board was never read (closed before it showed), delete it.
  // Boards loaded later by replacing were deleted by their own load
  function cleanupWindow(params: { target: string | null; requestId: string }): void {
    rmSync(boardPath(params.requestId), { force: true });
    if (params.target !== null && readPid(params.target) === process.pid) rmSync(pidPath(params.target));
  }

  // Only the request id goes into the URL; the page reads the rest through a bound function
  function buildUrl(requestId: string, lang: Lang): string {
    return "file://" + options.htmlPath.split("/").map(encodeURIComponent).join("/") + "?rid=" + requestId + "&lang=" + lang;
  }

  return {
    stateDir,
    targetsDir,
    acksDir,
    logsDir,
    boardsDir,
    pidPath,
    requestPath,
    lockPath,
    ackPath,
    boardPath,
    ensureStateDir,
    acquireTargetLock,
    releaseTargetLock,
    sweepStaleFiles,
    readPid,
    findWindowPid,
    closeTarget,
    listTargets,
    writeBoard,
    takeBoard,
    writeReplaceRequest,
    takeReplaceRequest,
    spawnWindow,
    waitForAck,
    writeAck,
    discardUnreceived,
    registerWindow,
    cleanupWindow,
    buildUrl,
  };
}

export function isValidTargetName(name: string | undefined): name is string {
  return name !== undefined && TARGET_NAME_PATTERN.test(name);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
