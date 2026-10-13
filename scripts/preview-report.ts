#!/usr/bin/env bun
// For verification: writes reportboard.html with a report baked in, so a browser can open it without the window process.
//   bun scripts/preview-report.ts <file.md> <out.html> [ja|en] [--threads <threads.json>] [--next <edited.md>] [--simulate-ai]
// The bound functions (__reportboardLoad etc.) are replaced by stubs that return the rendering of <file.md>.
// Open the output over http (Playwright cannot open file: URLs); see docs/reportboard-development.md
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { renderReport } from "../lib/report.ts";

// --next <file.md>: a later version of the report, delivered by the poll once window.__deliverNext is set
// (to check how a reload after an edit looks)
const args = process.argv.slice(2);
const nextAt = args.indexOf("--next");
const nextInput = nextAt === -1 ? null : args.splice(nextAt, 2)[1];
// --threads <threads.json>: conversations saved before the window opened (an array of { id, heading, messages, sectionId })
const threadsAt = args.indexOf("--threads");
const threadsInput = threadsAt === -1 ? null : args.splice(threadsAt, 2)[1];
const savedThreads: unknown[] = threadsInput === null ? [] : JSON.parse(readFileSync(resolve(threadsInput), "utf8"));
// --simulate-ai: after each send, an AI takes it in 2 s and replies three times (right away, a progress note, the result with --done) 3 s apart
const simulateAt = args.indexOf("--simulate-ai");
const simulateAi = simulateAt !== -1;
if (simulateAi) args.splice(simulateAt, 1);
const [input, output, lang = "ja"] = args;
if (input === undefined || output === undefined) {
  console.error("usage: bun scripts/preview-report.ts <file.md> <out.html> [ja|en] [--threads <threads.json>] [--next <edited.md>] [--simulate-ai]");
  process.exit(1);
}
const path = resolve(input);
const reportOf = (file: string) => ({
  path,
  name: basename(path),
  dir: dirname(path),
  modifiedAt: statSync(file).mtimeMs,
  ...renderReport(readFileSync(file, "utf8"), { baseDir: dirname(file) }),
  canTalk: true,
  threads: savedThreads,
});
const report = reportOf(path);
const next = nextInput === null ? null : reportOf(resolve(nextInput));
const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
window.__previewNext = ${JSON.stringify(next).replaceAll("</", "<\\/")};
window.__reportboardPoll = async () => {
  if (window.__deliverNext && window.__previewNext) {
    const next = window.__previewNext;
    window.__previewNext = null;
    next.threads = window.__previewThreads.map((t) => ({ ...t }));
    return { replaceUrl: null, report: next, threads: null, missing: false, waiting: false };
  }
  const threads = window.__previewChanged ? window.__previewThreads.map((t) => ({ ...t })) : null;
  window.__previewChanged = false;
  return { replaceUrl: null, report: null, threads, missing: false, waiting: ${simulateAi} };
};
window.__reportboardOpen = async (href) => console.log("open", href);
// Threads live in the page only (no AI answers in the preview)
window.__previewThreads = ${JSON.stringify(savedThreads).replaceAll("</", "<\\/")};
window.__reportboardSend = async ({ threadId, section, text }) => {
  const sections = (await window.__reportboardLoad()).sections;
  let thread = window.__previewThreads.find((t) => t.id === threadId);
  if (!thread) {
    const placed = sections.find((s) => s.id === section.id);
    thread = { id: "t-" + Math.random().toString(16).slice(2, 10), heading: section, messages: [], sectionId: placed ? placed.id : null };
    window.__previewThreads.push(thread);
  }
  const sent = { from: "user", text, at: new Date().toISOString() };
  thread.messages.push(sent);
  thread.state = "sent";
  if (${simulateAi}) {
    const ja = ${JSON.stringify(lang !== "en")};
    const later = (ms, change) => setTimeout(() => { change(); window.__previewChanged = true; }, ms);
    const reply = (text, done) => () => { thread.messages.push({ from: "ai", text, at: new Date().toISOString() }); thread.state = done ? null : "working"; };
    later(2000, () => { sent.receivedAt = new Date().toISOString(); thread.state = "received"; });
    later(5000, reply(ja ? "表に合計の行を足します" : "Adding a total row to the table"));
    later(8000, reply(ja ? "内訳の数字を足し合わせて確かめています" : "Checking the numbers against the breakdown"));
    later(11000, reply(ja ? "「結果」の表に合計の行を足しました" : "Added a total row to the table in Results", true));
  }
  return { ok: true, threadId: thread.id, threads: window.__previewThreads.map((t) => ({ ...t })) };
};
window.__reportboardClose = async () => {};
history.replaceState(null, "", "?rid=preview&lang=${lang === "en" ? "en" : "ja"}");
</script>`;
// enterKey.js is inlined: the preview is written elsewhere, away from the page's directory
const enterKey = readFileSync(resolve(import.meta.dir, "../enterKey.js"), "utf8");
const page = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8")
  .replace('<script src="enterKey.js"></script>', () => `<script>${enterKey}</script>`)
  .replace("<script>", `${stubs}\n<script>`);
writeFileSync(resolve(output), page);
console.log(resolve(output));
