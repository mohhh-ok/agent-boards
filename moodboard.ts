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
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyLang, createI18n, type Lang } from "./lib/lang.ts";
import { createWindowHost, isValidTargetName } from "./lib/windows.ts";

// 状態ディレクトリ(/tmp/moodboard-<uid>/)・ロック・pid・差し替え要求・ack・古いファイルの掃除は lib/windows.ts。
// board(見出し・説明・パス・ラベル)の置き場 boards/ の後始末の方針:
//   - 表示ごとに <rid>.json を書き、ページの __moodboardLoad(rid) が読んだ直後に消す(runWindow 内)
//   - 表示確認(ack)がタイムアウトした場合、窓がまだ受け取っていないときだけ消す(discardUnreceived)。
//     窓が既に受け取って読み込み中の可能性があるときは消さず、窓自身の __moodboardLoad に任せる
//   - ウィンドウが閉じた時点でも最初の board が一度も読まれていなければ runWindow の終わりで消す
//   - 上記のどれにも当たらず残ったもの(窓が本当に死んでいた等)は、次回ランチャー起動時に
//     sweepStaleFiles() が古いものとして掃除する(acks/ も同様)
const scriptPath = fileURLToPath(import.meta.url);
const htmlPath = resolve(dirname(scriptPath), "moodboard.html");
const host = createWindowHost({ name: "moodboard", scriptPath, htmlPath });

type WindowConfig = { target: string | null; url: string; requestId: string };
type Ack = { pid: number; failedPaths: string[] };

// board JSON の型。詳細な形式・検証ルールは docs/moodboard.md の「Board JSON」節を正とする。
type BoardItem = { path: string; label?: string };
type BoardSection = { title?: string; note?: string; items: BoardItem[] };
type Board = { sections: BoardSection[] };

const SECTION_KEYS = new Set(["title", "note", "items"]);
const ITEM_KEYS = new Set(["path", "label"]);

// ---------------- 表示言語 ----------------
// 決め方の正は docs/moodboard.md の「Language」節(lib/lang.ts): --lang > MOODBOARD_LANG > macOS の言語設定。ja 以外は en。
// $LANG は見ない(エージェントやターミナルは macOS が日本語でも en_US.UTF-8 にしていることが多い)。
// 窓(moodboard.html)には URL の lang で同じ言語を渡す。成功時の `opened ...` 行はスクリプト向けなので訳さない
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

const i18n = createI18n(MESSAGES);

await main(process.argv.slice(2));

async function main(argv: string[]) {
  if (argv[0] === "--window") {
    host.ensureStateDir(badStateDir);
    runWindow(JSON.parse(argv[1]) as WindowConfig);
    return;
  }

  argv = applyLang({ argv, envName: "MOODBOARD_LANG", i18n, onBad: (source, value) => usageError(i18n.M.badLang(source, value)) });
  host.ensureStateDir(badStateDir);
  if (argv[0] === "--close") {
    process.exit(host.closeTarget(requireTargetName(argv[1]), i18n.M.notOpen));
  }
  if (argv[0] === "--list") {
    host.listTargets();
    return;
  }

  // 窓を開く/差し替えるたびに、boards/ と acks/ に残っている古いファイルを掃除する
  host.sweepStaleFiles();

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
    if (rest.length !== 2) usageError(i18n.M.jsonTakesOnePath);
    return readBoardJson(rest[1]);
  }
  if (rest.includes("--json")) usageError(i18n.M.jsonWithPaths);
  if (rest.length === 0) usageError(i18n.M.noPaths);
  return boardFromPaths(rest);
}

// 既存の「パスを並べるだけ」の呼び方は、見出しなし・ラベルなしの 1 セクションに変換して同じ経路で渡す
function boardFromPaths(paths: string[]): Board {
  return { sections: [{ items: paths.map((p) => ({ path: resolve(p) })) }] };
}

function readBoardJson(jsonPath: string): Board {
  const absJsonPath = resolve(jsonPath);
  if (!existsSync(absJsonPath)) fatal(i18n.M.jsonNotFound(jsonPath));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absJsonPath, "utf8"));
  } catch (error) {
    fatal(i18n.M.jsonInvalid((error as Error).message));
  }
  return validateBoard(raw, dirname(absJsonPath));
}

// 未知のキー・型違い・空配列を全部拒否する。相対パスは baseDir(JSON ファイルのディレクトリ)基準で
// 絶対パスに解決する(存在チェックは呼び出し元の checkedBoard で行う)
function validateBoard(raw: unknown, baseDir: string): Board {
  const obj = asRecord(raw, "board JSON");
  const unknown = Object.keys(obj).filter((k) => k !== "sections");
  if (unknown.length > 0) fatal(i18n.M.unknownKeys("board JSON", unknown.join(", ")));
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    fatal(i18n.M.nonEmptyArray("board JSON sections"));
  }
  const sections = obj.sections.map((s, i) => validateSection(s, i, baseDir));
  return { sections };
}

function validateSection(raw: unknown, index: number, baseDir: string): BoardSection {
  const prefix = `sections[${index}]`;
  const obj = asRecord(raw, prefix);
  const unknown = Object.keys(obj).filter((k) => !SECTION_KEYS.has(k));
  if (unknown.length > 0) fatal(i18n.M.unknownKeys(prefix, unknown.join(", ")));
  const title = optionalString(obj, "title", `${prefix}.title`);
  const note = optionalString(obj, "note", `${prefix}.note`);
  if (!Array.isArray(obj.items) || obj.items.length === 0) {
    fatal(i18n.M.nonEmptyArray(`${prefix}.items`));
  }
  const items = obj.items.map((it, j) => validateItem(it, index, j, baseDir));
  return { title, note, items };
}

function validateItem(raw: unknown, sectionIndex: number, itemIndex: number, baseDir: string): BoardItem {
  const prefix = `sections[${sectionIndex}].items[${itemIndex}]`;
  const obj = asRecord(raw, prefix);
  const unknown = Object.keys(obj).filter((k) => !ITEM_KEYS.has(k));
  if (unknown.length > 0) fatal(i18n.M.unknownKeys(prefix, unknown.join(", ")));
  if (typeof obj.path !== "string" || obj.path.length === 0) {
    fatal(i18n.M.nonEmptyString(`${prefix}.path`));
  }
  const label = optionalString(obj, "label", `${prefix}.label`);
  return { path: resolve(baseDir, obj.path), label };
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fatal(i18n.M.mustBeObject(label));
  return raw as Record<string, unknown>;
}

function optionalString(obj: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!(key in obj)) return undefined;
  if (typeof obj[key] !== "string") fatal(i18n.M.mustBeString(label));
  return obj[key] as string;
}

// 型・構造の検証を通った board に対して、パスの実在だけを確かめる(JSON・パス列挙の両方で共通)
function checkedBoard(board: Board): Board {
  const missing = board.sections.flatMap((s) => s.items.map((it) => it.path)).filter((p) => !existsSync(p));
  if (missing.length > 0) fatal(i18n.M.missingPaths + "\n" + missing.join("\n"));
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
  const lock = await host.acquireTargetLock(target);
  if (!lock) {
    console.error(i18n.M.lockFailed(target, host.lockPath(target)));
    return 2;
  }
  try {
    return await showBoard({ target, board: request.board });
  } finally {
    host.releaseTargetLock(target);
  }
}

async function showBoard(request: { target: string | null; board: Board }): Promise<number> {
  const requestId = randomUUID();
  host.writeBoard(requestId, request.board);
  const url = host.buildUrl(requestId, i18n.lang);
  const label = request.target ?? "(名前なし)";
  const itemCount = countItems(request.board);
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
  const action = existingPid !== null ? "差し替え" : "新規";
  if (ack === null) {
    host.discardUnreceived({ target: request.target, requestId, replaced: existingPid !== null });
    console.error(i18n.M.notShown(request.target, existingPid !== null) + (logPath ? `\nlog: ${logPath}` : ""));
    return 2;
  }
  console.log(`opened target=${label} pid=${ack.pid} ${action} images=${itemCount}`);
  if (ack.failedPaths.length > 0) {
    console.error(i18n.M.failedItems + "\n" + ack.failedPaths.join("\n"));
    return 3;
  }
  return 0;
}

function runWindow(config: WindowConfig) {
  host.registerWindow(config.target);

  const webview = new Webview();
  webview.title = config.target ?? "moodboard";
  webview.size = { width: 1280, height: 900, hint: SizeHint.NONE };

  // run() 中は Bun のイベントループが止まるため、callback は同期 I/O だけで書く
  webview.bind("__moodboardLoad", (rid: string) => host.takeBoard<Board>(rid));
  webview.bind("__moodboardReady", (requestId: string, failedPaths: string[]) => {
    host.writeAck(requestId, { pid: process.pid, failedPaths } satisfies Ack);
  });
  webview.bind("__moodboardPoll", () => (config.target === null ? null : host.takeReplaceRequest(config.target)));

  // ⌘W / Ctrl+W。webview-bun は run() を外から止める口(terminate)を公開していないため、
  // 窓を閉じたときと同じ後片付けをしてからプロセスごと終える
  webview.bind("__moodboardClose", () => {
    host.cleanupWindow(config);
    process.exit(0);
  });

  webview.navigate(config.url);
  webview.run(); // ウィンドウを閉じると返る
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
