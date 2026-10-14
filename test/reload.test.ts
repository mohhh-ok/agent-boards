import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import { renderReport } from "../lib/report.ts";
import { nextRendering } from "../reportboard.ts";

// A rewritten report reaches the window even when a rendering fails once (docs/design.md "書き換えた版を取りこぼさない")

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function reportFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rb-reload-"));
  dirs.push(dir);
  const path = join(dir, "report.md");
  writeFileSync(path, text);
  return path;
}

const stampOf = (path: string) => {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
};

describe("the window sends a new version until the page shows it", () => {
  test("a rendering that failed is tried again on the next poll", () => {
    const path = reportFile("# One\n");
    const shown = stampOf(path);
    writeFileSync(path, "# Two, longer\n");
    let calls = 0;
    const render = () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return readFileSync(path, "utf8");
    };
    const first = nextRendering({ path, shown, render });
    expect(first.error?.message).toBe("boom");
    expect(first.report).toBeNull();
    // The page still shows the old version, so it sends the same stamp again
    const second = nextRendering({ path, shown, render });
    expect(second.report).toBe("# Two, longer\n");
  });

  test("a rendering the page never showed is sent again", () => {
    const path = reportFile("# One\n");
    const shown = stampOf(path);
    writeFileSync(path, "# Two, longer\n");
    const render = () => readFileSync(path, "utf8");
    expect(nextRendering({ path, shown, render }).report).toBe("# Two, longer\n");
    expect(nextRendering({ path, shown, render }).report).toBe("# Two, longer\n");
    expect(nextRendering({ path, shown: stampOf(path), render }).unchanged).toBe(true);
  });

  test("replacing the file (rename over it), editing it in place and appending are all seen", () => {
    const path = reportFile("# One\n");
    const render = () => readFileSync(path, "utf8");
    let shown = stampOf(path);
    // The way an editor or a Write tool saves: a new file renamed over the old one
    writeFileSync(`${path}.tmp`, "# Replaced\n");
    renameSync(`${path}.tmp`, path);
    let next = nextRendering({ path, shown, render });
    expect(next.report).toBe("# Replaced\n");
    shown = stampOf(path);
    // sed -i on macOS rewrites the same file; the size stays the same here, so only the time tells
    Bun.sleepSync(5);
    writeFileSync(path, "# Edited!!\n");
    expect(stampOf(path).size).toBe(shown.size);
    next = nextRendering({ path, shown, render });
    expect(next.report).not.toBeNull();
    shown = stampOf(path);
    appendFileSync(path, "- added\n");
    expect(nextRendering({ path, shown, render }).report).toContain("- added");
  });

  test("a missing file is reported, not rendered", () => {
    const path = reportFile("# One\n");
    const shown = stampOf(path);
    rmSync(path);
    expect(nextRendering({ path, shown, render: () => "x" })).toEqual({ report: null, error: null, missing: true, unchanged: false });
  });
});

// The page, with the window's poll stubbed the same way: it answers with the version on "disk" until the page sends
// that version back. The first answer is broken, as when rendering fails in the page
const ENTER_KEY = readFileSync(resolve(import.meta.dir, "../enterKey.js"), "utf8");
const PAGE = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8").replace('<script src="enterKey.js"></script>', () => `<script>${ENTER_KEY}</script>`);
const windows: Window[] = [];
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

describe("the page asks again for a version it could not show", () => {
  test("the first rendering of the new version fails, the next poll shows it", async () => {
    const reportOf = (text: string, stamp: { mtimeMs: number; size: number }) => ({
      path: "/r/report.md",
      name: "report.md",
      dir: "/r",
      modifiedAt: stamp.mtimeMs,
      stamp,
      ...renderReport(text, { baseDir: "/r" }),
      canTalk: false,
      threads: [],
    });
    const first = reportOf("# Old title\n\nText\n", { mtimeMs: 1, size: 10 });
    const edited = reportOf("# New title\n\n## A\n\nx\n\n## B\n\ny\n", { mtimeMs: 2, size: 11 });
    // Broken: the page throws while rendering it
    const broken = { ...edited, headings: null };
    const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(first).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
window.__pageLog = [];
window.__reportboardLog = async (text) => { window.__pageLog.push(text); };
const edited = ${JSON.stringify(edited).replaceAll("</", "<\\/")};
const broken = ${JSON.stringify(broken).replaceAll("</", "<\\/")};
window.__polls = [];
window.__reportboardPoll = async (shown) => {
  window.__polls.push(shown);
  const upToDate = shown && shown.mtimeMs === edited.stamp.mtimeMs && shown.size === edited.stamp.size;
  const report = upToDate ? null : window.__polls.length === 1 ? broken : edited;
  return { replaceUrl: null, report, renderError: null, threads: null, missing: false, waiting: false };
};
</script>`;
    const window = new Window({
      url: "http://localhost/?rid=test&lang=en",
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    });
    windows.push(window);
    window.document.write(PAGE.replace("<script>", `${stubs}\n<script>`));
    const w = window as unknown as { __polls: unknown[]; __pageLog: string[] };
    const title = () => window.document.querySelector("#report h1")?.textContent;
    for (let i = 0; i < 300 && w.__polls.length < 3; i++) await Bun.sleep(10);
    // Compared with the version shown in full, not with the half-built one: what changed is marked
    expect(window.document.querySelectorAll(".is-changed").length).toBeGreaterThan(0);
    expect(title()).toBe("New title");
    // Shown in full this time: the contents list the broken rendering could not build
    expect(window.document.querySelectorAll("#toc-list li").length).toBe(2);
    // The first poll carried the version opened; the second still did, because the broken one was never shown
    expect(w.__polls[0]).toEqual(first.stamp);
    expect(w.__polls[1]).toEqual(first.stamp);
    expect(w.__pageLog.some((line) => line.startsWith("could not show the new version"))).toBe(true);
    expect(w.__polls[2]).toEqual(edited.stamp);
  });
});

describe("the page asks again for conversations it could not show", () => {
  test("threads that failed to render are sent again; the version shown is sent back", async () => {
    const md = "## Result\n\nText\n";
    const report = {
      path: "/r/report.md",
      name: "report.md",
      dir: "/r",
      modifiedAt: 1,
      stamp: { mtimeMs: 1, size: 1 },
      ...renderReport(md, { baseDir: "/r" }),
      canTalk: true,
      threads: [],
      threadsVersion: "v0",
    };
    const good = [{ id: "t-1", heading: { level: 2, text: "Result", occurrence: 0 }, sectionId: "section-1", placement: "exact", state: null, messages: [{ from: "ai", text: "Reply", at: "2026-10-14T01:00:00.000Z" }] }];
    // Broken: a lost conversation without its heading makes the page throw
    const broken = [{ id: "t-2", sectionId: null, placement: null, state: null, messages: [] }];
    const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report)});
window.__reportboardReady = async () => {};
window.__reportboardLog = async () => {};
window.__polls = [];
window.__reportboardPoll = async (shown, shownThreads) => {
  window.__polls.push(shownThreads);
  const threads = shownThreads === "v1" ? null : window.__polls.length === 1 ? ${JSON.stringify(broken)} : ${JSON.stringify(good)};
  return { replaceUrl: null, report: null, renderError: null, threads, threadsVersion: threads === null ? null : "v1", missing: false, waiting: false };
};
</script>`;
    const window = new Window({
      url: "http://localhost/?rid=test&lang=en",
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    });
    windows.push(window);
    window.document.write(PAGE.replace("<script>", `${stubs}\n<script>`));
    const w = window as unknown as { __polls: unknown[] };
    for (let i = 0; i < 300 && w.__polls.length < 3; i++) await Bun.sleep(10);
    expect(w.__polls.slice(0, 3)).toEqual(["v0", "v0", "v1"]);
    expect(window.document.querySelector(".message-text")?.textContent).toBe("Reply");
  });
});
