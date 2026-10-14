---
name: reportboard
description: A window for showing the user a report written in Markdown — measurements, investigations, comparisons, estimates — laid out by the tool, with an "Edit with AI" button on every section through which the user tells the AI (the calling agent) how to change that section, or asks about it. Use it instead of hand-writing HTML whenever you show the user a report, or when the user says "show me the report", "open it in reportboard" or "let me read the estimate". The report counterpart of moodboard and textboard.
---

# reportboard — show a Markdown report and revise it with the user, section by section

Open it with the `reportboard` command (a WKWebView window via bun + webview-bun). **No server or browser needed.** Do not write HTML or CSS for a report: write Markdown and let reportboard lay it out.

## Flow

1. Write the report as a Markdown file (where the project keeps such records, or under `/tmp/<project>/`)
2. Open it with `reportboard --target <name> <file.md>`
3. Start receiving right away (see "Receiving messages"): in Claude Code, `reportboard watch --target <name>` with the Monitor tool; elsewhere, `reportboard wait --target <name>` in the background
4. When the user sends something from a section, you get it as JSON (with watch, one line per message as a notification). From that moment the window shows the user that you are working on it, until you reply with `--done` (with wait, also until you start the next `wait`)
5. **Reply right away**, before reading files or editing, with one short line saying what you are going to do (`reportboard reply --thread <thread.id> "Adding a total row to the table"`)
6. If the message asks for a change (rewrite, add, remove, reorder, recalculate …), edit the Markdown file — the window reloads it by itself. If it is a question, answer it. Editing is a main use, not something to do only when a question happens to need it
7. While you work, reply again at each step that takes a while ("Checking the numbers against the spreadsheet", "Rewriting section B"). A reply cannot stream; each `reply` shows up as one message, so send several small ones rather than one at the end. When nothing changes in the window for long, the user gets uneasy
8. Finish with the result and `--done`: `reportboard reply --thread <thread.id> --done --file <reply.md>` (or the text as an argument). When you edited, say what you changed (which section, what is different now). Without `--done` the window keeps saying you are still working until your next `wait`
9. With wait, go back to 3 and run it again; watch keeps running. Messages the user sends while you work arrive meanwhile: answer each of them too

When nothing is receiving, the window tells the user to say "reportboard を見て" / "check reportboard" in the conversation. When they do, start `watch` (or run `wait`): messages sent meanwhile are handed over at once. If `reply` prints `unread N`, messages are waiting the same way: receive them now

## Opening

```sh
command -v reportboard >/dev/null || bun install -g github:mohhh-ok/agent-boards
reportboard --target <name> <file.md>; echo "rc=$?"
```

- Run it in the foreground. Do not add `nohup`, `&` or `disown`; the window lives in its own session and the launcher exits within seconds
- Use `--target` (start the name with the project name; letters, digits and `. _ -`). The same name switches the open window to the file. Without `--target` there is no way to receive messages from the window
- Report "opened" only when the rc is 0 and stdout has `opened target=...`. rc=2 means it was not shown in time (the log path is printed)
- Editing the file is enough to update the window; do not reopen it

## Writing the report so it reads well

- Put the conclusion right under the `#` title. Use `##` for sections (they become the contents) and `###` inside them. Every `##`/`###` and every breakdown row gets an "Edit with AI" button, so make headings and row names say what they are about
- For a breakdown of effort, cost or time, write one item per line as `- <name> — <number> <unit>` with the same unit on every line. It is shown with the number first and a bar, so the heavy items stand out. Under each item, write what it is made of as a nested list, one piece of work per line, and its assumptions and notes as a `>` quote. Do not run the pieces together in one sentence: the details are shown as written, and one long line is hard to read

  ```md
  - A. Camera check — 4.5 人日
    - AWS setup (IAM, policy, Pulumi) 0.5
    - Tests and a check on real devices 1

    > Withdrawals come through the existing contact form; no screen of their own
  - B. Selfie capture — 5.5 人日
    - Recording screen 1.5
  ```
- Put comparisons in a GFM table. Write numbers with their unit in the cell (`38 秒`, `12 円`) and nothing else; such columns get right-aligned bars
- Use `>` for notes. Do not write raw HTML (it is shown as text)

## Receiving messages

In Claude Code, run `watch` with the **Monitor** tool:

```sh
reportboard watch --target <name>
```

- It keeps running and prints each message as one line of JSON (the shape below, on one line), so each one arrives as a notification while you keep working and talking. Messages queued before it started come first. Each one is marked in the window as taken by the AI
- Monitor stops it after its time limit (30 minutes at most) and tells you so. Start it again right away. Stop it when the user is done with the window
- It ends with rc 3 when the user closes the window; then do not start it again

Without Monitor (Codex and others), run `reportboard wait --target <name>` in the background, and again as soon as it returns. Messages sent while nothing was receiving are all handed over at once: one as a JSON object, several as a JSON array, oldest first. Handle every one.

Each message:

```json
{ "file": "/path/report.md", "section": { "level": 2, "heading": "Results" },
  "thread": { "id": "t-…", "messages": [{ "from": "user", "text": "…", "at": "…" }, …] },
  "instruction": "the latest message", "reply": "reportboard reply --thread t-… --file <path>" }
```

- `thread.messages` is the whole conversation in that section (user and your past replies). Read it before editing or answering
- `section.row` is there when it was sent from a row of a breakdown (each row has its own button): `{ "level": 2, "heading": "内訳", "row": "A. カメラ本人認証 (identity-verification.md)" }`. The message is about that item — the line starting with that name under that heading, and what is nested under it. Change that item; when its number changes, check the total and anything else that adds it up
- rc: 0 = got some / 1 = the window is not open / 2 = `--timeout` passed / 3 = the user closed the window (stop receiving)
- The reply is plain text shown in the section. Keep it short. After an edit, say which part changed and how; for a question, answer it

## Closing

`reportboard --close <name>` closes the window. `reportboard --list` lists open ones.

Details: [docs/reportboard.md](https://github.com/mohhh-ok/agent-boards/blob/main/docs/reportboard.md)
