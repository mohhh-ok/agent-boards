#!/usr/bin/env bun
// textboard.html を webview-bun のウィンドウで開くランチャー。サーバ・ブラウザ不要。
// 作りは moodboard(github.com/mohhh-ok/moodboard)のランチャーに揃えている。
//
// 使い方:
//   textboard --target <名前> <ファイル>          開く。同名ウィンドウがあれば中身を差し替える
//   textboard wait --target <名前> [--timeout <秒>]  窓から AI への指示が送られるまで待ち、JSON を stdout に出す
//   textboard --close <名前>                      その名前のウィンドウだけ閉じる
//   textboard --list                              開いている名前付きウィンドウを出す
// どの形も先頭に --lang ja|en を置ける(表示言語。README の「Language」節)
//
// ランチャーはウィンドウ用の子プロセスを別セッション(detached)で起動し、ページがファイルを読み込んだ通知(ack)を
// 受けてから終了する。終了コード:
//   0 = 表示済み / 1 = 引数・パスの誤り / 2 = 時間内に表示されなかった / 3 = 窓に未保存の編集があり差し替えなかった
//
// 窓 → エージェントの指示は、ページが bind 関数 __textboardSend で outbox/<名前>/ に JSON を書き、
// `textboard wait` がそれを受け取って消す。wait が回っていない間に送られた指示も溜まり、次の wait が受け取る。
//
// webview.run() の間は Bun のイベントループが回らないため、窓プロセスから能動的にページへは送れない。
// 差し替え要求・ファイルの外での変更・wait の有無は、ページが __textboardPoll を定期的に呼んで受け取る。
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
import { randomUUID } from "node:crypto";

if (process.getuid === undefined) throw new Error("textboard supports POSIX environments only");
const USER_ID = process.getuid();
// TMPDIR はエージェントの実行環境ごとに違うことがあるため、同じユーザーの全プロセスで共有できる固定の場所に置く。
// /tmp は他ユーザーも書けるので、uid 付きの 0700 ディレクトリにして持ち主を確かめる
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
// これより大きいファイルは文章として扱わない(textarea で編集する前提の大きさ)
const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SIDECAR_SUFFIX = ".textboard.json";

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "textboard.html");

type WindowConfig = { target: string; url: string; requestId: string };
type Ack = { pid: number; refused?: "unsaved" };
// ページへ渡す 1 回分の表示内容。boards/<rid>.json に書き、ページが __textboardLoad(rid) で読む
type Board = { path: string };

// ---------------- 表示言語 ----------------
// 決め方は moodboard と同じ: --lang > TEXTBOARD_LANG > macOS の言語設定。ja 以外は en。$LANG は見ない。
// 成功時の `opened ...` 行と wait の JSON はスクリプト向けなので訳さない
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

// `defaults read -g AppleLanguages` の出力は `(\n    "ja-JP",\n    en\n)` の形。先頭が優先言語
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

// ---------------- 開くファイルの確認 ----------------

function checkedTextFile(arg: string): string {
  const path = resolve(arg);
  if (!existsSync(path)) fatal(M.notFound(path));
  const stat = statSync(path);
  if (!stat.isFile()) fatal(M.notFile(path));
  if (stat.size > MAX_FILE_BYTES) fatal(M.tooLarge(path));
  // 先頭 8KB に NUL があればバイナリとみなす(git と同じ判定)
  const fd = openSync(path, "r");
  const head = Buffer.alloc(Math.min(8192, stat.size));
  readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  if (head.includes(0)) fatal(M.notText(path));
  return path;
}

// ---------------- ウィンドウの表示 ----------------

async function openFile(target: string, path: string): Promise<number> {
  // 同じ名前への起動が重なると、両方が「未オープン」と判断して窓が 2 つ開く。名前ごとのロックで直列にする
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
    // 宛先 pid を入れておき、同名で後から開いた窓が古い要求を拾わないようにする
    writeFileSync(requestPath(target), JSON.stringify({ requestId, url, pid: existingPid }));
  } else {
    logPath = join(LOGS_DIR, `${requestId}.log`);
    const logFd = openSync(logPath, "a");
    const config: WindowConfig = { target, url, requestId };
    child = spawn(process.execPath, [scriptPath, "--window", JSON.stringify(config)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  }

  const ack = await waitForAck(requestId, child);
  const action = existingPid !== null ? "差し替え" : "新規";
  if (ack === null) {
    // 差し替え要求がまだ受け取られていなければ、要求と board を消す(誰にも読まれない)。受け取り済みなら
    // 窓が読み込み中の可能性があるので消さず、窓の __textboardLoad と次回の sweepStaleFiles に任せる(moodboard と同じ)
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

// ---------------- 窓プロセス ----------------

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

  // 今開いているファイルと、最後に読んだ/書いたときのディスク上の状態。外での書き換えの検出に使う
  let currentPath: string | null = null;
  let lastStamp: DiskStamp = null;

  const webview = new Webview();
  webview.title = `textboard — ${config.target}`;
  webview.size = { width: 1180, height: 860, hint: SizeHint.NONE };

  // run() 中は Bun のイベントループが止まるため、callback は同期 I/O だけで書く
  webview.bind("__textboardLoad", (rid: string) => {
    const path = boardPath(rid);
    const board = JSON.parse(readFileSync(path, "utf8")) as Board;
    rmSync(path, { force: true });
    currentPath = board.path;
    lastStamp = stampOf(board.path);
    const text = readFileSync(board.path, "utf8");
    const sidecar = sidecarPath(board.path);
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
    // 差し替えを断った場合、読まれなかった board を消す
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

  // コメントの sidecar(<ファイル>.textboard.json)。コメントが 0 件なら消す(ファイルを残さない)
  webview.bind("__textboardSaveComments", (json: string | null) => {
    if (currentPath === null) return { ok: false, error: "no file" };
    try {
      const sidecar = sidecarPath(currentPath);
      if (json === null) rmSync(sidecar, { force: true });
      else writeFileSync(sidecar, json);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  webview.bind("__textboardSend", (payload: Record<string, unknown>) => {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const full = { id, target: config.target, ...payload };
    // 書きかけを wait に読ませないよう、別名で書いてから rename する
    const tmp = join(outboxDir(config.target), `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
    renameSync(tmp, join(outboxDir(config.target), `${id}.json`));
    return { id };
  });

  // ページが 500ms ごとに呼ぶ。差し替え要求・ファイルの外での変更・wait の有無・未受領の指示の数を返す
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

  // ⌘W。webview-bun は run() を外から止める口を公開していないため、後片付けをしてからプロセスごと終える
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

  // 窓が開いていなくても、溜まっている指示があれば先に渡す
  const queued = takeInstruction(target);
  if (queued !== null) {
    process.stdout.write(queued);
    return 0;
  }
  if (findWindowPid(target) === null) {
    console.error(M.notOpen(target));
    return 1;
  }

  // 窓に「AI が待っている」と出すための印。同じ名前の wait が複数あっても、どれか 1 つが生きていれば待っている扱い
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

// いちばん古い指示を 1 つ取り出す。複数の wait が同時に取りに来ても 1 つの指示は 1 つの wait にだけ渡るよう、
// rename で自分のものにしてから読む
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

// pid ファイルが指すプロセスが今も textboard のその名前の窓かを確かめる。古い pid ファイルは消す
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

// ---------------- 状態ディレクトリ ----------------

// 他ユーザーが先に作ったディレクトリや symlink を使うと、要求ファイルの差し込みや書き込み先のすり替えができてしまう
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

// boards/ と acks/ に、誰にも読まれないまま残った古いファイルを掃除する(outbox は wait が受け取るまで残す)
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

export function sidecarPath(path: string) {
  return path + SIDECAR_SUFFIX;
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
