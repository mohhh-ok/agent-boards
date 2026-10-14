# reportboard development

Notes for changing the window itself. For usage, see [reportboard.md](reportboard.md); for why it is built this way, [design.md](design.md).

## Files

- `reportboard.ts`: the launcher, the window process (`--window`), `wait` and `reply`
- `reportboard.html`: the page (HTML/CSS/JS, no external dependencies besides `enterKey.js`, the Enter handling shared with textboard). It receives rendered HTML; it does not parse Markdown
- `lib/report.ts`: Markdown → HTML with `marked`, including the breakdown lists, numeric columns and quantities. Tested in `test/report.test.ts`
- `lib/threads.ts`: conversations per section, stored in `~/.reportboard/threads/`. Every change to a threads file happens under `<file>.lock` (a directory), so the window and `reply` writing at once lose nothing (`test/concurrency.test.ts`)
- `lib/outbox.ts`, `lib/windows.ts`, `lib/lang.ts`: shared with textboard (and moodboard for the last two)
- `scripts/preview-report.ts`: writes the page with a report baked in, for checking in a browser
- `test/reportboard-page.test.ts`: runs the page script in happy-dom with the bound functions stubbed, for behaviour that does not depend on layout (happy-dom measures nothing, so no row counts as clipped)

## How it works

- Opening: the launcher writes `{ path }` to `boards/<rid>.json` and opens `reportboard.html?rid=…&lang=…`. The page calls `__reportboardLoad(rid)`, which renders the file and returns the HTML, the h2 list for the contents, the h2/h3 sections and their threads. The page then calls `__reportboardReady(rid)` without awaiting it, and starts polling
- Change marks: before re-rendering, the page counts the text of each block (table row, list item, paragraph, heading, code, note); after, blocks whose text is not among the old ones are marked `.is-changed` (innermost only). Comparison is by text, so a moved block is not marked
- `__reportboardPoll()` every 500 ms returns a replace URL, a new rendering when the report's mtime/size changed, the threads when only the threads file changed, whether the file is missing, and whether a `wait` is running
- Sending: `__reportboardSend({ threadId, section, text })` appends to the thread and writes the outbox entry that `wait` / `watch` print
- Placing threads: `placeThreads` (lib/threads.ts) says for each thread where it sits now and how (`placement`: exact / renamed / moved / null). The window saves the new place of renamed ones (`rememberPlaces`). The page puts the first thread of a section in the section's own box, others in boxes after it, and lost ones in `#orphans` under the title
- Received: when `wait` or `watch` takes an entry, it writes `receivedAt` on that user message in the threads file (`markReceived`). `reply --done` writes `doneAt`, and each `wait` writes its start time to `targets/<name>.wait-started`. Each thread reaches the page with `state` (`threadState`): "sent", "received" (the page adds the "writing a reply" line), "working" (after a reply, the page adds "still working" under it) or null once done or a later `wait` started. The poll re-sends the threads when the wait start time changes
- Links: `__reportboardOpen(href)` opens http(s)/mailto with `open`, and only reveals existing local files (`open -R`), so a link cannot launch an app or a script
- Do not `await` a bound function that returns nothing: its promise may never settle

## Verifying

- Layout: `bun scripts/preview-report.ts <file.md> /tmp/x/preview.html ja [--threads <threads.json>] [--next <edited.md>]` (with `--threads <threads.json>`, the page opens with those conversations already saved, an array of `{ id, heading, messages, sectionId }`; with `--next`, setting `window.__deliverNext = true` in the page makes the next poll deliver the edited version, to see the change marks), serve `/` over http, and open it in headless WebKit (closest to the real WKWebView) at the widths you check. The preview stubs the bound functions; sending works inside the page, with no AI reply
- The real window: `REPORTBOARD_DEV_INIT_SCRIPT=<file.js>` when opening a new window injects a script into every page load, to click buttons and send through the DOM. `REPORTBOARD_HOME=<dir>` keeps verification threads out of `~/.reportboard`. Check the results through `wait`'s output and the threads file. Do not bring the window to the front to take a screenshot: the user's typing goes into it
- `screencapture -l <window id>` of a window hidden behind others can show an old frame, because WebKit stops painting it
