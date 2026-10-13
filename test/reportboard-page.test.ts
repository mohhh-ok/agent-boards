import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { renderReport } from "../lib/report.ts";

// The page script of reportboard.html, run in happy-dom with the bound functions stubbed (no layout, so no row is clipped)
const PAGE = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8");
const windows: Window[] = [];

async function openPage(md: string, threads: unknown[]) {
  const report = { path: "/r/report.md", name: "report.md", dir: "/r", modifiedAt: 0, ...renderReport(md, { baseDir: "/r" }), canTalk: true, threads };
  const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
window.__reportboardPoll = async () => ({ replaceUrl: null, report: null, threads: null, missing: false, waiting: false });
</script>`;
  const window = new Window({
    url: "http://localhost/?rid=test&lang=en",
    // The script is this repo's own page
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  });
  windows.push(window);
  window.document.write(PAGE.replace("<script>", `${stubs}\n<script>`));
  // The page polls forever, so wait for the first rendering (or its error) instead of for the page to settle
  for (let i = 0; i < 100 && window.document.querySelector(".ledger-row, .message.is-error") === null; i++) await Bun.sleep(10);
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
});
