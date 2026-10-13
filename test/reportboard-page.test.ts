import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { renderReport } from "../lib/report.ts";

// The page script of reportboard.html, run in happy-dom with the bound functions stubbed (no layout, so no row is clipped)
// enterKey.js is inlined: the page loads it from its own directory, which happy-dom cannot fetch
const ENTER_KEY = readFileSync(resolve(import.meta.dir, "../enterKey.js"), "utf8");
const PAGE = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8").replace(
  '<script src="enterKey.js"></script>',
  () => `<script>${ENTER_KEY}</script>`,
);
const windows: Window[] = [];

// next: the report as edited later; the first poll delivers it, as when the file changes on disk
async function openPage(md: string, threads: unknown[], next?: string) {
  const reportOf = (text: string, modifiedAt: number) =>
    ({ path: "/r/report.md", name: "report.md", dir: "/r", modifiedAt, ...renderReport(text, { baseDir: "/r" }), canTalk: true, threads });
  const report = reportOf(md, 0);
  const edited = next === undefined ? null : reportOf(next, 1);
  const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
let pendingEdit = ${JSON.stringify(edited).replaceAll("</", "<\\/")};
window.__reportboardPoll = async () => {
  const report = pendingEdit;
  pendingEdit = null;
  return { replaceUrl: null, report, threads: null, missing: false, waiting: false };
};
</script>`;
  const window = new Window({
    url: "http://localhost/?rid=test&lang=en",
    // The script is this repo's own page
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  });
  windows.push(window);
  window.document.write(PAGE.replace("<script>", `${stubs}\n<script>`));
  // The page polls forever, so wait for the first rendering (or its error) instead of for the page to settle
  for (let i = 0; i < 100 && window.document.querySelector(".ledger-row, .thread, .message.is-error") === null; i++) await Bun.sleep(10);
  return window.document;
}

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

describe("reportboard page", () => {
  test("a breakdown row without details that has a saved conversation opens to show it", async () => {
    const md = "## Breakdown\n\n- E. Camera — 4.5 days. Screen 1.5, tests 1\n- F. Brand kit — 9 days\n";
    const threads = [
      {
        id: "t-1",
        heading: { id: "row-3", level: 2, text: "Breakdown", occurrence: 0, row: { name: "F. Brand kit", occurrence: 0 } },
        sectionId: "row-3",
        messages: [
          { from: "user", text: "Split it", at: "2026-10-13T01:00:00.000Z" },
          { from: "ai", text: "Logo, colours, type", at: "2026-10-13T01:01:00.000Z" },
        ],
      },
    ];
    const document = await openPage(md, threads);
    expect(document.querySelector(".message.is-error")?.textContent ?? null).toBeNull();
    const short = document.getElementById("row-3")!;
    expect(short.classList.contains("is-open")).toBe(true);
    expect(short.classList.contains("has-more")).toBe(true);
    expect(short.querySelector(".thread")!.hasAttribute("hidden")).toBe(false);
    expect(short.querySelectorAll(".message-item").length).toBe(2);
    // The same open/close button as a row with details
    const more = short.querySelector(".ledger-more")!;
    expect(more.getAttribute("aria-label")).toBe("Show less");
    const other = document.getElementById("row-2")!.querySelector(".ledger-more")!;
    expect(other.getAttribute("aria-label")).toBe("Read more");
    expect(more.className).toBe(other.className);
  });

  test("the AI getting a message shows under the conversation until its reply comes; its replies read as one", async () => {
    const md = "## Result\n\nText\n";
    const heading = { level: 2, text: "Result", occurrence: 0 };
    const user = { from: "user", text: "Fix it", at: "2026-10-13T01:00:00.000Z", receivedAt: "2026-10-13T01:00:01.000Z" };
    const ai = (text: string, minute: number) => ({ from: "ai", text, at: `2026-10-13T01:0${minute}:00.000Z` });
    const panelOf = async (thread: Record<string, unknown>) => {
      const document = await openPage(md, [{ id: "t-1", heading, sectionId: "section-1", ...thread }]);
      return document.querySelector(".thread")!;
    };

    const received = await panelOf({ messages: [user], state: "received" });
    const pending = received.querySelectorAll(".message-item.is-pending");
    expect(pending.length).toBe(1);
    expect(pending[0].textContent).toContain("Got it. Writing a reply");
    expect(received.querySelector(".composer-status")!.textContent).toBe("The AI is working on it. What you add is kept and reaches the AI");

    const sent = await panelOf({ messages: [{ ...user, receivedAt: undefined }], state: "sent" });
    expect(sent.querySelector(".is-pending")).toBeNull();
    expect(sent.querySelector(".composer-status")!.textContent).toBe("Sent. The AI's reply will appear here");

    const working = await panelOf({ messages: [user, ai("On it", 1), ai("Checking the table", 2)], state: "working" });
    const workingItems = [...working.querySelectorAll(".message-item")];
    expect(workingItems.length).toBe(4);
    // Under the latest reply, as part of the AI's replies
    expect(workingItems[3].classList.contains("is-pending")).toBe(true);
    expect(workingItems[3].classList.contains("is-continued")).toBe(true);
    expect(workingItems[3].textContent).toContain("Still working on it");
    expect(working.querySelector(".composer-status")!.textContent).toBe("The AI is working on it. What you add is kept and reaches the AI");

    const replied = await panelOf({ messages: [user, ai("On it", 1), ai("Checking the table", 2), ai("Done", 3)], state: null });
    expect(replied.querySelector(".is-pending")).toBeNull();
    expect([...replied.querySelectorAll(".message-item")].map((li) => li.classList.contains("is-continued"))).toEqual([false, false, true, true]);
    expect(replied.querySelector(".composer-status")!.textContent).not.toContain("working");
  });

  test("a changed detail of a breakdown row marks the row, which shows even while the row is closed", async () => {
    const md = "## Breakdown\n\n- A. Camera — 4.5 days\n  - Screen 1.5\n  - Tests 1\n- B. Brand kit — 9 days\n  - Logo 3\n";
    const document = await openPage(md, [], md.replace("Tests 1", "Tests and devices 1"));
    for (let i = 0; i < 200 && document.querySelector(".is-changed") === null; i++) await Bun.sleep(10);
    const marked = [...document.querySelectorAll(".is-changed")];
    expect(marked.length).toBe(1);
    expect(marked[0].classList.contains("ledger-row")).toBe(true);
    expect(marked[0].textContent).toContain("A. Camera");
  });
});
