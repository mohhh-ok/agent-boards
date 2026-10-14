import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReply, addUserMessage, markReceived, placeThreads, readThreads, rememberPlaces, threadState, threadsPath } from "../lib/threads.ts";
import { createOutbox } from "../lib/outbox.ts";
import { createWindowHost } from "../lib/windows.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-boards-threads-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("threads", () => {
  const report = "/reports/a.md";
  const section = { level: 2, text: "結果", occurrence: 0 };

  test("a first message starts a thread; later ones and replies join it", () => {
    const first = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q1" });
    expect(first.id).toMatch(/^t-[0-9a-f]{12}$/);
    expect(first.heading).toEqual(section);
    expect(addReply({ home: dir, threadId: first.id, text: "a1" })?.file).toBe(report);
    addUserMessage({ home: dir, reportPath: report, threadId: first.id, section, text: "q2" });
    const saved = readThreads(dir, report);
    expect(saved.file).toBe(report);
    expect(saved.threads).toHaveLength(1);
    expect(saved.threads[0].messages.map((m) => `${m.from}:${m.text}`)).toEqual(["user:q1", "ai:a1", "user:q2"]);
  });

  test("only the heading's level, text and occurrence are stored", () => {
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section: { ...section, id: "section-3" } as typeof section, text: "q" });
    expect(thread.heading).toEqual(section);
  });

  test("threads are kept per report, outside the report's directory", () => {
    addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q" });
    expect(threadsPath(dir, report).startsWith(join(dir, "threads"))).toBe(true);
    expect(readThreads(dir, "/reports/b.md").threads).toEqual([]);
    expect((readFileSync(threadsPath(dir, report), "utf8").match(/"file"/g) ?? []).length).toBe(1);
  });

  test("a reply to an unknown thread is refused", () => {
    expect(addReply({ home: dir, threadId: "t-000000000000", text: "a" })).toBeNull();
  });

  test("threads follow their heading by level, text and occurrence; others are orphans", () => {
    const thread = { id: "t-1", heading: { level: 3, text: "手法", occurrence: 1 }, messages: [] };
    const sections = [
      { id: "section-1", level: 3, text: "手法", occurrence: 0 },
      { id: "section-2", level: 2, text: "手法", occurrence: 0 },
      { id: "section-3", level: 3, text: "手法", occurrence: 1 },
    ];
    expect(placeThreads([thread], sections)[0].sectionId).toBe("section-3");
    // The first 手法 (h3) is still there, but it is another heading: the thread does not move onto it
    expect(placeThreads([thread], sections.slice(0, 2))[0].sectionId).toBeNull();
  });

  test("a thread started on a breakdown row keeps the row and follows it, not the heading", () => {
    const row = { level: 2, text: "内訳", occurrence: 0, row: { name: "A. カメラ本人認証", occurrence: 0 } };
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section: { ...row, id: "row-4" } as typeof row, text: "q" });
    expect(thread.heading).toEqual(row);
    const sections = [
      { id: "section-1", level: 2, text: "内訳", occurrence: 0 },
      { id: "row-2", level: 2, text: "内訳", occurrence: 0, row: { name: "B", occurrence: 0 } },
      { id: "row-3", level: 2, text: "内訳", occurrence: 0, row: { name: "A. カメラ本人認証", occurrence: 0 } },
    ];
    expect(placeThreads([thread], sections)[0].sectionId).toBe("row-3");
    // The row is gone: the conversation stays under its heading, marked as moved
    const gone = placeThreads([thread], sections.slice(0, 2))[0];
    expect(gone.sectionId).toBe("section-1");
    expect(gone.placement).toBe("moved");
    expect(placeThreads([thread], [])[0].sectionId).toBeNull();
    // A thread on the heading is not placed on its rows
    const onHeading = { id: "t-2", heading: { level: 2, text: "内訳", occurrence: 0 }, messages: [] };
    expect(placeThreads([onHeading], sections)[0].sectionId).toBe("section-1");
  });
});

describe("threads after the report is rewritten", () => {
  // The report of 2026-10-14: the heading's total changed and the row the conversation was on moved to another section
  const before = [
    { id: "section-1", level: 2, text: "項目ごとの合計", occurrence: 0 },
    { id: "row-2", level: 2, text: "項目ごとの合計", occurrence: 0, row: { name: "A. 事前承認", occurrence: 0 } },
    { id: "section-3", level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0 },
    { id: "row-4", level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0, row: { name: "L. 字幕のフォント選択", occurrence: 0 } },
    { id: "row-5", level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0, row: { name: "M. AI コンシェルジュのフローティング表示", occurrence: 0 } },
  ];
  const onRow = { id: "t-m", heading: { level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0, row: { name: "M. AI コンシェルジュのフローティング表示", occurrence: 0 } }, messages: [] };
  const onHeading = { id: "t-h", heading: { level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0 }, messages: [] };
  const onL = { id: "t-l", heading: { level: 2, text: "Phase 4 へ移したもの — 51 人日", occurrence: 0, row: { name: "L. 字幕のフォント選択", occurrence: 0 } }, messages: [] };

  test("a heading whose numbers changed keeps its conversations, and the place is reported as renamed", () => {
    const after = before.map((s) => ({ ...s, text: s.text.replace("51 人日", "49 人日") }));
    const [h, l] = placeThreads([onHeading, onL], after);
    expect(h.sectionId).toBe("section-3");
    expect(h.placement).toBe("renamed");
    expect(h.place).toEqual({ level: 2, text: "Phase 4 へ移したもの — 49 人日", occurrence: 0 });
    expect(l.sectionId).toBe("row-4");
    expect(l.place?.row?.name).toBe("L. 字幕のフォント選択");
  });

  test("a row that moved under another heading takes its conversation along", () => {
    const after = [
      ...before.slice(0, 2),
      { id: "row-3", level: 2, text: "項目ごとの合計", occurrence: 0, row: { name: "M. AI コンシェルジュのフローティング表示", occurrence: 0 } },
      { id: "section-4", level: 2, text: "Phase 4 へ移したもの — 49 人日", occurrence: 0 },
      { id: "row-5", level: 2, text: "Phase 4 へ移したもの — 49 人日", occurrence: 0, row: { name: "L. 字幕のフォント選択", occurrence: 0 } },
    ];
    const m = placeThreads([onRow], after)[0];
    expect(m.sectionId).toBe("row-3");
    expect(m.placement).toBe("renamed");
  });

  test("a row that was removed leaves its conversation under its heading, even when the heading's numbers changed", () => {
    const after = [before[0], before[1], { id: "section-3", level: 2, text: "Phase 4 へ移したもの — 49 人日", occurrence: 0 }];
    const m = placeThreads([onRow], after)[0];
    expect(m.sectionId).toBe("section-3");
    expect(m.placement).toBe("moved");
  });

  test("a heading with other words is not taken for the old one", () => {
    const after = [{ id: "section-1", level: 2, text: "Phase 5 の候補", occurrence: 0 }];
    expect(placeThreads([onHeading], after)[0].sectionId).toBeNull();
  });

  test("the new place is saved, so the thread follows the next edits too", () => {
    const report = "/reports/b.md";
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section: onRow.heading, text: "入れる話では" });
    const to = { level: 2, text: "項目ごとの合計", occurrence: 0, row: { name: "M. AI コンシェルジュのフローティング表示", occurrence: 0 } };
    rememberPlaces({ home: dir, reportPath: report, places: [{ id: thread.id, from: thread.heading, to }] });
    expect(readThreads(dir, report).threads[0].heading).toEqual(to);
    // A place saved from an old view does not overwrite a newer one
    rememberPlaces({ home: dir, reportPath: report, places: [{ id: thread.id, from: onRow.heading, to: onHeading.heading }] });
    expect(readThreads(dir, report).threads[0].heading).toEqual(to);
  });
});

describe("the sign that the AI got a message", () => {
  const report = "/reports/a.md";
  const section = { level: 2, text: "結果", occurrence: 0 };
  const stateOf = (id: string) => threadState(readThreads(dir, report).threads.find((t) => t.id === id)!);

  test("sent → received when wait hands it over → working through progress replies → gone with --done", () => {
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q1" });
    expect(stateOf(thread.id)).toBe("sent");
    expect(markReceived({ home: dir, threadId: thread.id, sentAt: thread.messages[0].at })).toBe(true);
    expect(stateOf(thread.id)).toBe("received");
    addReply({ home: dir, threadId: thread.id, text: "直します" });
    expect(stateOf(thread.id)).toBe("working");
    addReply({ home: dir, threadId: thread.id, text: "確かめています" });
    expect(stateOf(thread.id)).toBe("working");
    addReply({ home: dir, threadId: thread.id, text: "結果です", done: true });
    expect(stateOf(thread.id)).toBeNull();
    const next = addUserMessage({ home: dir, reportPath: report, threadId: thread.id, section, text: "q2" });
    expect(stateOf(thread.id)).toBe("sent");
    markReceived({ home: dir, threadId: thread.id, sentAt: next.messages[next.messages.length - 1].at });
    expect(stateOf(thread.id)).toBe("received");
  });

  test("a wait started after the AI took the message ends the work, even without --done", () => {
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q" });
    markReceived({ home: dir, threadId: thread.id, sentAt: thread.messages[0].at, now: new Date("2026-10-13T00:00:10Z") });
    addReply({ home: dir, threadId: thread.id, text: "結果です" });
    const saved = readThreads(dir, report).threads[0];
    // The wait that took it started before; a later one means the AI is done
    expect(threadState(saved, Date.parse("2026-10-13T00:00:09Z"))).toBe("working");
    expect(threadState(saved, Date.parse("2026-10-13T00:00:11Z"))).toBeNull();
    // The wait that took it can start in the same millisecond; that one does not end the work
    expect(threadState(saved, Date.parse("2026-10-13T00:00:10Z"))).toBe("working");
  });

  test("--done before anything was received changes nothing", () => {
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q" });
    addReply({ home: dir, threadId: thread.id, text: "a", done: true });
    expect(readThreads(dir, report).threads[0].messages[0].doneAt).toBeUndefined();
  });

  test("receiving an older message does not mark a newer one the AI has not taken", () => {
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q1", now: new Date("2026-10-13T00:00:00Z") });
    addUserMessage({ home: dir, reportPath: report, threadId: thread.id, section, text: "q2", now: new Date("2026-10-13T00:00:01Z") });
    markReceived({ home: dir, threadId: thread.id, sentAt: "2026-10-13T00:00:00.000Z" });
    expect(stateOf(thread.id)).toBe("sent");
  });

  test("an unknown thread or message is not marked, and a second wait keeps the first time", () => {
    expect(markReceived({ home: dir, threadId: "t-000000000000", sentAt: "x" })).toBe(false);
    const thread = addUserMessage({ home: dir, reportPath: report, threadId: null, section, text: "q" });
    expect(markReceived({ home: dir, threadId: thread.id, sentAt: "2000-01-01T00:00:00.000Z" })).toBe(false);
    const at = thread.messages[0].at;
    markReceived({ home: dir, threadId: thread.id, sentAt: at, now: new Date("2026-10-13T00:00:00Z") });
    markReceived({ home: dir, threadId: thread.id, sentAt: at, now: new Date("2026-10-13T00:05:00Z") });
    expect(readThreads(dir, report).threads[0].messages[0].receivedAt).toBe("2026-10-13T00:00:00.000Z");
  });
});

describe("outbox", () => {
  test("wait tells the caller what it took, after printing it", async () => {
    const host = createWindowHost({ name: "t", scriptPath: "/x.ts", htmlPath: "/x.html", stateDir: join(dir, "state"), extraDirs: ["outbox"] });
    host.ensureStateDir((d) => {
      throw new Error(d);
    });
    const outbox = createOutbox(host);
    outbox.send("w", { text: "a" });
    const taken: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const rc = await outbox.wait({
        args: ["--target", "w"],
        messages: { badTimeout: "", badTargetName: "", notOpen: () => "", windowClosed: () => "", waitTimeout: () => "" },
        usageError: (m) => {
          throw new Error(m);
        },
        isTargetName: (n): n is string => typeof n === "string",
        onTaken: (instruction) => taken.push(instruction),
      });
      expect(rc).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(taken.map((t) => JSON.parse(t).text)).toEqual(["a"]);
    expect(outbox.lastWaitStarted("w")).toBeGreaterThan(Date.now() - 5000);
    expect(outbox.lastWaitStarted("other")).toBeNull();
  });

  // Runs wait or watch with stdout captured
  async function receive(kind: "wait" | "watch", outbox: ReturnType<typeof createOutbox>) {
    const taken: string[] = [];
    let out = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = await outbox[kind]({
        args: ["--target", "w"],
        messages: { badTimeout: "", badTargetName: "", notOpen: () => "", windowClosed: () => "", waitTimeout: () => "" },
        usageError: (m) => {
          throw new Error(m);
        },
        isTargetName: (n): n is string => typeof n === "string",
        onTaken: (instruction) => taken.push(instruction),
      });
      return { rc, out, taken };
    } finally {
      process.stdout.write = write;
    }
  }

  test("an agent that comes back late gets every message queued meanwhile: wait prints them all, oldest first", async () => {
    const host = createWindowHost({ name: "t", scriptPath: "/x.ts", htmlPath: "/x.html", stateDir: join(dir, "state"), extraDirs: ["outbox"] });
    host.ensureStateDir((d) => {
      throw new Error(d);
    });
    const outbox = createOutbox(host);
    for (const text of ["だからへんじがでてないって", "いちじてきなへんじもでてない", "せっしょんなげろ"]) {
      outbox.send("w", { text });
      Bun.sleepSync(2);
    }
    const { rc, out, taken } = await receive("wait", outbox);
    expect(rc).toBe(0);
    expect((JSON.parse(out) as Array<{ text: string }>).map((m) => m.text)).toEqual(["だからへんじがでてないって", "いちじてきなへんじもでてない", "せっしょんなげろ"]);
    expect(taken).toHaveLength(3);
    expect(outbox.pendingIds("w")).toEqual([]);
  });

  test("watch prints each message as one line of JSON", async () => {
    const host = createWindowHost({ name: "t", scriptPath: "/x.ts", htmlPath: "/x.html", stateDir: join(dir, "state"), extraDirs: ["outbox"] });
    host.ensureStateDir((d) => {
      throw new Error(d);
    });
    const outbox = createOutbox(host);
    outbox.send("w", { text: "a\nb" });
    Bun.sleepSync(2);
    outbox.send("w", { text: "c" });
    // No window is open here, so watch hands over what was queued and ends
    const { rc, out, taken } = await receive("watch", outbox);
    expect(rc).toBe(0);
    const lines = out.split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l).text)).toEqual(["a\nb", "c"]);
    expect(taken).toHaveLength(2);
  });

  test("instructions are taken oldest first, once each", () => {
    const host = createWindowHost({ name: "t", scriptPath: "/x.ts", htmlPath: "/x.html", stateDir: join(dir, "state"), extraDirs: ["outbox"] });
    host.ensureStateDir((d) => {
      throw new Error(d);
    });
    const outbox = createOutbox(host);
    const a = outbox.send("w", { text: "a" });
    Bun.sleepSync(2); // ids start with the time in ms, so sends within the same ms have no defined order
    const b = outbox.send("w", { text: "b" });
    expect(outbox.pendingIds("w")).toEqual([a.id, b.id]);
    expect(JSON.parse(outbox.take("w") ?? "null")).toMatchObject({ id: a.id, target: "w", text: "a" });
    expect(JSON.parse(outbox.take("w") ?? "null")).toMatchObject({ text: "b" });
    expect(outbox.take("w")).toBeNull();
    expect(outbox.waiterAlive("w")).toBe(false);
    expect(existsSync(outbox.outboxDir("w"))).toBe(true);
  });
});

describe("links in a report", async () => {
  const { openArgsFor } = await import("../reportboard.ts");
  test("web pages open; local files are only revealed; apps and scripts are not launched", () => {
    expect(openArgsFor("https://example.com/x", "/r/a.md")).toEqual(["https://example.com/x"]);
    expect(openArgsFor("file:///Applications/Calculator.app", "/r/a.md")).toBeNull();
    expect(openArgsFor("javascript:alert(1)", "/r/a.md")).toBeNull();
    expect(openArgsFor("test/threads.test.ts", `${process.cwd()}/README.md`)).toEqual(["-R", `${process.cwd()}/test/threads.test.ts`]);
    expect(openArgsFor("missing.md", "/r/a.md")).toBeNull();
  });
});

describe("broken thread files", () => {
  test("a broken file of another report does not stop replies", () => {
    const t = addUserMessage({ home: dir, reportPath: "/r/ok.md", threadId: null, section: { level: 2, text: "x", occurrence: 0 }, text: "q" });
    require("node:fs").writeFileSync(join(dir, "threads", "0broken.json"), "{");
    expect(addReply({ home: dir, threadId: t.id, text: "a" })?.file).toBe("/r/ok.md");
  });
});
