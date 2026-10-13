---
name: textboard
description: A window for revising text (Markdown or plain text) together with the user. The user edits the text directly, comments on any passage, and sends instructions from the window to the AI (the calling agent). Use it after writing a README, article, spec or message when the user says "show me", "let's revise this together", "open it in textboard" or "I want to comment on it". The text counterpart of moodboard.
---

# textboard — a window for revising text with the user

Open it with the `textboard` command (a WKWebView window via bun + webview-bun). **No server or browser needed.** No AI is built in: the calling agent (you) rewrites the text based on the instructions that come from the window.

## Flow

1. Write the file (or pick an existing one)
2. Open it with `textboard --target <name> <file>`
3. Run `textboard wait --target <name>` **in the background**
4. When the user edits the text, adds comments and sends an instruction in the window, wait prints JSON and exits with rc=0
5. Read `file` from the JSON again (the user's edits are saved), then rewrite the file following `instruction` and `comments`. The window reloads it automatically
6. After rewriting, go back to 3 (run wait again). Briefly report what you changed in the conversation too

## Opening

```sh
command -v textboard >/dev/null || bun install -g github:mohhh-ok/agent-boards
textboard --target <name> <file>; echo "rc=$?"
```

- Run it in the foreground as is. Do not add `nohup`, `&` or `disown`. textboard opens the window in a child process in its own session, so it stays after the tool call ends. The launcher exits within seconds once it confirms the window is showing
- `--target` is required. If a window with that name is open, it switches to the file (staying where it is); otherwise a new one opens. Start the name with the working directory name (project name) and use only letters, digits and `. _ -` (e.g. `billionclips-readme`)
- It opens one text file (up to 5 MB, without NUL)

### When you may report "opened"

Only when the exit code is 0 and `opened target=<name> pid=<PID> new|replaced file=<path>` is printed. This line is printed after the page acknowledges that it loaded the file.

- `1` = bad arguments, missing file, or not a text file
- `2` = the window could not be confirmed within 20 seconds (for a new window, the log path is printed)
- `3` = the window has unsaved edits, so it was not switched. Ask the user to "save or discard your edits", then open again. Do not `--close` and reopen on your own (the edits would be lost)

## Receiving instructions (wait)

```sh
textboard wait --target <name>; echo "rc=$?"
```

- **Always run it in the background** (it does not finish until the user sends). Read the output when it finishes
- Instructions sent while wait is not running are kept, and the next wait takes them one at a time, oldest first. After receiving one, run wait again, also to check whether more are queued
- The window shows "The AI is waiting for an instruction" only while wait is running. Otherwise the user sees "The AI is not listening right now". Run wait as soon as you open the file

Exit codes:

- `0` = received. JSON on stdout
- `1` = bad arguments, or no window with that name is open (and nothing is queued)
- `2` = timed out when `--timeout <seconds>` was given
- `3` = the window was closed while waiting. Treat it as the user being done, and do not run wait again

### JSON shape

```json
{
  "id": "1791764935089-9b15d890",
  "target": "billionclips-readme",
  "file": "/Users/me/project/README.md",
  "instruction": "Address my comments. Make it a bit shorter overall.",
  "comments": [
    {
      "id": "cmv4ikrhntddz",
      "line": 7,
      "endLine": 7,
      "quote": "Comments are listed in the margin",
      "comment": "\"on the right\" might be clearer than \"in the margin\""
    },
    {
      "id": "cmv4ikrhr4cgn",
      "line": null,
      "endLine": null,
      "quote": "This is the last paragraph.",
      "comment": "Weak as an ending",
      "lost": true
    }
  ],
  "savedBeforeSend": true,
  "sentAt": "2026-10-12T00:28:55.089Z"
}
```

- `file`: absolute path. The user's edits are saved before sending. **Always read it again before rewriting** (with `savedBeforeSend: true`, the user changed it after you last read it)
- `instruction`: the instruction text. It may be empty (then you are asked to address the comments)
- `comments`: every comment at that moment (in line order). `line` and `endLine` are line numbers in the file on disk (1-based). `quote` is the text the user selected. `lost: true` marks a comment whose place was lost because the text changed (`line` is null; `quote` is the original text)
- Handling comments: comments stay in the window, and only the user deletes them. Do not edit the comments file (`~/.textboard/comments/<sha256 of the absolute path>.json`); the window overwrites it. Report in the conversation how you addressed each comment
- Comments are tied to the file's absolute path. Moving or renaming the file detaches them (they do not appear even if you reopen it). Tell the user before moving or renaming a document that has comments

## When rewriting

- When you rewrite the file, the window reloads it automatically (if the user has no unsaved edits). If the user has unsaved edits, the window does not reload and lets the user choose "Load the outside version / Overwrite with my version". Your change may be overwritten, so read `file` again from the next wait's JSON
- Comments are reattached by their quoted text and the surrounding context. Even if you rewrite the quoted passage itself, the comment stays as long as the text around it remains. Deleting a whole paragraph makes its comments ones that "lost their place"

## Closing and listing

```sh
textboard --close <name>   # close only that window (unsaved edits are lost; only when the user asks)
textboard --list           # open named windows
```

## Never do this

- **Do not close everything with `pkill -f textboard` or the like.** It closes other projects' windows too
- Do not use another project's name for `--target`
- **Do not open textboard.html with `open "file://...?query"`** (the query is dropped and the window is empty). Do not open it with the Playwright MCP either
- Do not run wait in the foreground (the conversation stops until the user sends)

## Notes

- Window controls (for the user): `⌘S` save / select a passage and press `⌘⌥M` or "+ Comment" to comment (`Enter` to confirm) / click a comment's text to edit it in place (`Enter` to confirm, `Esc` to undo) / `Enter` in the bottom box sends (`Shift+Enter` for a new line; the `Enter` that confirms IME input does not send) / "Copy" puts the instruction and comments on the clipboard (for pasting into the conversation when wait is not running) / `⌘W` closes (twice with unsaved edits)
- State files are in `/tmp/textboard-<uid>/` (mode 700): per-name pids in targets, instructions not yet taken in outbox, logs of new windows in logs
- Comments are saved in `~/.textboard/comments/`; nothing is created next to the document (in the repository)
- The window and CLI messages are in Japanese or English, following the macOS language setting (`--lang ja|en` or `TEXTBOARD_LANG` to choose). The `opened ...` line and the JSON from wait are the same in every language
- How to change and verify the window itself: [docs/development.md](https://github.com/mohhh-ok/agent-boards/blob/main/docs/textboard-development.md)
