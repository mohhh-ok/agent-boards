# reportboard

A window for reading a report your AI wrote, and revising it with the AI section by section.

When your coding agent (Claude Code etc.) finishes a measurement, an investigation or an estimate, it writes the report in Markdown and opens it in reportboard. The window lays it out the same way every time, follows the file while the agent rewrites it, and lets you tell the agent how to change a section — or ask about it — right where you are reading.

## Opening a report

```sh
reportboard --target <name> report.md
```

- `--target` works as in moodboard: a window with the same name is reused and switched to the new file. Without `--target` a new unnamed window opens (it cannot talk to the AI; see below)
- When the file changes on disk, the window reloads it and keeps the scroll position. The top bar says when it reloaded. Table rows, list items, paragraphs and headings that are new or different since the previous version get a mark (a bar on the left and a light tint) until the next reload, and the top bar shows "N changes — show", which moves to each in turn
- `reportboard --close <name>` closes that window; `reportboard --list` lists the open named windows
- Exit codes: 0 = shown / 1 = bad arguments or path / 2 = not shown in time / 3 = the window opened but could not read the report (the reason is printed)

## How the report is laid out

The look is fixed by reportboard; the Markdown only says what is in the report. GFM (tables, task lists) is supported.

- The first `#` heading is the title. `##` headings make the contents on the left of a wide window
- A list where every item starts with `<name> — <number> <unit>` (two items or more, the same unit) is shown as a breakdown: the number first in large type, a bar showing it against the largest in the list, then the name and the details. Long details are cut to two lines; click the row to read the rest, or "Open all details" above the list

  Text after the number on the first line, a nested list and `>` notes under an item are its details, shown as written (a nested list stays a plain list, without bars)

  ```md
  - A. Camera check — 4.5 人日
    - Setup 0.5
    - Adapter 0.5

    > Assumes the existing contact form
  - B. Selfie capture — 5.5 人日
    - Recording screen 1.5
  ```

- A table column whose cells are all numbers with the same unit is right-aligned, with a bar under each number. A row whose first cell is 合計 / 小計 / Total (and the like) is a total: set in bold under a rule, with no bars, and left out of the bars of the other rows
- Quantities with a unit (`人日`, `%`, `円`, `件` …) in running text are set in bold
- Long lists use two columns in a wide window
- `>` quotes are notes, shown at the same size as the text
- Raw HTML in the Markdown is shown as text, not run
- Links to web pages open in the browser. Links to local files reveal the file in Finder; reportboard never opens or runs them

## Revising a section with the AI

In a named window, every `##` and `###` heading has an "Edit with AI" button. It opens a box under the heading: write how the section should change ("add a total row", "shorten this") or a question, and press Enter (Shift+Enter for a new line; the Enter that confirms Japanese or other IME input does not send). When you ask for a change, the agent edits the Markdown, the window reloads it, and the agent's reply in the same box says what it changed. A question gets an answer there. You can keep going in the same box. A section that already has a conversation shows it when the report opens.

Each row of a breakdown has its own "Edit with AI" too, under its details when the row is open (a row with short details still opens, to show the button). Its box spans the row, and pressing the button or typing in the box does not close the row. What you send there is about that item ("cut the tests to 0.5", "why is this 4.5?").

On the agent's side:

```sh
reportboard wait --target <name> [--timeout <seconds>]
reportboard reply --thread <id> "answer"        # or: --file <path>
```

`wait` prints what you sent as JSON and exits:

```json
{
  "id": "1791851596999-ee1bc1c1",
  "target": "estimate",
  "file": "/path/report.md",
  "section": { "level": 2, "heading": "Results" },
  "thread": { "id": "t-90e7e7ef64ac", "messages": [{ "from": "user", "text": "…", "at": "…" }] },
  "instruction": "…",
  "reply": "reportboard reply --thread t-90e7e7ef64ac --file <path>",
  "sentAt": "…"
}
```

`thread.messages` holds the whole conversation of that section, including this message. When it was sent from a breakdown row, `section` also has `row`: the row's name as shown (code marks dropped), under the heading in `heading` (`level` 0 and `heading` "" when the breakdown is above every heading):

```json
"section": { "level": 2, "heading": "内訳", "row": "A. カメラ本人認証 (identity-verification.md)" }
```

 Exit codes of `wait`: 0 = got one / 1 = the window is not open / 2 = `--timeout` passed / 3 = the window was closed. Messages sent while nobody waits are kept for the next `wait`, and the box tells you whether the AI is waiting.

The agent edits the report when the message asks for a change and answers when it asks a question; either way it replies in the thread, saying what it changed.

Conversations are kept in `~/.reportboard/threads/` (one file per report, named by the hash of its path), not next to the report. They survive reloading and reopening. Each one stays with its heading by text; if that heading disappears, the conversation moves to "Conversations whose heading is gone" at the end. Moving or renaming the report detaches its conversations.

## Language

Window and messages are in Japanese or English: `--lang ja|en` > `REPORTBOARD_LANG` > the first language in macOS System Settings.

## Known limitations

- If the same report is open in two named windows and you start a conversation on the same heading in both before either has seen the other's, two conversations are created for that heading and the window shows only one of them. The other is still saved in `~/.reportboard/threads/`
