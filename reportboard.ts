#!/usr/bin/env bun
// Launcher that opens a Markdown report in reportboard.html in a webview-bun window. No server or browser needed.
//
// Usage:
//   reportboard [--target <name>] <file.md>   Open. If a window with that name exists, switch it to the file
//   reportboard wait --target <name> [--timeout <sec>]   Wait until the user sends something to the AI from a section; print it as JSON
//                                                      (a JSON array when several were queued)
//   reportboard watch --target <name> [--timeout <sec>]  Keep receiving: print each message as one line of JSON (for Claude Code's Monitor)
//   reportboard reply --thread <id> [--done] --file <path>   Answer in that thread with the text in the file. It shows up in the section it was sent from.
//                                                      --done on the last reply ends "the AI is working on it" in the window
//   reportboard --close <name>                Close only the window with that name
//   reportboard --list                        List the open named windows
// Every form may start with --lang ja|en (display language; see "Language" in docs/reportboard.md)
//
// The window process renders the Markdown (lib/report.ts) and hands the page finished HTML. The page polls
// __reportboardPoll every 500 ms; when the file changed on disk, the poll returns the new rendering, so the window
// follows the file as the agent rewrites it. Named windows, locks and acks are shared with the other commands (lib/windows.ts).
//
// Conversations: each h2 / h3 and each breakdown row of a named window has a button. What the user sends is appended to the section's thread
// (lib/threads.ts, kept in ~/.reportboard) and queued in the outbox for `wait` (lib/outbox.ts, shared with textboard).
//
// Exit codes of opening: 0 = shown / 1 = bad arguments or path / 2 = not shown in time / 3 = the window opened but could not read the report
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
import { addReply, addUserMessage, markReceived, placeThreads, readThreads, rememberPlaces, resetThreads, threadState, threadsPath, wasReset, type SectionRef } from "./lib/threads.ts";

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "reportboard.html");
const host = createWindowHost({ name: "reportboard", scriptPath, htmlPath, extraDirs: [OUTBOX_DIR_NAME] });
const outbox = createOutbox(host);
// Where the threads are kept. REPORTBOARD_HOME changes it (for verification)
const HOME = process.env.REPORTBOARD_HOME || join(homedir(), ".reportboard");
// Larger files are not treated as a report
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type WindowConfig = { target: string | null; url: string; requestId: string };
// failed: why the page could not show the report (the window stays open with the message)
type Ack = { pid: number; failed: string | null };
// What to show for one request. Written to boards/<rid>.json; the page reads it with __reportboardLoad(rid)
type Board = { path: string };

// The `opened ...` line on success is for scripts, so it is not translated
const MESSAGES = {
  ja: {
    usage:
      "usage: reportboard [--lang ja|en] [--target <名前>] <file.md>\n       reportboard [--lang ja|en] wait --target <名前> [--timeout <秒>]\n       reportboard [--lang ja|en] watch --target <名前> [--timeout <秒>]\n       reportboard [--lang ja|en] reply --thread <id> [--done] --file <path>\n       reportboard [--lang ja|en] --close <名前>\n       reportboard [--lang ja|en] --list",
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
    replyUsage: "reply は --thread <id> と --file <path> を指定してください",
    replyTextArg: "返事の本文は引数では渡せません。本文をファイルに書き、--file <path> で渡してください",
    threadNotFound: (id: string) => `スレッドが見つかりません: ${id}`,
    threadReset: (id: string) => `このやり取りは窓でリセットされました。返事は表示されません。このやり取りの作業はやめてください: ${id}`,
    loadFailed: (detail: string) => `窓は開きましたが、レポートを読み込めませんでした: ${detail}`,
    emptyReply: "返事の本文が空です",
    unread: (target: string, n: number) => `未読 ${n} 件: 窓から送られてまだ受け取っていないメッセージがあります。reportboard wait --target ${target} で受け取ってください`,
  },
  en: {
    usage: "usage: reportboard [--lang ja|en] [--target <name>] <file.md>\n       reportboard [--lang ja|en] wait --target <name> [--timeout <seconds>]\n       reportboard [--lang ja|en] watch --target <name> [--timeout <seconds>]\n       reportboard [--lang ja|en] reply --thread <id> [--done] --file <path>\n       reportboard [--lang ja|en] --close <name>\n       reportboard [--lang ja|en] --list",
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
    replyUsage: "reply needs --thread <id> and --file <path>",
    replyTextArg: "reply does not take the text as an argument. Write it to a file and pass --file <path>",
    threadNotFound: (id: string) => `Thread not found: ${id}`,
    threadReset: (id: string) => `The user reset this conversation in the window. The reply is not shown; stop working on it: ${id}`,
    loadFailed: (detail: string) => `The window opened but could not read the report: ${detail}`,
    emptyReply: "The reply is empty",
    unread: (target: string, n: number) => `unread ${n}: messages from the window nobody has taken yet. Take them with reportboard wait --target ${target}`,
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

  if (argv[0] === "wait") process.exit(await outbox.wait({ args: argv.slice(1), messages: i18n.M, usageError, isTargetName: isValidTargetName, onTaken: noteReceived }));
  if (argv[0] === "watch") process.exit(await outbox.watch({ args: argv.slice(1), messages: i18n.M, usageError, isTargetName: isValidTargetName, onTaken: noteReceived }));
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
  let done = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--thread") threadId = args[++i] ?? null;
    else if (args[i] === "--done") done = true;
    else if (args[i] === "--file") filePath = args[++i] ?? null;
    else words.push(args[i]);
  }
  // The text comes only from a file, so it never passes through shell quoting
  if (words.length > 0) usageError(i18n.M.replyTextArg);
  if (threadId === null || filePath === null) usageError(i18n.M.replyUsage);
  if (!existsSync(resolve(filePath))) fatal(i18n.M.notFound(resolve(filePath)));
  const text = readFileSync(resolve(filePath), "utf8").trim();
  if (text === "") fatal(i18n.M.emptyReply);
  const result = addReply({ home: HOME, threadId, text, done });
  if (result === null) fatal(wasReset(HOME, threadId) ? i18n.M.threadReset(threadId) : i18n.M.threadNotFound(threadId));
  console.log(`replied thread=${threadId}${done ? " done" : ""} file=${result.file}`);
  // Messages from the same report nobody has taken yet: an agent that answers without receiving again would miss them
  for (const target of outbox.targets()) {
    const unread = outbox.pending(target).filter((m) => m.file === result.file).length;
    if (unread > 0) console.log(i18n.M.unread(target, unread));
  }
  return 0;
}

// Mark the message as received, so the window shows that the AI got it (docs/design.md "受け取った合図と、返事を分けて出す").
// The instruction has already left the outbox, so a failure here only loses the sign, never the instruction
function noteReceived(instruction: string): void {
  try {
    const { thread, sentAt } = JSON.parse(instruction) as { thread?: { id?: string }; sentAt?: string };
    if (typeof thread?.id === "string" && typeof sentAt === "string") markReceived({ home: HOME, threadId: thread.id, sentAt });
  } catch (error) {
    console.error(`could not mark the message as received: ${(error as Error).message}`);
  }
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
  if (ack.failed !== null) {
    console.error(i18n.M.loadFailed(ack.failed));
    return 3;
  }
  return 0;
}

// ---------------- Window process ----------------

type DiskStamp = { mtimeMs: number; size: number } | null;

function runWindow(config: WindowConfig) {
  host.registerWindow(config.target);

  // The open file. Which version of the file the page shows is kept by the page and sent with every poll (docs/design.md
  // "書き換えた版を取りこぼさない"), so a rendering that failed or never reached the page is sent again on the next poll
  let currentPath: string | null = null;
  // The last rendering error written to the log, so a failure repeated on every poll is logged once
  let lastRenderError: string | null = null;
  let sections: ReturnType<typeof renderReport>["sections"] = [];
  if (config.target !== null) outbox.prepare(config.target);
  const canTalk = config.target !== null;

  // The threads as the page should show them: they change with the threads file, and with a new `wait`, which ends
  // "working" (lib/threads.ts threadState). Like the report, the page sends back the version it shows
  const threadsVersion = () => {
    if (currentPath === null) return null;
    const stamp = stampOf(threadsPath(HOME, currentPath));
    const waitStarted = config.target === null ? null : outbox.lastWaitStarted(config.target);
    return `${stamp?.mtimeMs ?? "-"}:${stamp?.size ?? "-"}:${waitStarted ?? "-"}`;
  };
  const threadsNow = () => {
    if (currentPath === null) return [];
    const waitStarted = config.target === null ? null : outbox.lastWaitStarted(config.target);
    const placed = placeThreads(readThreads(HOME, currentPath).threads, sections);
    const renamed = placed.filter((t) => t.placement === "renamed" && t.place !== null).map((t) => ({ id: t.id, from: t.heading, to: t.place as SectionRef }));
    if (renamed.length > 0) {
      // Saved so the thread keeps following its place; the next poll sends the threads again, already placed exactly
      try {
        rememberPlaces({ home: HOME, reportPath: currentPath, places: renamed });
      } catch (error) {
        console.error(`could not save where the threads moved: ${(error as Error).message}`);
      }
    }
    return placed.map((thread) => ({ ...thread, state: threadState(thread, waitStarted) }));
  };
  const renderNow = (path: string) => {
    const report = renderFile(path);
    sections = report.sections;
    webview.title = `${report.title ?? basename(path)} — reportboard${config.target === null ? "" : ` ${config.target}`}`;
    // Taken before reading, so a change landing in between is sent again
    const version = threadsVersion();
    return { ...report, canTalk, threads: threadsNow(), threadsVersion: version };
  };

  const webview = new Webview();
  webview.title = config.target === null ? "reportboard" : `reportboard — ${config.target}`;
  webview.size = { width: 1440, height: 900, hint: SizeHint.NONE };
  // For verification: inject a script that drives the page in the real window (docs/reportboard-development.md). Not used normally
  const devInit = process.env.REPORTBOARD_DEV_INIT_SCRIPT;
  if (devInit) webview.init(readFileSync(devInit, "utf8"));

  // Bun's event loop is stopped during run(), so callbacks use synchronous I/O only
  webview.bind("__reportboardLoad", (rid: string) => {
    // Errors are returned, not thrown: webview-bun turns a thrown Error into "{}" and the message is lost
    try {
      const board = host.takeBoard<Board>(rid);
      currentPath = board.path;
      return renderNow(board.path);
    } catch (error) {
      return { error: (error as Error).message };
    }
  });

  webview.bind("__reportboardReady", (rid: string, failed: string | null) => {
    host.writeAck(rid, { pid: process.pid, failed: failed ?? null } satisfies Ack);
  });

  // Called by the page every 500 ms with the version it shows (shown). Returns a replace request, and a new rendering
  // when the file on disk is not that version. renderError: why the new version could not be rendered (sent again next time)
  // shownThreads: the threadsVersion the page shows; the threads are sent until the page has shown the current ones.
  // Nothing here may throw past the replace request: a thrown error loses the whole answer
  webview.bind("__reportboardPoll", (shown: DiskStamp = null, shownThreads: string | null = null) => {
    let replaceUrl: string | null = null;
    try {
      replaceUrl = config.target === null ? null : host.takeReplaceRequest(config.target);
    } catch (error) {
      console.error(`could not read the replace request: ${(error as Error).message}`);
    }
    let report: ReturnType<typeof renderNow> | null = null;
    let renderError: string | null = null;
    let threads: ReturnType<typeof threadsNow> | null = null;
    let version: string | null = null;
    let missing = false;
    if (currentPath !== null) {
      try {
        const path = currentPath;
        const next = nextRendering({ path, shown, render: () => renderNow(path) });
        missing = next.missing;
        report = next.report;
        renderError = next.error?.message ?? null;
        if (next.error !== null && renderError !== lastRenderError) console.error(`could not render ${path}: ${next.error.stack}`);
        lastRenderError = renderError;
        if (next.unchanged) {
          version = threadsVersion();
          if (version !== shownThreads) threads = threadsNow();
        }
      } catch (error) {
        const message = (error as Error).message;
        if (message !== lastRenderError) console.error(`could not read the conversations: ${(error as Error).stack}`);
        lastRenderError = message;
        renderError = message;
      }
    }
    const waiting = config.target !== null && outbox.waiterAlive(config.target);
    return { replaceUrl, report, renderError, threads, threadsVersion: threads === null ? null : version, missing, waiting };
  });

  // The user sends something from a section: append it to the thread and queue it for `wait`
  webview.bind("__reportboardSend", (payload: { threadId: string | null; section: SectionRef; text: string }) => {
    if (config.target === null || currentPath === null) return { ok: false, error: "no target" };
    try {
      const thread = addUserMessage({ home: HOME, reportPath: currentPath, threadId: payload.threadId, section: payload.section, text: payload.text });
      outbox.send(config.target, {
        file: currentPath,
        section: {
          level: thread.heading.level,
          heading: thread.heading.text,
          ...(thread.heading.row === undefined ? {} : { row: thread.heading.row.name }),
        },
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

  // The user resets the report from the top bar: its conversations go, and so do the messages from it nobody has taken
  // yet (from any window showing it), so no AI later gets a message whose conversation is gone. The report is not touched
  webview.bind("__reportboardReset", () => {
    if (config.target === null || currentPath === null) return { ok: false, error: "no target" };
    const path = currentPath;
    try {
      const removed = resetThreads({ home: HOME, reportPath: path });
      const withdrawn = outbox.targets().reduce((sum, target) => sum + outbox.discard(target, (m) => m.file === path), 0);
      console.error(`reset ${path}: ${removed.length} conversations, ${withdrawn} messages not taken`);
      return { ok: true, threads: threadsNow() };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  // The page reports here what went wrong on its side, so it reaches the window's log
  webview.bind("__reportboardLog", (text: string) => {
    console.error(`page: ${text}`);
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

// stamp: the version rendered, which the page sends back with each poll. Taken before reading, so a write landing in
// between makes the next poll render again rather than be missed
function renderFile(path: string) {
  const stat = statSync(path);
  const markdown = readFileSync(path, "utf8");
  const stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
  return { path, name: basename(path), dir: dirname(path), modifiedAt: stat.mtimeMs, stamp, ...renderReport(markdown, { baseDir: dirname(path) }) };
}

export function openArgsFor(href: string, reportPath: string | null): string[] | null {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return [href];
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || reportPath === null) return null;
  const path = resolve(dirname(reportPath), decodeURIComponent(href.split("#")[0]));
  return existsSync(path) ? ["-R", path] : null;
}

// What a poll sends for the report: a new rendering when the file on disk is not the version the page shows (shown).
// Nothing is remembered here, so when rendering fails, the next poll tries again. unchanged: the page is up to date
export function nextRendering<R>(params: { path: string; shown: DiskStamp; render: () => R }): {
  report: R | null;
  error: Error | null;
  missing: boolean;
  unchanged: boolean;
} {
  const stamp = stampOf(params.path);
  if (stamp === null) return { report: null, error: null, missing: true, unchanged: false };
  if (sameStamp(stamp, params.shown)) return { report: null, error: null, missing: false, unchanged: true };
  try {
    return { report: params.render(), error: null, missing: false, unchanged: false };
  } catch (error) {
    return { report: null, error: error as Error, missing: false, unchanged: false };
  }
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
