import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLang, createI18n, langFromAppleLanguages } from "../lib/lang.ts";
import { STALE_FILE_MS, createWindowHost, isValidTargetName } from "../lib/windows.ts";

describe("lang", () => {
  const table = { ja: { hello: "こんにちは" }, en: { hello: "hello" } };
  const bad = (source: string, value: string): never => {
    throw new Error(`bad ${source}=${value}`);
  };
  const saved = process.env.TEST_BOARD_LANG;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_BOARD_LANG;
    else process.env.TEST_BOARD_LANG = saved;
  });

  test("reads the first entry of AppleLanguages", () => {
    expect(langFromAppleLanguages('(\n    "ja-JP",\n    en\n)')).toBe("ja");
    expect(langFromAppleLanguages("(\n    en,\n    ja\n)")).toBe("en");
    expect(langFromAppleLanguages("")).toBe("en");
  });

  test("--lang wins over the environment variable and is removed from argv", () => {
    process.env.TEST_BOARD_LANG = "broken";
    const i18n = createI18n(table);
    const rest = applyLang({ argv: ["--lang", "ja", "--list"], envName: "TEST_BOARD_LANG", i18n, onBad: bad, detect: () => "en" });
    expect(rest).toEqual(["--list"]);
    expect(i18n.lang).toBe("ja");
    expect(i18n.M.hello).toBe("こんにちは");
  });

  test("the environment variable wins over the system language", () => {
    process.env.TEST_BOARD_LANG = "en";
    const i18n = createI18n(table);
    applyLang({ argv: [], envName: "TEST_BOARD_LANG", i18n, onBad: bad, detect: () => "ja" });
    expect(i18n.lang).toBe("en");
  });

  test("a bad value is reported while the system language is set", () => {
    const i18n = createI18n(table);
    let seenLang = "";
    const onBad = (source: string, value: string): never => {
      seenLang = i18n.lang;
      throw new Error(`${source}=${value}`);
    };
    expect(() => applyLang({ argv: ["--lang", "fr"], envName: "TEST_BOARD_LANG", i18n, onBad, detect: () => "ja" })).toThrow("--lang=fr");
    expect(seenLang).toBe("ja");
  });
});

describe("windows", () => {
  let dir: string;
  let host: ReturnType<typeof createWindowHost>;
  const fail = (path: string): never => {
    throw new Error(`bad state dir ${path}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-boards-test-"));
    host = createWindowHost({ name: "testboard", scriptPath: "/nowhere/testboard.ts", htmlPath: "/a b/testboard.html", stateDir: join(dir, "state"), extraDirs: ["outbox"] });
    host.ensureStateDir(fail);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("creates a private state directory with its subdirectories", () => {
    expect((statSync(host.stateDir).mode & 0o777).toString(8)).toBe("700");
    for (const sub of ["targets", "acks", "logs", "boards", "outbox"]) expect(existsSync(join(host.stateDir, sub))).toBe(true);
  });

  test("refuses a state directory that others can read", () => {
    const shared = join(dir, "shared");
    const other = createWindowHost({ name: "x", scriptPath: "/x.ts", htmlPath: "/x.html", stateDir: shared });
    require("node:fs").mkdirSync(shared, { mode: 0o755 });
    require("node:fs").chmodSync(shared, 0o755);
    expect(() => other.ensureStateDir(fail)).toThrow("bad state dir");
  });

  test("target names", () => {
    expect(isValidTargetName("abc-1.2_x")).toBe(true);
    expect(isValidTargetName("a/b")).toBe(false);
    expect(isValidTargetName("")).toBe(false);
    expect(isValidTargetName(undefined)).toBe(false);
  });

  test("the URL carries only the request id and the language", () => {
    expect(host.buildUrl("rid1", "ja")).toBe("file:///a%20b/testboard.html?rid=rid1&lang=ja");
  });

  test("a board is deleted once taken", () => {
    host.writeBoard("r1", { path: "/x" });
    expect(host.takeBoard<{ path: string }>("r1")).toEqual({ path: "/x" });
    expect(existsSync(host.boardPath("r1"))).toBe(false);
  });

  test("a replace request is taken only by the window it was addressed to", () => {
    host.writeReplaceRequest("t", { requestId: "r", url: "file:///u", pid: process.pid });
    expect(host.takeReplaceRequest("t")).toBe("file:///u");
    expect(host.takeReplaceRequest("t")).toBeNull();
    host.writeReplaceRequest("t", { requestId: "r", url: "file:///u", pid: process.pid + 1 });
    expect(host.takeReplaceRequest("t")).toBeNull();
    expect(existsSync(host.requestPath("t"))).toBe(false);
  });

  test("locks are exclusive until released", async () => {
    expect(await host.acquireTargetLock("t")).toBe(true);
    expect(existsSync(host.lockPath("t"))).toBe(true);
    host.releaseTargetLock("t");
    expect(await host.acquireTargetLock("t")).toBe(true);
  });

  test("a pid that is not this command's window is forgotten", () => {
    writeFileSync(host.pidPath("t"), String(process.pid));
    expect(host.findWindowPid("t")).toBeNull();
    expect(existsSync(host.pidPath("t"))).toBe(false);
  });

  test("ack is written by the window and read once by the launcher", async () => {
    host.writeAck("r", { pid: 42 });
    expect(await host.waitForAck<{ pid: number }>({ requestId: "r", child: null })).toEqual({ pid: 42 });
    expect(existsSync(host.ackPath("r"))).toBe(false);
  });

  test("registering and cleaning up a window", () => {
    writeFileSync(host.requestPath("t"), "{}");
    host.registerWindow("t");
    expect(readFileSync(host.pidPath("t"), "utf8")).toBe(String(process.pid));
    expect(existsSync(host.requestPath("t"))).toBe(false);
    host.writeBoard("first", {});
    host.cleanupWindow({ target: "t", requestId: "first" });
    expect(existsSync(host.pidPath("t"))).toBe(false);
    expect(existsSync(host.boardPath("first"))).toBe(false);
  });

  test("after a timeout, a replace request already taken by the window keeps its board", () => {
    host.writeBoard("r", {});
    host.discardUnreceived({ target: "t", requestId: "r", replaced: true });
    expect(existsSync(host.boardPath("r"))).toBe(true);

    host.writeReplaceRequest("t", { requestId: "r", url: "u", pid: 1 });
    host.discardUnreceived({ target: "t", requestId: "r", replaced: true });
    expect(existsSync(host.boardPath("r"))).toBe(false);
    expect(existsSync(host.requestPath("t"))).toBe(false);

    host.writeBoard("n", {});
    host.discardUnreceived({ target: null, requestId: "n", replaced: false });
    expect(existsSync(host.boardPath("n"))).toBe(false);
  });

  test("sweeping removes only old boards and acks", () => {
    host.writeBoard("old", {});
    host.writeBoard("new", {});
    const past = (Date.now() - STALE_FILE_MS - 1000) / 1000;
    utimesSync(host.boardPath("old"), past, past);
    host.sweepStaleFiles();
    expect(existsSync(host.boardPath("old"))).toBe(false);
    expect(existsSync(host.boardPath("new"))).toBe(true);
  });
});
