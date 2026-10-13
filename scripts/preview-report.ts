#!/usr/bin/env bun
// For verification: writes reportboard.html with a report baked in, so a browser can open it without the window process.
//   bun scripts/preview-report.ts <file.md> <out.html> [ja|en]
// The bound functions (__reportboardLoad etc.) are replaced by stubs that return the rendering of <file.md>.
// Open the output over http (Playwright cannot open file: URLs); see docs/reportboard-development.md
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { renderReport } from "../lib/report.ts";

const [input, output, lang = "ja"] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error("usage: bun scripts/preview-report.ts <file.md> <out.html> [ja|en]");
  process.exit(1);
}
const path = resolve(input);
const report = {
  path,
  name: basename(path),
  dir: dirname(path),
  modifiedAt: statSync(path).mtimeMs,
  ...renderReport(readFileSync(path, "utf8"), { baseDir: dirname(path) }),
  canTalk: true,
  threads: [] as unknown[],
};
const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
window.__reportboardPoll = async () => ({ replaceUrl: null, report: null, missing: false });
window.__reportboardOpen = async (href) => console.log("open", href);
// Threads live in the page only (no AI answers in the preview)
window.__previewThreads = [];
window.__reportboardSend = async ({ threadId, section, text }) => {
  const sections = (await window.__reportboardLoad()).sections;
  let thread = window.__previewThreads.find((t) => t.id === threadId);
  if (!thread) {
    const placed = sections.find((s) => s.level === section.level && s.text === section.text && s.occurrence === section.occurrence);
    thread = { id: "t-" + Math.random().toString(16).slice(2, 10), heading: section, messages: [], sectionId: placed ? placed.id : null };
    window.__previewThreads.push(thread);
  }
  thread.messages.push({ from: "user", text, at: new Date().toISOString() });
  return { ok: true, threadId: thread.id, threads: window.__previewThreads };
};
window.__reportboardClose = async () => {};
history.replaceState(null, "", "?rid=preview&lang=${lang === "en" ? "en" : "ja"}");
</script>`;
const page = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8").replace("<script>", `${stubs}\n<script>`);
writeFileSync(resolve(output), page);
console.log(resolve(output));
