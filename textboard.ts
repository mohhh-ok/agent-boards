#!/usr/bin/env bun
// Launcher that opens textboard.html in a webview-bun window. No server or browser needed.
// Its structure follows the launcher of moodboard (github.com/mohhh-ok/moodboard).
//
// Usage:
//   textboard --target <name> <file>                  Open. If a window with that name exists, switch it to the file
//   textboard wait --target <name> [--timeout <sec>]  Wait until the window sends an instruction to the AI; print it as JSON on stdout
//   textboard --close <name>                          Close only the window with that name
//   textboard --list                                  List the open named windows
// Every form may start with --lang ja|en (display language; see "Language" in the README)
//
// The launcher starts the window as a child process in its own session (detached) and exits after the page
// acknowledges that it loaded the file (ack). Exit codes:
//   0 = shown / 1 = bad arguments or path / 2 = not shown in time / 3 = the window has unsaved edits, so it was not switched
//
// Instructions from the window to the agent: the page writes JSON to outbox/<name>/ through the bound function
// __textboardSend, and `textboard wait` takes and deletes it. Instructions sent while no wait is running are kept
// and taken by the next wait.
//
// Bun's event loop does not run during webview.run(), so the window process cannot push anything to the page.
// The page calls __textboardPoll periodically to receive replace requests, outside changes to the file and whether a wait is running.
import { Webview, SizeHint } from "webview-bun";
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { installEditMenu } from "./editMenu.ts";

if (process.getuid === undefined) throw new Error("textboard supports POSIX environments only");
const USER_ID = process.getuid();
// TMPDIR can differ between agent environments, so use a fixed place shared by every process of the same user.
// Other users can write to /tmp, so use a 0700 directory named with the uid and check its owner
const STATE_DIR = `/tmp/textboard-${USER_ID}`;
const TARGETS_DIR = join(STATE_DIR, "targets");
const ACKS_DIR = join(STATE_DIR, "acks");
const LOGS_DIR = join(STATE_DIR, "logs");
const BOARDS_DIR = join(STATE_DIR, "boards");
const OUTBOX_DIR = join(STATE_DIR, "outbox");
const READY_TIMEOUT_MS = 20_000;
const ACK_POLL_MS = 100;
const WAIT_POLL_MS = 300;
const LOCK_WAIT_MS = READY_TIMEOUT_MS + 5_000;
const STALE_FILE_MS = READY_TIMEOUT_MS * 5;
const TARGET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// Larger files are not treated as text (the size assumes editing in a textarea)
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Where comments are stored. Kept here rather than next to the document, so no extra files appear in the user's repository.
// The file name is the sha256 of the document's absolute path (the JSON also holds the path). Moving or renaming the
// document detaches its comments. TEXTBOARD_HOME changes the location (for verification)
const COMMENTS_DIR = join(process.env.TEXTBOARD_HOME || join(homedir(), ".textboard"), "comments");

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "textboard.html");

type WindowConfig = { target: string; url: string; requestId: string; lang: Lang };
type Ack = { pid: number; refused?: "unsaved" };
// What to show for one request. Written to boards/<rid>.json; the page reads it with __textboardLoad(rid)
type Board = { path: string };

// ---------------- Display language ----------------
// Chosen the same way as moodboard: --lang > TEXTBOARD_LANG > the macOS language setting. Anything but ja is en.
// $LANG is not used (agents and terminals often set en_US.UTF-8 even when macOS is in Japanese).
// The `opened ...` line on success and the JSON from wait are for scripts, so they are not translated
type Lang = "ja" | "en";
const MESSAGES = {
  ja: {
    usage:
      "usage: textboard [--lang ja|en] --target <名前> <ファイル>\n       textboard [--lang ja|en] wait --target <名前> [--timeout <秒>]\n       textboard [--lang ja|en] --close <名前>\n       textboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} は ja か en で指定してください: ${value}`,
    badTargetName: "--target の名前は英数字と . _ - だけで指定してください",
    oneFile: "開くファイルを 1 つだけ指定してください",
    notFound: (path: string) => `ファイルが見つかりません: ${path}`,
    notFile: (path: string) => `通常のファイルではありません: ${path}`,
    tooLarge: (path: string) => `ファイルが大きすぎます(5MB まで): ${path}`,
    notText: (path: string) => `テキストファイルではないようです(NUL を含む): ${path}`,
    badTimeout: "--timeout は正の秒数で指定してください",
    lockFailed: (target: string, path: string) => `target=${target} のロックを取れませんでした (${path})`,
    notShown: (target: string, replaced: boolean) => `表示を確認できませんでした (target=${target}, ${replaced ? "差し替え" : "新規"})`,
    refusedUnsaved: (target: string) =>
      `target=${target} の窓に未保存の編集があるため、差し替えませんでした。ユーザーに保存か破棄を頼んでから開き直してください`,
    notOpen: (target: string) => `target=${target} のウィンドウは開いていません`,
    windowClosed: (target: string) => `target=${target} のウィンドウが閉じられました`,
    waitTimeout: (target: string) => `target=${target} から指示が来ないまま --timeout が過ぎました`,
    badStateDir: (dir: string) => `${dir} が自分の所有する権限 700 のディレクトリではありません。中身を確かめて削除してください`,
  },
  en: {
    usage:
      "usage: textboard [--lang ja|en] --target <name> <file>\n       textboard [--lang ja|en] wait --target <name> [--timeout <seconds>]\n       textboard [--lang ja|en] --close <name>\n       textboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} must be ja or en: ${value}`,
    badTargetName: "--target names may use only letters, digits and . _ -",
    oneFile: "Give exactly one file to open",
    notFound: (path: string) => `File not found: ${path}`,
    notFile: (path: string) => `Not a regular file: ${path}`,
    tooLarge: (path: string) => `File is too large (5 MB max): ${path}`,
    notText: (path: string) => `This does not look like a text file (contains NUL): ${path}`,
    badTimeout: "--timeout must be a positive number of seconds",
    lockFailed: (target: string, path: string) => `Could not take the lock for target=${target} (${path})`,
    notShown: (target: string, replaced: boolean) =>
      `Could not confirm that the window showed the file (target=${target}, ${replaced ? "replaced" : "new window"})`,
    refusedUnsaved: (target: string) =>
      `The window target=${target} has unsaved edits, so it was not replaced. Ask the user to save or discard them, then open again`,
    notOpen: (target: string) => `No window is open for target=${target}`,
    windowClosed: (target: string) => `The window target=${target} was closed`,
    waitTimeout: (target: string) => `No instruction came from target=${target} before --timeout`,
    badStateDir: (dir: string) => `${dir} is not a directory owned by you with mode 700. Check its contents and delete it`,
  },
} satisfies Record<Lang, unknown>;

let lang: Lang = "en";
let M = MESSAGES[lang];

function setLang(next: Lang) {
  lang = next;
  M = MESSAGES[next];
}

function parseLang(value: string | undefined, source: string): Lang {
  if (value === "ja" || value === "en") return value;
  usageError(M.badLang(source, value ?? ""));
}

// `defaults read -g AppleLanguages` prints `(\n    "ja-JP",\n    en\n)`. The first one is the preferred language
function systemLang(): Lang {
  const result = spawnSync("defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8" });
  const first = result.status === 0 ? /\(\s*"?([^",\s)]+)/.exec(result.stdout)?.[1] : undefined;
  return first?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

if (import.meta.main) await main(process.argv.slice(2));

async function main(argv: string[]) {
  if (argv[0] === "--window") {
    ensureStateDir();
    runWindow(JSON.parse(argv[1]) as WindowConfig);
    return;
  }

  setLang(systemLang());
  const envLang = process.env.TEXTBOARD_LANG;
  if (argv[0] === "--lang") {
    setLang(parseLang(argv[1], "--lang"));
    argv = argv.slice(2);
  } else if (envLang !== undefined && envLang !== "") {
    setLang(parseLang(envLang, "TEXTBOARD_LANG"));
  }
  ensureStateDir();
  if (argv[0] === "--close") process.exit(closeTarget(requireTargetName(argv[1])));
  if (argv[0] === "--list") {
    listTargets();
    return;
  }
  if (argv[0] === "wait") process.exit(await waitForInstruction(argv.slice(1)));

  sweepStaleFiles();
  if (argv[0] !== "--target") usageError(M.badTargetName);
  const target = requireTargetName(argv[1]);
  const rest = argv.slice(2);
  if (rest.length !== 1) usageError(M.oneFile);
  const path = checkedTextFile(rest[0]);
  process.exit(await openFile(target, path));
}

// ---------------- Checking the file to open ----------------

function checkedTextFile(arg: string): string {
  const path = resolve(arg);
  if (!existsSync(path)) fatal(M.notFound(path));
  const stat = statSync(path);
  if (!stat.isFile()) fatal(M.notFile(path));
  if (stat.size > MAX_FILE_BYTES) fatal(M.tooLarge(path));
  // Treat it as binary if the first 8 KB contain NUL (the same test as git)
  const fd = openSync(path, "r");
  const head = Buffer.alloc(Math.min(8192, stat.size));
  readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  if (head.includes(0)) fatal(M.notText(path));
  return path;
}

// ---------------- Showing the window ----------------

async function openFile(target: string, path: string): Promise<number> {
  // If two launches for the same name overlap, both decide "not open" and two windows open. Serialize with a per-name lock
  const lock = await acquireTargetLock(target);
  if (!lock) {
    console.error(M.lockFailed(target, lockPath(target)));
    return 2;
  }
  try {
    return await showFile(target, path);
  } finally {
    rmSync(lockPath(target), { recursive: true, force: true });
  }
}

async function showFile(target: string, path: string): Promise<number> {
  const requestId = randomUUID();
  writeFileSync(boardPath(requestId), JSON.stringify({ path } satisfies Board));
  const url = buildUrl(requestId);
  const existingPid = findWindowPid(target);

  let child: ReturnType<typeof spawn> | null = null;
  let logPath: string | null = null;
  if (existingPid !== null) {
    // Include the destination pid so that a window opened later under the same name does not pick up an old request
    writeFileSync(requestPath(target), JSON.stringify({ requestId, url, pid: existingPid }));
  } else {
    logPath = join(LOGS_DIR, `${requestId}.log`);
    const logFd = openSync(logPath, "a");
    const config: WindowConfig = { target, url, requestId, lang };
    child = spawn(process.execPath, [scriptPath, "--window", JSON.stringify(config)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  }

  const ack = await waitForAck(requestId, child);
  const action = existingPid !== null ? "replaced" : "new";
  if (ack === null) {
    // If the replace request has not been taken yet, delete it and the board (nobody will read them). If it was taken,
    // the window may be loading it, so leave them to the window's __textboardLoad and the next sweepStaleFiles (as in moodboard)
    if (existingPid === null || existsSync(requestPath(target))) {
      rmSync(requestPath(target), { force: true });
      rmSync(boardPath(requestId), { force: true });
    }
    console.error(M.notShown(target, existingPid !== null) + (logPath ? `\nlog: ${logPath}` : ""));
    return 2;
  }
  if (ack.refused === "unsaved") {
    console.error(M.refusedUnsaved(target));
    return 3;
  }
  console.log(`opened target=${target} pid=${ack.pid} ${action} file=${path}`);
  return 0;
}

async function waitForAck(requestId: string, child: ReturnType<typeof spawn> | null): Promise<Ack | null> {
  const path = ackPath(requestId);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const ack = JSON.parse(readFileSync(path, "utf8")) as Ack;
      rmSync(path);
      return ack;
    }
    if (child !== null && child.exitCode !== null) return null;
    await Bun.sleep(ACK_POLL_MS);
  }
  return null;
}

// ---------------- Window process ----------------

type DiskStamp = { mtimeMs: number; size: number } | null;

function stampOf(path: string): DiskStamp {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameStamp(a: DiskStamp, b: DiskStamp): boolean {
  return a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
}

function runWindow(config: WindowConfig) {
  writeFileSync(pidPath(config.target), String(process.pid));
  rmSync(requestPath(config.target), { force: true });
  mkdirSync(outboxDir(config.target), { recursive: true, mode: 0o700 });

  // The open file and its state on disk when last read or written. Used to detect outside changes
  let currentPath: string | null = null;
  let lastStamp: DiskStamp = null;

  const webview = new Webview();
  webview.title = `textboard — ${config.target}`;
  webview.size = { width: 1180, height: 860, hint: SizeHint.NONE };
  installEditMenu(config.lang);
  // For verification: inject a script that drives the page in the real window (docs/development.md). Not used normally
  const devInit = process.env.TEXTBOARD_DEV_INIT_SCRIPT;
  if (devInit) webview.init(readFileSync(devInit, "utf8"));

  // Bun's event loop is stopped during run(), so callbacks use synchronous I/O only
  webview.bind("__textboardLoad", (rid: string) => {
    const path = boardPath(rid);
    const board = JSON.parse(readFileSync(path, "utf8")) as Board;
    rmSync(path, { force: true });
    currentPath = board.path;
    lastStamp = stampOf(board.path);
    const text = readFileSync(board.path, "utf8");
    const sidecar = commentsPath(board.path);
    let comments: unknown = null;
    if (existsSync(sidecar)) {
      try {
        comments = JSON.parse(readFileSync(sidecar, "utf8"));
      } catch {
        comments = { error: "unreadable" };
      }
    }
    webview.title = `${basename(board.path)} — textboard ${config.target}`;
    return { path: board.path, name: basename(board.path), sidecar, text, comments };
  });

  webview.bind("__textboardReady", (rid: string, result: { refused?: "unsaved" } | null) => {
    const ack: Ack = { pid: process.pid, ...(result?.refused ? { refused: result.refused } : {}) };
    writeFileSync(ackPath(rid), JSON.stringify(ack));
    // When the switch was refused, delete the board that was not read
    if (result?.refused) rmSync(boardPath(rid), { force: true });
  });

  webview.bind("__textboardSave", (content: string) => {
    if (currentPath === null) return { ok: false, error: "no file" };
    try {
      writeFileSync(currentPath, content);
      lastStamp = stampOf(currentPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // Save the comments (COMMENTS_DIR/<sha256>.json). With zero comments, delete the file (leave nothing behind)
  webview.bind("__textboardSaveComments", (json: string | null) => {
    if (currentPath === null) return { ok: false, error: "no file" };
    try {
      const sidecar = commentsPath(currentPath);
      if (json === null) rmSync(sidecar, { force: true });
      else {
        mkdirSync(COMMENTS_DIR, { recursive: true, mode: 0o700 });
        json = JSON.stringify({ file: currentPath, ...JSON.parse(json) }, null, 2) + "\n";
        // Write a temporary file and rename it over, so a symlink placed there is replaced rather than followed
        const tmp = `${sidecar}.${process.pid}.tmp`;
        writeFileSync(tmp, json, { flag: "wx", mode: 0o600 });
        renameSync(tmp, sidecar);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  webview.bind("__textboardSend", (payload: Record<string, unknown>) => {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const full = { id, target: config.target, ...payload };
    // Write under another name and rename, so wait never reads a half-written file
    const tmp = join(outboxDir(config.target), `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
    renameSync(tmp, join(outboxDir(config.target), `${id}.json`));
    return { id };
  });

  // Called by the page every 500 ms. Returns a replace request, outside changes to the file, whether a wait is running, and the instructions not yet taken
  webview.bind("__textboardPoll", () => {
    let replaceUrl: string | null = null;
    const request = requestPath(config.target);
    if (existsSync(request)) {
      const parsed = JSON.parse(readFileSync(request, "utf8")) as { url: string; pid: number };
      rmSync(request);
      if (parsed.pid === process.pid) replaceUrl = parsed.url;
    }
    let disk: { text: string | null } | null = null;
    if (currentPath !== null) {
      const stamp = stampOf(currentPath);
      if (!sameStamp(stamp, lastStamp)) {
        lastStamp = stamp;
        disk = { text: stamp === null ? null : readFileSync(currentPath, "utf8") };
      }
    }
    return { replaceUrl, disk, waiting: waiterAlive(config.target), pending: pendingIds(config.target) };
  });

  webview.bind("__textboardCopy", (text: string) => {
    const result = spawnSync("pbcopy", [], { input: text });
    return { ok: result.status === 0 };
  });

  // ⌘W. webview-bun exposes no way to stop run() from outside, so clean up and exit the whole process
  webview.bind("__textboardClose", () => {
    cleanupWindow(config);
    process.exit(0);
  });

  webview.navigate(config.url);
  webview.run();
  cleanupWindow(config);
}

function cleanupWindow(config: WindowConfig) {
  rmSync(boardPath(config.requestId), { force: true });
  if (readPid(config.target) === process.pid) rmSync(pidPath(config.target));
}

// ---------------- wait ----------------

async function waitForInstruction(args: string[]): Promise<number> {
  let target: string | null = null;
  let timeoutMs: number | null = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--target") target = requireTargetName(args[i + 1]);
    else if (args[i] === "--timeout") {
      const seconds = Number(args[i + 1]);
      if (!Number.isFinite(seconds) || seconds <= 0) usageError(M.badTimeout);
      timeoutMs = seconds * 1000;
    } else usageError(M.badTargetName);
  }
  if (target === null) usageError(M.badTargetName);

  // Hand over a queued instruction first, even if the window is not open
  const queued = takeInstruction(target);
  if (queued !== null) {
    process.stdout.write(queued);
    return 0;
  }
  if (findWindowPid(target) === null) {
    console.error(M.notOpen(target));
    return 1;
  }

  // A marker so the window can show that the AI is waiting. With several waits for the same name, any live one counts
  const marker = join(waitersDir(target), String(process.pid));
  mkdirSync(waitersDir(target), { recursive: true, mode: 0o700 });
  writeFileSync(marker, "");
  const removeMarker = () => rmSync(marker, { force: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      removeMarker();
      process.exit(130);
    });
  }

  try {
    const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
    let lastWindowCheck = 0;
    while (Date.now() < deadline) {
      const instruction = takeInstruction(target);
      if (instruction !== null) {
        process.stdout.write(instruction);
        return 0;
      }
      if (Date.now() - lastWindowCheck > 1000) {
        lastWindowCheck = Date.now();
        if (findWindowPid(target) === null && takeInstructionPeek(target) === 0) {
          console.error(M.windowClosed(target));
          return 3;
        }
      }
      await Bun.sleep(WAIT_POLL_MS);
    }
    console.error(M.waitTimeout(target));
    return 2;
  } finally {
    removeMarker();
  }
}

function pendingIds(target: string): string[] {
  const dir = outboxDir(target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => f.slice(0, -".json".length));
}

function takeInstructionPeek(target: string): number {
  return pendingIds(target).length;
}

// Take the oldest instruction. Claim it by rename before reading, so that even when several waits take at once,
// each instruction goes to exactly one wait
function takeInstruction(target: string): string | null {
  for (const id of pendingIds(target)) {
    const from = join(outboxDir(target), `${id}.json`);
    const claimed = join(outboxDir(target), `.${id}.${process.pid}.taken`);
    try {
      renameSync(from, claimed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const content = readFileSync(claimed, "utf8");
    rmSync(claimed, { force: true });
    return content;
  }
  return null;
}

function waiterAlive(target: string): boolean {
  const dir = waitersDir(target);
  if (!existsSync(dir)) return false;
  for (const file of readdirSync(dir)) {
    const pid = Number(file);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      rmSync(join(dir, file), { force: true });
    }
  }
  return false;
}

// ---------------- --close / --list ----------------

function closeTarget(target: string): number {
  const pid = findWindowPid(target);
  if (pid === null) {
    console.error(M.notOpen(target));
    return 1;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  rmSync(pidPath(target), { force: true });
  console.log(`closed target=${target} pid=${pid}`);
  return 0;
}

function listTargets() {
  for (const file of readdirSync(TARGETS_DIR)) {
    if (!file.endsWith(".pid")) continue;
    const target = file.slice(0, -".pid".length);
    const pid = findWindowPid(target);
    if (pid !== null) console.log(`${target}\tpid=${pid}`);
  }
}

// Check that the process in the pid file is still textboard's window for that name. Delete stale pid files
function findWindowPid(target: string): number | null {
  const pid = readPid(target);
  if (pid === null) return null;
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  const args = ps.stdout.trim();
  const isThisTarget = args.includes(scriptPath) && args.includes("--window") && args.includes(`"target":"${target}"`);
  if (ps.status === 0 && isThisTarget) return pid;
  rmSync(pidPath(target), { force: true });
  return null;
}

// ---------------- State directory ----------------

// Using a directory or symlink created first by another user would let them plant request files or redirect writes
function ensureStateDir() {
  try {
    mkdirSync(STATE_DIR, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = lstatSync(STATE_DIR);
  const isOwnPrivateDir = stat.isDirectory() && stat.uid === USER_ID && (stat.mode & 0o077) === 0;
  if (!isOwnPrivateDir) {
    console.error(M.badStateDir(STATE_DIR));
    process.exit(1);
  }
  for (const dir of [TARGETS_DIR, ACKS_DIR, LOGS_DIR, BOARDS_DIR, OUTBOX_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function acquireTargetLock(target: string): Promise<boolean> {
  const path = lockPath(target);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(path);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() - statSync(path).mtimeMs > LOCK_WAIT_MS) rmSync(path, { recursive: true, force: true });
      await Bun.sleep(ACK_POLL_MS);
    }
  }
  return false;
}

// Clean up old files left unread in boards/ and acks/ (the outbox is kept until a wait takes it)
function sweepStaleFiles(): void {
  const deadline = Date.now() - STALE_FILE_MS;
  for (const dir of [BOARDS_DIR, ACKS_DIR]) {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < deadline) rmSync(path, { force: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
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

function buildUrl(requestId: string): string {
  return "file://" + htmlPath.split("/").map(encodeURIComponent).join("/") + "?rid=" + requestId + "&lang=" + lang;
}

function requireTargetName(name: string | undefined): string {
  if (name === undefined || !TARGET_NAME_PATTERN.test(name)) usageError(M.badTargetName);
  return name;
}

function usageError(message: string): never {
  fatal(`${message}\n${M.usage}`);
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

export function commentsPath(path: string) {
  return join(COMMENTS_DIR, createHash("sha256").update(path).digest("hex") + ".json");
}

function pidPath(target: string) {
  return join(TARGETS_DIR, `${target}.pid`);
}

function requestPath(target: string) {
  return join(TARGETS_DIR, `${target}.request.json`);
}

function lockPath(target: string) {
  return join(TARGETS_DIR, `${target}.lock`);
}

function waitersDir(target: string) {
  return join(TARGETS_DIR, `${target}.waiters`);
}

function outboxDir(target: string) {
  return join(OUTBOX_DIR, target);
}

function ackPath(requestId: string) {
  return join(ACKS_DIR, `${requestId}.json`);
}

function boardPath(requestId: string) {
  return join(BOARDS_DIR, `${requestId}.json`);
}
