# Development

Notes for changing the window itself. For usage, see [textboard.md](textboard.md).

## Files

- `textboard.ts`: the launcher, the window process (`--window`) and `wait`. Named windows, locks, acks and the state directory come from `lib/windows.ts`, the display language from `lib/lang.ts` (shared with moodboard and reportboard)
- `textboard.html`: the whole page (HTML/CSS/JS, no external dependencies besides `anchor.js` and `enterKey.js`)
- `anchor.js`: keeps comments on their passage. Shared by the page (`<script>`) and the tests (`require`)
- `enterKey.js`: Enter sends or confirms, Shift+Enter starts a new line, the Enter that confirms IME input does neither. Shared by textboard and reportboard (`<script>`) and the tests (`require`)
- `editMenu.ts`: builds the macOS Edit menu through `bun:ffi`
- `test/`: `bun test`

## How it works

- The launcher writes `{ path }` to `/tmp/textboard-<uid>/boards/<rid>.json` and opens `textboard.html?rid=<rid>&lang=<ja|en>` in a detached window process. The page reads the board with the bound `__textboardLoad(rid)`, which also returns the text and the saved comments. The page then calls `__textboardReady(rid, null)`; the window process writes `acks/<rid>.json`, which the launcher waits for
- Bun's event loop does not run while `webview.run()` owns the thread, so the window process cannot push anything to the page. The page calls `__textboardPoll()` every 500 ms. It returns a pending replace URL (`targets/<name>.request.json`), the new file contents when the file's mtime/size changed since the last read or save, whether a `wait` is running (`targets/<name>.waiters/<pid>`), and the ids still in the outbox
- Replacing with unsaved edits: the page does not navigate. It calls `__textboardReady(newRid, { refused: "unsaved" })`, and the launcher exits with 3
- Sending: `__textboardSend(payload)` writes `outbox/<name>/<id>.json` (written to a dot-file first and renamed, so `wait` never reads half a file). `wait` claims the oldest file by renaming it to its own name, prints it and deletes it, so one instruction goes to exactly one `wait`
- Comment positions: edits inside the window shift ranges by the diff of one `input` event (`anchor.diff` + `anchor.shiftRange`, with the caret to resolve ambiguous repeats). Outside changes and reopening search again by quote + 32 characters of context on each side (`anchor.locate`)
- Comments are stored in `~/.textboard/comments/<sha256 of the absolute path>.json` (`TEXTBOARD_HOME` changes `~/.textboard`, for verification), never next to the document, so the user's repository stays clean. The window process adds `file` (the absolute path) to the JSON. Moving or renaming the document detaches its comments; this is accepted
- The comments file is written to a temporary file and renamed, so a symlink placed at that path is replaced, not followed
- Edit menu: macOS delivers `⌘Z` / `⌘C` / `⌘V` etc. through the menu bar, and webview creates no menu, so without `editMenu.ts` those keys do nothing in the editor. Keys the page handles itself (`⌘S`, `⌘W`, `⌘⌥M`) must not be added to the menu, or they no longer reach the page
- Display language: window strings are in `STRINGS` in `textboard.html`, CLI messages in `MESSAGES` in `textboard.ts`. Add to both languages

## Verifying changes in the real window

Keystrokes cannot be sent to the window without Accessibility permission, so the window process can run a script in the page for verification: set `TEXTBOARD_DEV_INIT_SCRIPT=<path to a .js file>` when opening a **new** window, and the file is injected into every page load (`webview.init`). Drive the page through the DOM (`editor.setSelectionRange`, `document.execCommand("insertText")`, `KeyboardEvent` with `metaKey`), and take screenshots from outside with `screencapture -x -o -l <window id>`, which works while the window is behind others. Do not use this variable in normal use.

Synthetic events do not exercise native behaviour (the Edit menu, IME, real mouse selection). Check those by hand.

## Never do this

- Do not open it with `open "file://...?query"` (macOS drops the query string)
- Do not open it with the Playwright MCP
