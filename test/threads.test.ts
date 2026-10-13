import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReply, addUserMessage, placeThreads, readThreads, threadsPath } from "../lib/threads.ts";
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
    expect(placeThreads([thread], sections.slice(0, 2))[0].sectionId).toBeNull();
    // A thread on the heading is not placed on its rows
    const onHeading = { id: "t-2", heading: { level: 2, text: "内訳", occurrence: 0 }, messages: [] };
    expect(placeThreads([onHeading], sections)[0].sectionId).toBe("section-1");
  });
});

describe("outbox", () => {
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
