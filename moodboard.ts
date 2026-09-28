#!/usr/bin/env bun
// moodboard.html を webview-bun のウィンドウで開くランチャー。サーバ・ブラウザ不要。
// file:// のクエリも別ディレクトリの画像読み込みも WKWebView 上で通ることは実測済み。
//
// 使い方:
//   moodboard [--target <名前>] <画像/動画/音声パス...>   開く。同名ウィンドウがあれば中身を差し替える
//   moodboard [--target <名前>] --json <board.json>       セクション分割・ラベル付きの board を開く
//   moodboard --close <名前>                     その名前のウィンドウだけ閉じる
//   moodboard --list                             開いている名前付きウィンドウを出す
// どの形も先頭に --lang ja|en を置ける(表示言語。下の「表示言語」節)
//
// パス列挙は「見出しなし・ラベルなしの 1 セクション」の board に変換され、--json と同じ経路(下記)で渡る。
// board(見出し・説明・パス・ラベル)は URL クエリに載せない。/tmp/moodboard-<uid>/boards/<rid>.json に
// 書き、URL には rid だけを渡してページ側の __moodboardLoad(rid) に読ませる(長い note や大量のパスが
// URL 長の上限に当たらないようにするため)。
//
// ランチャーはウィンドウ用の子プロセスを別セッション(detached)で起動し、ページが全アイテムの読み込みを
// 終えた通知(ack)を受けてから終了する。終了コードで「本当に開けたか」が分かる:
//   0 = 表示済み / 1 = 引数・board JSON・パスの誤り / 2 = 時間内に表示されなかった / 3 = 読み込めないアイテムがあった
//
// 同名ウィンドウへの差し替えは、ページ側が bind した __moodboardPoll を定期的に呼び、
// ランチャーが置いた要求ファイルを受け取って location.replace する。webview.run() の間は
// Bun のイベントループが回らないため、Bun 側から能動的には呼べない。
import { Webview, SizeHint } from "webview-bun";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// TMPDIR はエージェントの実行環境ごとに違うことがあるため、同じユーザーの全プロセスで共有できる
// 固定の場所に置く。/tmp は他ユーザーも書けるので、uid 付きの 0700 ディレクトリにして持ち主を確かめる
if (process.getuid === undefined) throw new Error("moodboard supports POSIX environments only");
const USER_ID = process.getuid();
const STATE_DIR = `/tmp/moodboard-${USER_ID}`;
const TARGETS_DIR = join(STATE_DIR, "targets");
const ACKS_DIR = join(STATE_DIR, "acks");
const LOGS_DIR = join(STATE_DIR, "logs");
// board(見出し・説明・パス・ラベル)の置き場。後始末の方針:
//   - 表示ごとに <rid>.json を書き、ページの __moodboardLoad(rid) が読んだ直後に消す(runWindow 内)
//   - 表示確認(ack)がタイムアウトした場合、showBoard は「窓がまだ受け取っていない」ときだけそのファイルを
//     消す(差し替え要求なら、request ファイルがまだ残っている = __moodboardPoll がまだ拾っていない、が
//     判定基準。新規窓は request ファイルという概念が無いので無条件)。窓が既に受け取って読み込み中の
//     可能性があるときは消さず、窓自身の __moodboardLoad に任せる。ここで消してしまうと、窓の読み込みが
//     このタイムアウトより少し遅れただけのケースで board が無くなって読み込みに失敗し、空表示に固着した
//     まま ack も二度と来なくなる(実害。詳細は showBoard 内のコメント参照)
//   - ウィンドウが閉じた時点でも最初の board が一度も読まれていなければ runWindow の終わりで消す
//     (差し替えで読み込んだ後続の board は、その都度 __moodboardLoad が読み終えた時点で消えている)
//   - 上記のどれにも当たらず残ったもの(窓が本当に死んでいた等)は、次回ランチャー起動時に
//     sweepStaleFiles() が古いものとして掃除する(acks/ も同様)
const BOARDS_DIR = join(STATE_DIR, "boards");
const READY_TIMEOUT_MS = 20_000;
const ACK_POLL_MS = 100;
// 前の起動が受領待ち(最大 READY_TIMEOUT_MS)を終えるまで待てる長さ
const LOCK_WAIT_MS = READY_TIMEOUT_MS + 5_000;
// boards/ と acks/ の掃除しきい値。要求は通常 READY_TIMEOUT_MS 以内に決着する(受領されて
// __moodboardLoad/__moodboardReady が消すか、タイムアウト処理が消す)。この数倍より古く残っている
// ファイルは、窓のクラッシュ等で誰にも読まれる見込みがないとみなして良い
const STALE_FILE_MS = READY_TIMEOUT_MS * 5;
const TARGET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "moodboard.html");

type WindowConfig = { target: string | null; url: string; requestId: string };
type Ack = { pid: number; failedPaths: string[] };

// board JSON の型。詳細な形式・検証ルールは README.md の「Board JSON」節を正とする。
type BoardItem = { path: string; label?: string };
type BoardSection = { title?: string; note?: string; items: BoardItem[] };
type Board = { sections: BoardSection[] };

const SECTION_KEYS = new Set(["title", "note", "items"]);
const ITEM_KEYS = new Set(["path", "label"]);

// ---------------- 表示言語 ----------------
// 決め方の正は README.md の「Language」節: --lang > MOODBOARD_LANG > macOS の言語設定。ja 以外は en。
// $LANG は見ない(エージェントやターミナルは macOS が日本語でも en_US.UTF-8 にしていることが多い)。
// 窓(moodboard.html)には URL の lang で同じ言語を渡す。成功時の `opened ...` 行はスクリプト向けなので訳さない
type Lang = "ja" | "en";
const MESSAGES = {
  ja: {
    usage: "usage: moodboard [--lang ja|en] [--target <名前>] <画像/動画/音声パス...>\n       moodboard [--lang ja|en] [--target <名前>] --json <board.json>\n       moodboard [--lang ja|en] --close <名前>\n       moodboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} は ja か en で指定してください: ${value}`,
    badTargetName: "名前は英数字と . _ - だけで指定してください",
    jsonTakesOnePath: "--json は board JSON ファイルのパスを1つだけ取ります",
    jsonWithPaths: "--json とパス列挙は併用できません",
    noPaths: "画像/動画/音声パスがありません",
    jsonNotFound: (path: string) => `--json のファイルが見つかりません: ${path}`,
    jsonInvalid: (detail: string) => `--json の内容が不正な JSON です: ${detail}`,
    unknownKeys: (where: string, keys: string) => `${where} に未知のキーがあります: ${keys}`,
    nonEmptyArray: (where: string) => `${where} は空でない配列である必要があります`,
    nonEmptyString: (where: string) => `${where} は空でない string である必要があります`,
    mustBeObject: (where: string) => `${where} はオブジェクトである必要があります`,
    mustBeString: (where: string) => `${where} は string である必要があります`,
    missingPaths: "存在しないパス:",
    lockFailed: (target: string, path: string) => `target=${target} のロックを取れませんでした (${path})`,
    notShown: (target: string | null, replaced: boolean) =>
      `表示を確認できませんでした (target=${target ?? "(名前なし)"}, ${replaced ? "差し替え" : "新規"})`,
    failedItems: "読み込めなかったアイテム:",
    notOpen: (target: string) => `target=${target} のウィンドウは開いていません`,
    badStateDir: (dir: string) => `${dir} が自分の所有する権限 700 のディレクトリではありません。中身を確かめて削除してください`,
  },
  en: {
    usage: "usage: moodboard [--lang ja|en] [--target <name>] <image/video/audio paths...>\n       moodboard [--lang ja|en] [--target <name>] --json <board.json>\n       moodboard [--lang ja|en] --close <name>\n       moodboard [--lang ja|en] --list",
    badLang: (source: string, value: string) => `${source} must be ja or en: ${value}`,
    badTargetName: "Names may use only letters, digits and . _ -",
    jsonTakesOnePath: "--json takes exactly one board JSON file path",
    jsonWithPaths: "--json cannot be combined with a list of paths",
    noPaths: "No image/video/audio paths given",
    jsonNotFound: (path: string) => `--json file not found: ${path}`,
    jsonInvalid: (detail: string) => `--json file is not valid JSON: ${detail}`,
    unknownKeys: (where: string, keys: string) => `${where} has unknown keys: ${keys}`,
    nonEmptyArray: (where: string) => `${where} must be a non-empty array`,
    nonEmptyString: (where: string) => `${where} must be a non-empty string`,
    mustBeObject: (where: string) => `${where} must be an object`,
    mustBeString: (where: string) => `${where} must be a string`,
    missingPaths: "Paths that do not exist:",
    lockFailed: (target: string, path: string) => `Could not take the lock for target=${target} (${path})`,
    notShown: (target: string | null, replaced: boolean) =>
      `Could not confirm that the window showed the files (target=${target ?? "(unnamed)"}, ${replaced ? "replaced" : "new window"})`,
    failedItems: "Items that failed to load:",
    notOpen: (target: string) => `No window is open for target=${target}`,
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

await main(process.argv.slice(2));

async function main(argv: string[]) {
  if (argv[0] === "--window") {
    ensureStateDir();
    runWindow(JSON.parse(argv[1]) as WindowConfig);
    return;
  }

  // --lang があれば MOODBOARD_LANG は見ない(不正な値が残っていても --lang で上書きできるように)
  setLang(systemLang());
  const envLang = process.env.MOODBOARD_LANG;
  if (argv[0] === "--lang") {
    setLang(parseLang(argv[1], "--lang"));
    argv = argv.slice(2);
  } else if (envLang !== undefined && envLang !== "") {
    setLang(parseLang(envLang, "MOODBOARD_LANG"));
  }
  ensureStateDir();
  if (argv[0] === "--close") {
    process.exit(closeTarget(requireTargetName(argv[1])));
  }
  if (argv[0] === "--list") {
    listTargets();
    return;
  }

  // 窓を開く/差し替えるたびに、boards/ と acks/ に残っている古いファイルを掃除する
  sweepStaleFiles();

  let target: string | null = null;
  let rest = argv;
  if (argv[0] === "--target") {
    target = requireTargetName(argv[1]);
    rest = argv.slice(2);
  }
  const board = checkedBoard(buildBoard(rest));
  process.exit(await openBoard({ target, board }));
}

// ---------------- board の組み立て・検証 ----------------

function buildBoard(rest: string[]): Board {
  if (rest[0] === "--json") {
    if (rest.length !== 2) usageError(M.jsonTakesOnePath);
    return readBoardJson(rest[1]);
  }
  if (rest.includes("--json")) usageError(M.jsonWithPaths);
  if (rest.length === 0) usageError(M.noPaths);
  return boardFromPaths(rest);
}

// 既存の「パスを並べるだけ」の呼び方は、見出しなし・ラベルなしの 1 セクションに変換して同じ経路で渡す
function boardFromPaths(paths: string[]): Board {
  return { sections: [{ items: paths.map((p) => ({ path: resolve(p) })) }] };
}

function readBoardJson(jsonPath: string): Board {
  const absJsonPath = resolve(jsonPath);
  if (!existsSync(absJsonPath)) fatal(M.jsonNotFound(jsonPath));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absJsonPath, "utf8"));
  } catch (error) {
    fatal(M.jsonInvalid((error as Error).message));
  }
  return validateBoard(raw, dirname(absJsonPath));
}

// 未知のキー・型違い・空配列を全部拒否する。相対パスは baseDir(JSON ファイルのディレクトリ)基準で
// 絶対パスに解決する(存在チェックは呼び出し元の checkedBoard で行う)
function validateBoard(raw: unknown, baseDir: string): Board {
  const obj = asRecord(raw, "board JSON");
  const unknown = Object.keys(obj).filter((k) => k !== "sections");
  if (unknown.length > 0) fatal(M.unknownKeys("board JSON", unknown.join(", ")));
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    fatal(M.nonEmptyArray("board JSON sections"));
  }
  const sections = obj.sections.map((s, i) => validateSection(s, i, baseDir));
  return { sections };
}

function validateSection(raw: unknown, index: number, baseDir: string): BoardSection {
  const prefix = `sections[${index}]`;
  const obj = asRecord(raw, prefix);
  const unknown = Object.keys(obj).filter((k) => !SECTION_KEYS.has(k));
  if (unknown.length > 0) fatal(M.unknownKeys(prefix, unknown.join(", ")));
  const title = optionalString(obj, "title", `${prefix}.title`);
  const note = optionalString(obj, "note", `${prefix}.note`);
  if (!Array.isArray(obj.items) || obj.items.length === 0) {
    fatal(M.nonEmptyArray(`${prefix}.items`));
  }
  const items = obj.items.map((it, j) => validateItem(it, index, j, baseDir));
  return { title, note, items };
}

function validateItem(raw: unknown, sectionIndex: number, itemIndex: number, baseDir: string): BoardItem {
  const prefix = `sections[${sectionIndex}].items[${itemIndex}]`;
  const obj = asRecord(raw, prefix);
  const unknown = Object.keys(obj).filter((k) => !ITEM_KEYS.has(k));
  if (unknown.length > 0) fatal(M.unknownKeys(prefix, unknown.join(", ")));
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    fatal(M.nonEmptyString(`${prefix}.path`));
  }
  const label = optionalString(obj, "label", `${prefix}.label`);
  return { path: resolve(baseDir, obj.path), label };
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fatal(M.mustBeObject(label));
  return raw as Record<string, unknown>;
}

function optionalString(obj: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!(key in obj)) return undefined;
  if (typeof obj[key] !== "string") fatal(M.mustBeString(label));
  return obj[key] as string;
}

// 型・構造の検証を通った board に対して、パスの実在だけを確かめる(JSON・パス列挙の両方で共通)
function checkedBoard(board: Board): Board {
  const missing = board.sections.flatMap((s) => s.items.map((it) => it.path)).filter((p) => !existsSync(p));
  if (missing.length > 0) fatal(M.missingPaths + "\n" + missing.join("\n"));
  return board;
}

function countItems(board: Board): number {
  return board.sections.reduce((sum, s) => sum + s.items.length, 0);
}

// ---------------- ウィンドウの表示 ----------------

async function openBoard(request: { target: string | null; board: Board }): Promise<number> {
  if (request.target === null) return await showBoard({ target: null, board: request.board });

  // 同じ名前への起動が重なると、両方が「未オープン」と判断して窓が 2 つ開き、片方が pid ファイルから
  // 外れて閉じられなくなる。名前ごとのロックで確認〜受領待ちを直列にする
  const target = request.target;
  const lock = await acquireTargetLock(target);
  if (!lock) {
    console.error(M.lockFailed(target, lockPath(target)));
    return 2;
  }
  try {
    return await showBoard({ target, board: request.board });
  } finally {
    rmSync(lockPath(target), { recursive: true, force: true });
  }
}

async function showBoard(request: { target: string | null; board: Board }): Promise<number> {
  const requestId = randomUUID();
  writeBoardFile(requestId, request.board);
  const url = buildUrl(requestId);
  const label = request.target ?? "(名前なし)";
  const itemCount = countItems(request.board);
  const existingPid = request.target === null ? null : findWindowPid(request.target);

  let child: ReturnType<typeof spawn> | null = null;
  let logPath: string | null = null;
  if (existingPid !== null && request.target !== null) {
    // 宛先 pid を入れておき、別の窓(同名で後から開いた窓)が古い要求を拾わないようにする
    writeFileSync(requestPath(request.target), JSON.stringify({ requestId, url, pid: existingPid }));
  } else {
    logPath = join(LOGS_DIR, `${requestId}.log`);
    const logFd = openSync(logPath, "a");
    const config: WindowConfig = { target: request.target, url, requestId };
    child = spawn(process.execPath, [scriptPath, "--window", JSON.stringify(config)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  }

  const ack = await waitForAck({ requestId, child });
  const action = existingPid !== null ? "差し替え" : "新規";
  if (ack === null) {
    // タイムアウト時の後始末は「窓がまだ受け取っていない」ときだけ行う。差し替え要求(request
    // ファイル)は __moodboardPoll が読んだ瞬間に窓自身が消すため、まだ存在していれば窓は
    // まだ location.replace を始めておらず、request・board とも誰にも読まれる見込みがない
    // (安全に消せる)。既に消えている(=窓が受け取り済みで読み込み中の可能性がある)場合、
    // ここで board まで消すと、窓の読み込みがこのタイムアウトより少し遅れただけのケースで
    // __moodboardLoad が失敗し、空表示に固着したまま ack も二度と来なくなる(実害)。その場合は
    // 窓自身の __moodboardLoad が読み終え次第 board を消すのに任せ、本当に窓が死んでいた場合の
    // 後始末は次回起動時の sweepStaleFiles() に任せる。新規窓(request ファイルの概念が無い)は
    // 従来どおりここで board を消す
    if (existingPid !== null && request.target !== null) {
      if (existsSync(requestPath(request.target))) {
        rmSync(requestPath(request.target), { force: true });
        rmSync(boardPath(requestId), { force: true });
      }
    } else {
      rmSync(boardPath(requestId), { force: true });
    }
    console.error(M.notShown(request.target, existingPid !== null) + (logPath ? `\nlog: ${logPath}` : ""));
    return 2;
  }
  console.log(`opened target=${label} pid=${ack.pid} ${action} images=${itemCount}`);
  if (ack.failedPaths.length > 0) {
    console.error(M.failedItems + "\n" + ack.failedPaths.join("\n"));
    return 3;
  }
  return 0;
}

async function waitForAck(params: { requestId: string; child: ReturnType<typeof spawn> | null }): Promise<Ack | null> {
  const path = ackPath(params.requestId);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const ack = JSON.parse(readFileSync(path, "utf8")) as Ack;
      rmSync(path);
      return ack;
    }
    if (params.child !== null && params.child.exitCode !== null) return null;
    await Bun.sleep(ACK_POLL_MS);
  }
  return null;
}

function runWindow(config: WindowConfig) {
  if (config.target !== null) {
    writeFileSync(pidPath(config.target), String(process.pid));
    // 前の窓宛てに書かれたまま受け取られなかった要求を消す
    rmSync(requestPath(config.target), { force: true });
  }

  const webview = new Webview();
  webview.title = config.target ?? "moodboard";
  webview.size = { width: 1280, height: 900, hint: SizeHint.NONE };

  // run() 中は Bun のイベントループが止まるため、callback は同期 I/O だけで書く
  webview.bind("__moodboardLoad", (rid: string) => {
    const path = boardPath(rid);
    const board = JSON.parse(readFileSync(path, "utf8"));
    rmSync(path, { force: true }); // 読み終えたら即消す(boards/ を溜めない)
    return board;
  });
  webview.bind("__moodboardReady", (requestId: string, failedPaths: string[]) => {
    writeFileSync(ackPath(requestId), JSON.stringify({ pid: process.pid, failedPaths } satisfies Ack));
  });
  webview.bind("__moodboardPoll", () => {
    if (config.target === null) return null;
    const path = requestPath(config.target);
    if (!existsSync(path)) return null;
    const request = JSON.parse(readFileSync(path, "utf8")) as { url: string; pid: number };
    rmSync(path);
    return request.pid === process.pid ? request.url : null;
  });

  // ⌘W / Ctrl+W。webview-bun は run() を外から止める口(terminate)を公開していないため、
  // 窓を閉じたときと同じ後片付けをしてからプロセスごと終える
  webview.bind("__moodboardClose", () => {
    cleanupWindow(config);
    process.exit(0);
  });

  webview.navigate(config.url);
  webview.run(); // ウィンドウを閉じると返る
  cleanupWindow(config);
}

function cleanupWindow(config: WindowConfig) {
  // 最初の board が一度も読まれないまま(表示確認前に閉じられた等)窓が終わった場合の掃除。
  // 差し替えで読み込んだ board はそれぞれ __moodboardLoad が読み終えた時点で既に消えている
  rmSync(boardPath(config.requestId), { force: true });

  if (config.target !== null && readPid(config.target) === process.pid) rmSync(pidPath(config.target));
}

function closeTarget(target: string): number {
  const pid = findWindowPid(target);
  if (pid === null) {
    console.error(M.notOpen(target));
    return 1;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    // 確認から kill までの間に窓が閉じられた場合。閉じている状態は同じなので成功として扱う
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

// pid ファイルが指すプロセスが今も moodboard のウィンドウかを確かめる。古い pid ファイルは消す
function findWindowPid(target: string): number | null {
  const pid = readPid(target);
  if (pid === null) return null;
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  const args = ps.stdout.trim();
  // pid が別の名前の窓に再利用されていることがあるので、引数の target まで照合する
  const isThisTarget = args.includes(scriptPath) && args.includes("--window") && args.includes(`"target":"${target}"`);
  if (ps.status === 0 && isThisTarget) return pid;
  rmSync(pidPath(target), { force: true });
  return null;
}

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
  for (const dir of [TARGETS_DIR, ACKS_DIR, LOGS_DIR, BOARDS_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// mkdir の原子性でロックを取る。持ち主が kill されて残ったロックは、待ち時間を超えていれば奪う
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

// ランチャー起動(窓を開く/差し替える呼び出し)のたびに、boards/ と acks/ に残っている古いファイルを
// 掃除する。通常はそれぞれの読み手(__moodboardLoad・waitForAck)が消すが、タイムアウト時に「窓が
// 受け取り済みなら board を消さない」方針(showBoard 参照)にしたぶん、窓が本当に死んでいた場合は
// 拾われずに残り続けるため、ここで一括して掃除する
function sweepStaleFiles(): void {
  const deadline = Date.now() - STALE_FILE_MS;
  for (const dir of [BOARDS_DIR, ACKS_DIR]) {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < deadline) rmSync(path, { force: true });
      } catch (error) {
        // 掃除中に他プロセス(その rid の本来の読み手)が読んで消した場合は無視する
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

// board(見出し・説明・パス・ラベル)は載せない。ページはこの rid を渡して __moodboardLoad(rid) を呼ぶ。
// lang は表示言語(ページが文字列表を選ぶ)
function buildUrl(requestId: string): string {
  return "file://" + htmlPath.split("/").map(encodeURIComponent).join("/") + "?rid=" + requestId + "&lang=" + lang;
}

function requireTargetName(name: string | undefined): string {
  if (name === undefined || !TARGET_NAME_PATTERN.test(name)) {
    usageError(M.badTargetName);
  }
  return name;
}

function usageError(message: string): never {
  fatal(`${message}\n${M.usage}`);
}

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
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

function ackPath(requestId: string) {
  return join(ACKS_DIR, `${requestId}.json`);
}

function boardPath(requestId: string) {
  return join(BOARDS_DIR, `${requestId}.json`);
}

function writeBoardFile(requestId: string, board: Board): void {
  writeFileSync(boardPath(requestId), JSON.stringify(board));
}
