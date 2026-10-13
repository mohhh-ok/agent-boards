# reportboard development

Notes for changing the window itself. For usage, see [reportboard.md](reportboard.md); for why it is built this way, [design.md](design.md).

## Files

- `reportboard.ts`: the launcher, the window process (`--window`), `wait` and `reply`
- `reportboard.html`: the page (HTML/CSS/JS, no external dependencies). It receives rendered HTML; it does not parse Markdown
- `lib/report.ts`: Markdown → HTML with `marked`, including the breakdown lists, numeric columns and quantities. Tested in `test/report.test.ts`
- `lib/threads.ts`: conversations per section, stored in `~/.reportboard/threads/`
- `lib/outbox.ts`, `lib/windows.ts`, `lib/lang.ts`: shared with textboard (and moodboard for the last two)
- `scripts/preview-report.ts`: writes the page with a report baked in, for checking in a browser

## How it works

- Opening: the launcher writes `{ path }` to `boards/<rid>.json` and opens `reportboard.html?rid=…&lang=…`. The page calls `__reportboardLoad(rid)`, which renders the file and returns the HTML, the h2 list for the contents, the h2/h3 sections and their threads. The page then calls `__reportboardReady(rid)` without awaiting it, and starts polling
- `__reportboardPoll()` every 500 ms returns a replace URL, a new rendering when the report's mtime/size changed, the threads when only the threads file changed, whether the file is missing, and whether a `wait` is running
- Sending: `__reportboardSend({ threadId, section, text })` appends to the thread and writes the outbox entry that `wait` prints
- Links: `__reportboardOpen(href)` opens http(s)/mailto with `open`, and only reveals existing local files (`open -R`), so a link cannot launch an app or a script
- Do not `await` a bound function that returns nothing: its promise may never settle

## Verifying

- Layout: `bun scripts/preview-report.ts <file.md> /tmp/x/preview.html ja`, serve `/` over http, and open it in headless WebKit (closest to the real WKWebView) at the widths you check. The preview stubs the bound functions; sending works inside the page, with no AI reply
- The real window: `REPORTBOARD_DEV_INIT_SCRIPT=<file.js>` when opening a new window injects a script into every page load, to click buttons and send through the DOM. `REPORTBOARD_HOME=<dir>` keeps verification threads out of `~/.reportboard`. Check the results through `wait`'s output and the threads file. Do not bring the window to the front to take a screenshot: the user's typing goes into it
- `screencapture -l <window id>` of a window hidden behind others can show an old frame, because WebKit stops painting it
