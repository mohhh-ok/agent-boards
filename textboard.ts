#!/usr/bin/env bun
// Launcher that opens textboard.html in a webview-bun window. No server or browser needed.
// Named windows, locks, acks and the state directory are shared with moodboard and reportboard (lib/windows.ts).
//
// Usage:
//   textboard --target <name> <file>                  Open. If a window with that name exists, switch it to the file
//   textboard wait --target <name> [--timeout <sec>]  Wait until the window sends an instruction to the AI; print it as JSON on stdout
//   textboard --close <name>                          Close only the window with that name
//   textboard --list                                  List the open named windows
// Every form may start with --lang ja|en (display language; see "Language" in docs/textboard.md)
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
import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { installEditMenu } from "./editMenu.ts";
import { applyLang, createI18n, type Lang } from "./lib/lang.ts";
import { createWindowHost, isValidTargetName } from "./lib/windows.ts";
import { OUTBOX_DIR_NAME, createOutbox } from "./lib/outbox.ts";

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "textboard.html");
// State lives in /tmp/textboard-<uid>/ (lib/windows.ts). outbox/ holds the instructions not yet taken by a wait
const host = createWindowHost({ name: "textboard", scriptPath, htmlPath, extraDirs: [OUTBOX_DIR_NAME] });
const outbox = createOutbox(host);
// Larger files are not treated as text (the size assumes editing in a textarea)
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Where comments are stored. Kept here rather than next to the document, so no extra files appear in the user's repository.
// The file name is the sha256 of the document's absolute path (the JSON also holds the path). Moving or renaming the
// document detaches its comments. TEXTBOARD_HOME changes the location (for verification)
const COMMENTS_DIR = join(process.env.TEXTBOARD_HOME || join(homedir(), ".textboard"), "comments");

type WindowConfig = { target: string; url: string; requestId: string; lang: Lang };
type Ack = { pid: number; refused?: "unsaved" };
// What to show for one request. Written to boards/<rid>.json; the page reads it with __textboardLoad(rid)
type Board = { path: string };

// ---------------- Display language ----------------
// Chosen in lib/lang.ts: --lang > TEXTBOARD_LANG > the macOS language setting. Anything but ja is en.
// The `opened ...` line on success and the JSON from wait are for scripts, so they are not translated
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

const i18n = createI18n(MESSAGES);

if (import.meta.main) await main(process.argv.slice(2));

async function main(argv: string[]) {
  if (argv[0] === "--window") {
    host.ensureStateDir(badStateDir);
    runWindow(JSON.parse(argv[1]) as WindowConfig);
    return;
  }

  argv = applyLang({ argv, envName: "TEXTBOARD_LANG", i18n, onBad: (source, value) => usageError(i18n.M.badLang(source, value)) });
  host.ensureStateDir(badStateDir);
  if (argv[0] === "--close") process.exit(host.closeTarget(requireTargetName(argv[1]), i18n.M.notOpen));
  if (argv[0] === "--list") {
    host.listTargets();
    return;
  }
  if (argv[0] === "wait") process.exit(await outbox.wait({ args: argv.slice(1), messages: i18n.M, usageError, isTargetName: isValidTargetName }));

  host.sweepStaleFiles();
  if (argv[0] !== "--target") usageError(i18n.M.badTargetName);
  const target = requireTargetName(argv[1]);
  const rest = argv.slice(2);
  if (rest.length !== 1) usageError(i18n.M.oneFile);
  const path = checkedTextFile(rest[0]);
  process.exit(await openFile(target, path));
}

// ---------------- Checking the file to open ----------------

function checkedTextFile(arg: string): string {
  const path = resolve(arg);
  if (!existsSync(path)) fatal(i18n.M.notFound(path));
  const stat = statSync(path);
  if (!stat.isFile()) fatal(i18n.M.notFile(path));
  if (stat.size > MAX_FILE_BYTES) fatal(i18n.M.tooLarge(path));
  // Treat it as binary if the first 8 KB contain NUL (the same test as git)
  const fd = openSync(path, "r");
  const head = Buffer.alloc(Math.min(8192, stat.size));
  readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  if (head.includes(0)) fatal(i18n.M.notText(path));
  return path;
}

// ---------------- Showing the window ----------------

async function openFile(target: string, path: string): Promise<number> {
  // If two launches for the same name overlap, both decide "not open" and two windows open. Serialize with a per-name lock
  const lock = await host.acquireTargetLock(target);
  if (!lock) {
    console.error(i18n.M.lockFailed(target, host.lockPath(target)));
    return 2;
  }
  try {
    return await showFile(target, path);
  } finally {
    host.releaseTargetLock(target);
  }
}

async function showFile(target: string, path: string): Promise<number> {
  const requestId = randomUUID();
  host.writeBoard(requestId, { path } satisfies Board);
  const url = host.buildUrl(requestId, i18n.lang);
  const existingPid = host.findWindowPid(target);

  let child: ChildProcess | null = null;
  let logPath: string | null = null;
  if (existingPid !== null) {
    host.writeReplaceRequest(target, { requestId, url, pid: existingPid });
  } else {
    const config: WindowConfig = { target, url, requestId, lang: i18n.lang };
    ({ child, logPath } = host.spawnWindow({ requestId, config }));
  }

  const ack = await host.waitForAck<Ack>({ requestId, child });
  const action = existingPid !== null ? "replaced" : "new";
  if (ack === null) {
    host.discardUnreceived({ target, requestId, replaced: existingPid !== null });
    console.error(i18n.M.notShown(target, existingPid !== null) + (logPath ? `\nlog: ${logPath}` : ""));
    return 2;
  }
  if (ack.refused === "unsaved") {
    console.error(i18n.M.refusedUnsaved(target));
    return 3;
  }
  console.log(`opened target=${target} pid=${ack.pid} ${action} file=${path}`);
  return 0;
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
  host.registerWindow(config.target);
  outbox.prepare(config.target);

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
    const board = host.takeBoard<Board>(rid);
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
    host.writeAck(rid, ack);
    // When the switch was refused, delete the board that was not read
    if (result?.refused) rmSync(host.boardPath(rid), { force: true });
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

  webview.bind("__textboardSend", (payload: Record<string, unknown>) => outbox.send(config.target, payload));

  // Called by the page every 500 ms. Returns a replace request, outside changes to the file, whether a wait is running, and the instructions not yet taken
  webview.bind("__textboardPoll", () => {
    const replaceUrl = host.takeReplaceRequest(config.target);
    let disk: { text: string | null } | null = null;
    if (currentPath !== null) {
      const stamp = stampOf(currentPath);
      if (!sameStamp(stamp, lastStamp)) {
        lastStamp = stamp;
        disk = { text: stamp === null ? null : readFileSync(currentPath, "utf8") };
      }
    }
    return { replaceUrl, disk, waiting: outbox.waiterAlive(config.target), pending: outbox.pendingIds(config.target) };
  });

  webview.bind("__textboardCopy", (text: string) => {
    const result = spawnSync("pbcopy", [], { input: text });
    return { ok: result.status === 0 };
  });

  // ⌘W. webview-bun exposes no way to stop run() from outside, so clean up and exit the whole process
  webview.bind("__textboardClose", () => {
    host.cleanupWindow(config);
    process.exit(0);
  });

  webview.navigate(config.url);
  webview.run();
  host.cleanupWindow(config);
}

function requireTargetName(name: string | undefined): string {
  if (!isValidTargetName(name)) usageError(i18n.M.badTargetName);
  return name;
}

function badStateDir(dir: string): never {
  return fatal(i18n.M.badStateDir(dir));
}

function usageError(message: string): never {
  fatal(`${message}\n${i18n.M.usage}`);
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

export function commentsPath(path: string) {
  return join(COMMENTS_DIR, createHash("sha256").update(path).digest("hex") + ".json");
}


