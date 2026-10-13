#!/usr/bin/env bun
// Launcher that opens a Markdown report in reportboard.html in a webview-bun window. No server or browser needed.
//
// Usage:
//   reportboard [--target <name>] <file.md>   Open. If a window with that name exists, switch it to the file
//   reportboard wait --target <name> [--timeout <sec>]   Wait until the user sends something to the AI from a section; print it as JSON
//   reportboard reply --thread <id> (<text> | --file <path>)   Answer in that thread. It shows up in the section it was sent from
//   reportboard --close <name>                Close only the window with that name
//   reportboard --list                        List the open named windows
// Every form may start with --lang ja|en (display language; see "Language" in docs/reportboard.md)
//
// The window process renders the Markdown (lib/report.ts) and hands the page finished HTML. The page polls
// __reportboardPoll every 500 ms; when the file changed on disk, the poll returns the new rendering, so the window
// follows the file as the agent rewrites it. Named windows, locks and acks are shared with the other commands (lib/windows.ts).
//
// Conversations: each h2 / h3 of a named window has a button. What the user sends is appended to the section's thread
// (lib/threads.ts, kept in ~/.reportboard) and queued in the outbox for `wait` (lib/outbox.ts, shared with textboard).
//
// Exit codes of opening: 0 = shown / 1 = bad arguments or path / 2 = not shown in time
import { Webview, SizeHint } from "webview-bun";
import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyLang, createI18n, type Lang } from "./lib/lang.ts";
import { createWindowHost, isValidTargetName } from "./lib/windows.ts";
import { renderReport } from "./lib/report.ts";
import { OUTBOX_DIR_NAME, createOutbox } from "./lib/outbox.ts";
import { addReply, addUserMessage, placeThreads, readThreads, threadsPath, type SectionRef } from "./lib/threads.ts";

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "reportboard.html");
const host = createWindowHost({ name: "reportboard", scriptPath, htmlPath, extraDirs: [OUTBOX_DIR_NAME] });
const outbox = createOutbox(host);
// Where the threads are kept. REPORTBOARD_HOME changes it (for verification)
const HOME = process.env.REPORTBOARD_HOME || join(homedir(), ".reportboard");
// Larger files are not treated as a report
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type WindowConfig = { target: string | null; url: string; requestId: string };
type Ack = { pid: number };
// What to show for one request. Written to boards/<rid>.json; the page reads it with __reportboardLoad(rid)
type Board = { path: string };

// The `opened ...` line on success is for scripts, so it is not translated
const MESSAGES = {
  ja: {
    usage:
      "usage: reportboard [--lang ja|en] [--target <名前>] <file.md>\n       reportboard [--lang ja|en] wait --target <名前> [--timeout <秒>]\n       reportboard [--lang ja|en] reply --thread <id> (<本文> | --file <path>)\n       reportboard [--lang ja|en] --close <名前>\n       reportboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} は ja か en で指定してください: ${value}`,
    badTargetName: "--target の名前は英数字と . _ - だけで指定してください",
    oneFile: "開く Markdown ファイルを 1 つだけ指定してください",
    notFound: (path: string) => `ファイルが見つかりません: ${path}`,
    notFile: (path: string) => `通常のファイルではありません: ${path}`,
    tooLarge: (path: string) => `ファイルが大きすぎます(5MB まで): ${path}`,
    notText: (path: string) => `テキストファイルではないようです(NUL を含む): ${path}`,
    lockFailed: (target: string, path: string) => `target=${target} のロックを取れませんでした (${path})`,
    notShown: (target: string | null, replaced: boolean) =>
      `表示を確認できませんでした (target=${target ?? "(名前なし)"}, ${replaced ? "差し替え" : "新規"})`,
    notOpen: (target: string) => `target=${target} のウィンドウは開いていません`,
    badStateDir: (dir: string) => `${dir} が自分の所有する権限 700 のディレクトリではありません。中身を確かめて削除してください`,
    badTimeout: "--timeout は正の秒数で指定してください",
    windowClosed: (target: string) => `target=${target} のウィンドウが閉じられました`,
    waitTimeout: (target: string) => `target=${target} から指示が来ないまま --timeout が過ぎました`,
    replyUsage: "reply は --thread <id> と、本文か --file <path> を指定してください",
    threadNotFound: (id: string) => `スレッドが見つかりません: ${id}`,
    emptyReply: "返事の本文が空です",
  },
  en: {
    usage: "usage: reportboard [--lang ja|en] [--target <name>] <file.md>\n       reportboard [--lang ja|en] wait --target <name> [--timeout <seconds>]\n       reportboard [--lang ja|en] reply --thread <id> (<text> | --file <path>)\n       reportboard [--lang ja|en] --close <name>\n       reportboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} must be ja or en: ${value}`,
    badTargetName: "--target names may use only letters, digits and . _ -",
    oneFile: "Give exactly one Markdown file to open",
    notFound: (path: string) => `File not found: ${path}`,
    notFile: (path: string) => `Not a regular file: ${path}`,
    tooLarge: (path: string) => `File is too large (5 MB max): ${path}`,
    notText: (path: string) => `This does not look like a text file (contains NUL): ${path}`,
    lockFailed: (target: string, path: string) => `Could not take the lock for target=${target} (${path})`,
    notShown: (target: string | null, replaced: boolean) =>
      `Could not confirm that the window showed the file (target=${target ?? "(unnamed)"}, ${replaced ? "replaced" : "new window"})`,
    notOpen: (target: string) => `No window is open for target=${target}`,
    badStateDir: (dir: string) => `${dir} is not a directory owned by you with mode 700. Check its contents and delete it`,
    badTimeout: "--timeout must be a positive number of seconds",
    windowClosed: (target: string) => `The window target=${target} was closed`,
    waitTimeout: (target: string) => `No instruction came from target=${target} before --timeout`,
    replyUsage: "reply needs --thread <id> and either the text or --file <path>",
    threadNotFound: (id: string) => `Thread not found: ${id}`,
    emptyReply: "The reply is empty",
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

  argv = applyLang({ argv, envName: "REPORTBOARD_LANG", i18n, onBad: (source, value) => usageError(i18n.M.badLang(source, value)) });
  host.ensureStateDir(badStateDir);
  if (argv[0] === "--close") process.exit(host.closeTarget(requireTargetName(argv[1]), i18n.M.notOpen));
  if (argv[0] === "--list") {
    host.listTargets();
    return;
  }

  if (argv[0] === "wait") process.exit(await outbox.wait({ args: argv.slice(1), messages: i18n.M, usageError, isTargetName: isValidTargetName }));
  if (argv[0] === "reply") process.exit(reply(argv.slice(1)));

  host.sweepStaleFiles();
  let target: string | null = null;
  let rest = argv;
  if (argv[0] === "--target") {
    target = requireTargetName(argv[1]);
    rest = argv.slice(2);
  }
  if (rest.length !== 1 || rest[0].startsWith("--")) usageError(i18n.M.oneFile);
  const path = checkedTextFile(rest[0]);
  process.exit(await openReport({ target, path }));
}

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

function reply(args: string[]): number {
  let threadId: string | null = null;
  let filePath: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--thread") threadId = args[++i] ?? null;
    else if (args[i] === "--file") filePath = args[++i] ?? null;
    else words.push(args[i]);
  }
  if (threadId === null || (filePath === null) === (words.length === 0)) usageError(i18n.M.replyUsage);
  if (filePath !== null && !existsSync(resolve(filePath))) fatal(i18n.M.notFound(resolve(filePath)));
  const text = (filePath === null ? words.join(" ") : readFileSync(resolve(filePath), "utf8")).trim();
  if (text === "") fatal(i18n.M.emptyReply);
  const result = addReply({ home: HOME, threadId, text });
  if (result === null) fatal(i18n.M.threadNotFound(threadId));
  console.log(`replied thread=${threadId} file=${result.file}`);
  return 0;
}

// ---------------- Showing the window ----------------

async function openReport(request: { target: string | null; path: string }): Promise<number> {
  if (request.target === null) return await showReport(request);
  // If two launches for the same name overlap, both decide "not open" and two windows open. Serialize with a per-name lock
  const target = request.target;
  const lock = await host.acquireTargetLock(target);
  if (!lock) {
    console.error(i18n.M.lockFailed(target, host.lockPath(target)));
    return 2;
  }
  try {
    return await showReport(request);
  } finally {
    host.releaseTargetLock(target);
  }
}

async function showReport(request: { target: string | null; path: string }): Promise<number> {
  const requestId = randomUUID();
  host.writeBoard(requestId, { path: request.path } satisfies Board);
  const url = host.buildUrl(requestId, i18n.lang);
  const existingPid = request.target === null ? null : host.findWindowPid(request.target);

  let child: ChildProcess | null = null;
  let logPath: string | null = null;
  if (existingPid !== null && request.target !== null) {
    host.writeReplaceRequest(request.target, { requestId, url, pid: existingPid });
  } else {
    const config: WindowConfig = { target: request.target, url, requestId };
    ({ child, logPath } = host.spawnWindow({ requestId, config }));
  }

  const ack = await host.waitForAck<Ack>({ requestId, child });
  if (ack === null) {
    host.discardUnreceived({ target: request.target, requestId, replaced: existingPid !== null });
    console.error(i18n.M.notShown(request.target, existingPid !== null) + (logPath ? `\nlog: ${logPath}` : ""));
    return 2;
  }
  const action = existingPid !== null ? "replaced" : "new";
  console.log(`opened target=${request.target ?? "(unnamed)"} pid=${ack.pid} ${action} file=${request.path}`);
  return 0;
}

// ---------------- Window process ----------------

type DiskStamp = { mtimeMs: number; size: number } | null;

function runWindow(config: WindowConfig) {
  host.registerWindow(config.target);

  // The open file and its state on disk when last rendered. Used to follow changes to the file
  let currentPath: string | null = null;
  let lastStamp: DiskStamp = null;
  let lastThreadsStamp: DiskStamp = null;
  let sections: ReturnType<typeof renderReport>["sections"] = [];
  if (config.target !== null) outbox.prepare(config.target);
  const canTalk = config.target !== null;

  const threadsNow = () => {
    if (currentPath === null) return [];
    lastThreadsStamp = stampOf(threadsPath(HOME, currentPath));
    return placeThreads(readThreads(HOME, currentPath).threads, sections);
  };
  const renderNow = (path: string) => {
    const report = renderFile(path);
    sections = report.sections;
    return { ...report, canTalk, threads: threadsNow() };
  };

  const webview = new Webview();
  webview.title = config.target === null ? "reportboard" : `reportboard — ${config.target}`;
  webview.size = { width: 1440, height: 900, hint: SizeHint.NONE };
  // For verification: inject a script that drives the page in the real window (docs/reportboard-development.md). Not used normally
  const devInit = process.env.REPORTBOARD_DEV_INIT_SCRIPT;
  if (devInit) webview.init(readFileSync(devInit, "utf8"));

  // Bun's event loop is stopped during run(), so callbacks use synchronous I/O only
  webview.bind("__reportboardLoad", (rid: string) => {
    const board = host.takeBoard<Board>(rid);
    currentPath = board.path;
    lastStamp = stampOf(board.path);
    const report = renderNow(board.path);
    webview.title = `${report.title ?? basename(board.path)} — reportboard${config.target === null ? "" : ` ${config.target}`}`;
    return report;
  });

  webview.bind("__reportboardReady", (rid: string) => {
    host.writeAck(rid, { pid: process.pid } satisfies Ack);
  });

  // Called by the page every 500 ms. Returns a replace request, and a new rendering when the file changed on disk
  webview.bind("__reportboardPoll", () => {
    const replaceUrl = config.target === null ? null : host.takeReplaceRequest(config.target);
    let report: ReturnType<typeof renderNow> | null = null;
    let threads: ReturnType<typeof threadsNow> | null = null;
    let missing = false;
    if (currentPath !== null) {
      const stamp = stampOf(currentPath);
      missing = stamp === null;
      if (stamp !== null && !sameStamp(stamp, lastStamp)) {
        lastStamp = stamp;
        report = renderNow(currentPath);
      } else if (!sameStamp(stampOf(threadsPath(HOME, currentPath)), lastThreadsStamp)) {
        threads = threadsNow();
      }
    }
    const waiting = config.target !== null && outbox.waiterAlive(config.target);
    return { replaceUrl, report, threads, missing, waiting };
  });

  // The user sends something from a section: append it to the thread and queue it for `wait`
  webview.bind("__reportboardSend", (payload: { threadId: string | null; section: SectionRef; text: string }) => {
    if (config.target === null || currentPath === null) return { ok: false, error: "no target" };
    try {
      const thread = addUserMessage({ home: HOME, reportPath: currentPath, threadId: payload.threadId, section: payload.section, text: payload.text });
      outbox.send(config.target, {
        file: currentPath,
        section: { level: thread.heading.level, heading: thread.heading.text },
        thread: { id: thread.id, messages: thread.messages },
        instruction: payload.text,
        reply: `reportboard reply --thread ${thread.id} --file <path>`,
        sentAt: thread.messages[thread.messages.length - 1].at,
      });
      return { ok: true, threadId: thread.id, threads: threadsNow() };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // Links leave the window. Web pages open in the browser. A local file is only revealed in Finder, never opened,
  // because `open` would launch an app or a script that a link in the Markdown points at
  webview.bind("__reportboardOpen", (href: string) => {
    const args = openArgsFor(href, currentPath);
    if (args === null) return { ok: false };
    const result = spawnSync("open", args);
    return { ok: result.status === 0 };
  });

  // ⌘W. webview-bun exposes no way to stop run() from outside, so clean up and exit the whole process
  webview.bind("__reportboardClose", () => {
    host.cleanupWindow(config);
    process.exit(0);
  });

  webview.navigate(config.url);
  webview.run();
  host.cleanupWindow(config);
}

function renderFile(path: string) {
  const markdown = readFileSync(path, "utf8");
  const stat = statSync(path);
  return { path, name: basename(path), dir: dirname(path), modifiedAt: stat.mtimeMs, ...renderReport(markdown, { baseDir: dirname(path) }) };
}

export function openArgsFor(href: string, reportPath: string | null): string[] | null {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return [href];
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || reportPath === null) return null;
  const path = resolve(dirname(reportPath), decodeURIComponent(href.split("#")[0]));
  return existsSync(path) ? ["-R", path] : null;
}

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
