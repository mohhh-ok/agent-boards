# Development

Notes for changing the viewer itself. For usage, see the [README](../README.md).

## Never do this

- **Do not open it with `open "file://...?query"`**. macOS LaunchServices drops the query string and you get an empty page
- **Do not open it with the Playwright MCP** (the `file:` protocol is blocked, and launching the Chrome channel can collide with the user's own Chrome). For verification, use the method under "Verifying changes to the viewer"
- Do not `rm` the images you displayed

## Verifying changes to the viewer

Synthetic `dispatchEvent` calls do not reproduce native behaviour (ghost image drag etc.) and let implementation bugs slip through.
Verify with **real mouse input**: playwright-core + headless Chromium (point `executablePath` at `~/Library/Caches/ms-playwright/chromium-*`) using `page.mouse.down/move/up` and `page.mouse.wheel`.

Playwright cannot open `file:` URLs, so for verification only, serve the filesystem root on localhost with something like `bun -e 'Bun.serve(...)'` and open `moodboard.html?rid=<id>` over `http://` (`toImgSrc` in `moodboard.html` turns absolute paths into server-root paths, so the server must serve `/`).
The page gets its board from the host, so provide the bound functions yourself with `page.exposeFunction`: `__moodboardLoad(rid)` returns the board object, `__moodboardReady(rid, failedPaths)` receives the ack, and `__moodboardPoll()` returns `null`.
Stop the server afterwards with `lsof -ti:<port> | xargs kill`.

## Implementation notes

- The whole viewer is `moodboard.html` (self-contained HTML/CSS/JS, no external dependencies) plus `moodboard.ts` (the [webview-bun](https://github.com/tr1ckydev/webview-bun) launcher)
- The launcher opens the window in a detached child process (its own session), waits until the page reports that every item has settled, then exits. That is why no `nohup` / `&` / `disown` is needed and the window survives the end of an agent's tool call
- State lives in `/tmp/moodboard-<uid>/` (mode 0700, owner checked on every run): `targets/<name>.pid`, pending replace requests, acks, and logs of new windows
- `moodboard.ts` turns the arguments (a path list or a validated `--json` file) into one board object with absolute paths, writes it to `/tmp/moodboard-<uid>/boards/<rid>.json`, and hands `moodboard.html?rid=<request id>` to webview-bun in a detached child (`moodboard.ts --window <config>`). The page reads the board through the bound `__moodboardLoad(rid)`. Nothing but the request id goes into the URL, so long notes and many paths never hit a URL length limit
- The page reports readiness through the bound `__moodboardReady(rid, failedPaths)`; the child writes it to `/tmp/moodboard-<uid>/acks/<rid>.json`, which the launcher waits for
- Board files under `boards/` don't accumulate: `__moodboardLoad` deletes its file right after reading it. On a failed/unconfirmed open (timeout waiting for the ack), the launcher only deletes the request/board files when the window hasn't picked up the request yet (checked via the target's request file still existing); if the window has already picked it up and may be mid-load, the launcher leaves the board file alone so a late-but-successful load doesn't fail — the window's own `__moodboardLoad` cleans it up whenever it runs. The window process also deletes its own initial board file on exit as a last-resort sweep (later boards loaded via a target replace are already gone by then, each cleaned up by its own `__moodboardLoad` call). Anything left over after all of that (a window that truly crashed, etc.) is swept at the next launcher invocation if it's older than several times the ack timeout. If `__moodboardLoad` itself fails, the page shows a distinct "failed to load" state instead of the empty state, so a load failure is never silently indistinguishable from "no items"
- Replacing a named window: the launcher writes `/tmp/moodboard-<uid>/targets/<name>.request.json`; the page polls the bound `__moodboardPoll()` every 500 ms and `location.replace`s to the new URL. Polling from the page is needed because Bun's event loop does not run while `webview.run()` owns the thread
- Closing with `⌘W` / `Ctrl+W`: the page calls the bound `__moodboardClose()`. webview-bun does not expose `webview_terminate` outside `destroy()` (and `run()` calls `destroy()` again when it returns), so the window process runs the same cleanup as a normal close and then `process.exit(0)`s instead of stopping `run()`
- webview-bun resolves its dylib/so through a package-relative import (`../build/libwebview.dylib` etc.), so it works under a global install as well (it reads from `node_modules/webview-bun/build/`)
- Display language: every string shown in the window lives in the `STRINGS` table in `moodboard.html` (`ja` / `en`), and the CLI messages live in `MESSAGES` in `moodboard.ts`. Add a string to both languages. The launcher decides the language (rules: README "Language") and passes it as `lang` in the URL; in the http verification page, add `&lang=ja|en` yourself, or `navigator.language` is used
- Verified on macOS (WKWebView) only. webview-bun ships Linux/Windows binaries too, but those have not been tested

