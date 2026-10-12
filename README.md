# textboard

A window for revising text together with your AI.

When your coding agent (Claude Code etc.) writes a document — a README, an article, a spec — it opens the file in textboard. You edit the text directly, leave comments on any passage, and send an instruction back to the agent ("address my comments", "make it shorter"). The agent rewrites the file, and the window reloads it. It is the text counterpart of [moodboard](https://github.com/mohhh-ok/moodboard).

What you can do in the window:

- **Edit**: the file is shown as plain text (Markdown source as is). Type to change it, `⌘S` to save
- **Comment**: select a passage and add a comment. Comments sit in the margin next to the passage they belong to, and stay attached when the text around them changes
- **Instruct**: write an instruction at the bottom and send it. The agent that opened the window receives it together with all comments and their line numbers

The AI is not built in. The agent that opened the window does the rewriting.

## Requirements

- macOS (tested on macOS only)
- [bun](https://bun.sh)

## Setup

Run it from a clone of this repository:

```sh
git clone https://github.com/mohhh-ok/textboard.git
cd textboard && bun install
./textboard.ts --target demo README.md
```

Give your agent the skill in [skills/textboard/SKILL.md](skills/textboard/SKILL.md), which tells it how to open the window and receive your instructions. The skill follows the [Agent Skills](https://github.com/anthropics/skills) format.

## Using the window

### Editing

The text is edited as is: Markdown is not rendered, so what you see is exactly what is in the file. The header shows "Unsaved" while you have changes. `⌘S` (or the Save button) writes the file. Line endings (LF / CRLF) are kept.

### Comments

Select a passage. A "+ Comment ⌘⌥M" button appears in the margin; click it or press `⌘⌥M`, write the comment, and press `Enter` (`Shift+Enter` for a new line, `Esc` to cancel). The passage is highlighted and the comment is shown beside it. Click inside a highlighted passage to bring its comment forward; click a comment's quote or line number to jump to its passage.

To change a comment, click its text and type. Press `Enter` or click elsewhere to keep the change (`Shift+Enter` for a new line); `Esc` undoes it. Clearing the text keeps the previous comment; use "Delete" to remove one.

- Editing inside the window moves comments with the text. Editing inside a commented passage keeps the comment on the edited passage
- When the file changes outside the window (the agent rewrote it), each comment is found again by the text it quoted and the text around it. A comment whose passage is gone is listed under "Comments that lost their place". Select a new passage and use "Attach to selection" to put it back, or delete it
- Comments are saved in `~/.textboard/comments/<sha256 of the file's absolute path>.json` (the JSON also holds the absolute path), so nothing is added to your repository. The comments file is deleted when the last comment is deleted. Opening the same file later brings the comments back
- Comments are keyed by the file's absolute path: if you move or rename the file, its comments are not found any more

### Sending an instruction to the AI

Write the instruction in the box at the bottom and press `Enter` (or "Send to AI"). `Shift+Enter` starts a new line. The `Enter` that confirms Japanese (or other IME) input does not send. Unsaved edits are saved first. The status line under the box tells you whether the agent is listening and when it picked up your instruction.

You can send with an empty instruction if you only want the agent to address your comments.

"Copy" puts the same instruction and comments on the clipboard as plain text, for pasting into the conversation when the agent is not listening.

### When the file changes outside

- No unsaved edits: the window reloads the file and says so
- Unsaved edits: the window does not reload. A bar offers "Load the outside version (discard my edits)" or "Overwrite with my version". Sending is blocked until you choose

### Keys

| Key | What happens |
| --- | --- |
| `⌘S` | Save |
| `⌘⌥M` | Comment on the selection |
| `Enter` | Send the instruction (in the instruction box) / save a comment you are writing or changing. `Shift+Enter` for a new line. The `Enter` that confirms IME input does neither |
| `Esc` | Cancel the comment you are writing, or undo the change to a comment |
| `⌘Z` / `⌘⇧Z`, `⌘X` / `⌘C` / `⌘V`, `⌘A` | Undo / redo, cut / copy / paste, select all (from the Edit menu) |
| `⌘W` | Close the window. With unsaved edits, the first `⌘W` warns and a second one closes |

## Commands (what the agent runs)

You normally don't type these yourself; the skill teaches them to the agent.

### Open a file

```sh
./textboard.ts --target <name> <file>
```

If a window with that name is already open, it switches to the file and stays where it is. If not, a new window opens. Names may use letters, digits and `. _ -`. `--target` is required, because instructions are delivered by name.

```sh
./textboard.ts --list           # show the open named windows
./textboard.ts --close <name>   # close only that window (unsaved edits are lost)
```

Exit codes:

| code | meaning |
| --- | --- |
| 0 | Shown. Prints `opened target=<name> pid=<pid> 新規\|差し替え file=<path>` (新規 = new window, 差し替え = replaced) |
| 1 | Bad arguments, a missing file, or not a text file (larger than 5 MB, or contains NUL) |
| 2 | Could not confirm the window within 20 s (for a new window, the log path is printed) |
| 3 | The window has unsaved edits, so it was not switched to the new file |

### Receive instructions

```sh
./textboard.ts wait --target <name> [--timeout <seconds>]
```

`wait` blocks until the user sends an instruction from the window named `<name>`, prints it as JSON on stdout and exits with 0. Agents run it in the background and read the output when it finishes. Instructions sent while no `wait` is running are kept and handed to the next `wait`, oldest first.

```json
{
  "id": "1791764935089-9b15d890",
  "target": "demo",
  "file": "/Users/me/project/README.md",
  "instruction": "Address my comments. Make it a bit shorter overall.",
  "comments": [
    {
      "id": "cmv4ikrhntddz",
      "line": 7,
      "endLine": 7,
      "quote": "the passage the user selected",
      "comment": "what the user wrote about it"
    },
    {
      "id": "cmv4ikrhr4cgn",
      "line": null,
      "endLine": null,
      "quote": "a passage that is no longer in the file",
      "comment": "…",
      "lost": true
    }
  ],
  "savedBeforeSend": true,
  "sentAt": "2026-10-12T00:28:55.089Z"
}
```

- `file`: absolute path. The file on disk already contains every edit the user made; unsaved edits are saved before sending
- `instruction`: may be empty when the user only wants the comments addressed
- `comments`: every comment in the window at that moment, sorted by line. `line` / `endLine` are 1-based and match the file on disk. `lost: true` marks a comment whose passage can no longer be found (`line` is `null`)
- `savedBeforeSend`: `true` when the window saved unsaved edits just before sending, so the file changed since the agent last read it

Exit codes:

| code | meaning |
| --- | --- |
| 0 | Received. The JSON is on stdout |
| 1 | Bad arguments, or no window with that name is open (and nothing is queued) |
| 2 | `--timeout` passed with no instruction |
| 3 | The window was closed while waiting |

### Language

The window and the error messages are shown in Japanese or English, following the first language in macOS System Settings (not `$LANG`). Put `--lang ja` or `--lang en` before the other arguments, or set `TEXTBOARD_LANG=ja|en`, to choose. The `opened ...` line and the JSON from `wait` are the same in every language.

## Development

Notes for changing the window itself are in [docs/development.md](docs/development.md). Run the tests with `bun test`.

## License

MIT
