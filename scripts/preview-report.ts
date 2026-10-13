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
};
const stubs = `<script>
window.__reportboardLoad = async () => (${JSON.stringify(report).replaceAll("</", "<\\/")});
window.__reportboardReady = async () => {};
window.__reportboardPoll = async () => ({ replaceUrl: null, report: null, missing: false });
window.__reportboardOpen = async (href) => console.log("open", href);
window.__reportboardClose = async () => {};
history.replaceState(null, "", "?rid=preview&lang=${lang === "en" ? "en" : "ja"}");
</script>`;
const page = readFileSync(resolve(import.meta.dir, "../reportboard.html"), "utf8").replace("<script>", `${stubs}\n<script>`);
writeFileSync(resolve(output), page);
console.log(resolve(output));
