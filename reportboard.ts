#!/usr/bin/env bun
// Launcher that opens a Markdown report in reportboard.html in a webview-bun window. No server or browser needed.
//
// Usage:
//   reportboard [--target <name>] <file.md>   Open. If a window with that name exists, switch it to the file
//   reportboard --close <name>                Close only the window with that name
//   reportboard --list                        List the open named windows
// Every form may start with --lang ja|en (display language; see "Language" in docs/reportboard.md)
//
// The window process renders the Markdown (lib/report.ts) and hands the page finished HTML. The page polls
// __reportboardPoll every 500 ms; when the file changed on disk, the poll returns the new rendering, so the window
// follows the file as the agent rewrites it. Named windows, locks and acks are shared with the other commands (lib/windows.ts).
//
// Exit codes: 0 = shown / 1 = bad arguments or path / 2 = not shown in time
import { Webview, SizeHint } from "webview-bun";
import { spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyLang, createI18n, type Lang } from "./lib/lang.ts";
import { createWindowHost, isValidTargetName } from "./lib/windows.ts";
import { renderReport } from "./lib/report.ts";

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "reportboard.html");
const host = createWindowHost({ name: "reportboard", scriptPath, htmlPath });
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
      "usage: reportboard [--lang ja|en] [--target <名前>] <file.md>\n       reportboard [--lang ja|en] --close <名前>\n       reportboard [--lang ja|en] --list",
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
  },
  en: {
    usage: "usage: reportboard [--lang ja|en] [--target <name>] <file.md>\n       reportboard [--lang ja|en] --close <name>\n       reportboard [--lang ja|en] --list",
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

  const webview = new Webview();
  webview.title = config.target === null ? "reportboard" : `reportboard — ${config.target}`;
  webview.size = { width: 1440, height: 900, hint: SizeHint.NONE };

  // Bun's event loop is stopped during run(), so callbacks use synchronous I/O only
  webview.bind("__reportboardLoad", (rid: string) => {
    const board = host.takeBoard<Board>(rid);
    currentPath = board.path;
    lastStamp = stampOf(board.path);
    const report = renderFile(board.path);
    webview.title = `${report.title ?? basename(board.path)} — reportboard${config.target === null ? "" : ` ${config.target}`}`;
    return report;
  });

  webview.bind("__reportboardReady", (rid: string) => {
    host.writeAck(rid, { pid: process.pid } satisfies Ack);
  });

  // Called by the page every 500 ms. Returns a replace request, and a new rendering when the file changed on disk
  webview.bind("__reportboardPoll", () => {
    const replaceUrl = config.target === null ? null : host.takeReplaceRequest(config.target);
    let report: ReturnType<typeof renderFile> | null = null;
    let missing = false;
    if (currentPath !== null) {
      const stamp = stampOf(currentPath);
      missing = stamp === null;
      if (stamp !== null && !sameStamp(stamp, lastStamp)) {
        lastStamp = stamp;
        report = renderFile(currentPath);
      }
    }
    return { replaceUrl, report, missing };
  });

  // Links leave the window: web pages and other files open in their default app
  webview.bind("__reportboardOpen", (href: string) => {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(href) || currentPath === null ? href : resolve(dirname(currentPath), href.split("#")[0]);
    const result = spawnSync("open", [target]);
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
