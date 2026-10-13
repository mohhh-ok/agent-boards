---
name: reportboard
description: A window for showing the user a report written in Markdown — measurements, investigations, comparisons, estimates — laid out by the tool, with a button on every section for the user to ask the AI (the calling agent) about it. Use it instead of hand-writing HTML whenever you show the user a report, or when the user says "show me the report", "open it in reportboard" or "let me read the estimate". The report counterpart of moodboard and textboard.
---

# reportboard — show a Markdown report and answer questions per section

Open it with the `reportboard` command (a WKWebView window via bun + webview-bun). **No server or browser needed.** Do not write HTML or CSS for a report: write Markdown and let reportboard lay it out.

## Flow

1. Write the report as a Markdown file (where the project keeps such records, or under `/tmp/<project>/`)
2. Open it with `reportboard --target <name> <file.md>`
3. Run `reportboard wait --target <name>` **in the background**
4. When the user asks something from a section, wait prints JSON and exits with rc=0
5. Answer with `reportboard reply --thread <thread.id> --file <answer.md>` (or the text as an argument). If the question needs the report changed, edit the Markdown file first (the window reloads it), then say in the reply what you changed
6. Go back to 3

## Opening

```sh
command -v reportboard >/dev/null || bun install -g github:mohhh-ok/agent-boards
reportboard --target <name> <file.md>; echo "rc=$?"
```

- Run it in the foreground. Do not add `nohup`, `&` or `disown`; the window lives in its own session and the launcher exits within seconds
- Use `--target` (start the name with the project name; letters, digits and `. _ -`). The same name switches the open window to the file. Without `--target` there is no way to receive questions
- Report "opened" only when the rc is 0 and stdout has `opened target=...`. rc=2 means it was not shown in time (the log path is printed)
- Editing the file is enough to update the window; do not reopen it

## Writing the report so it reads well

- Put the conclusion right under the `#` title. Use `##` for sections (they become the contents) and `###` inside them. Every `##`/`###` gets an "Ask the AI" button, so make headings name what the section is about
- For a breakdown of effort, cost or time, write one item per line as `- <name> — <number> <unit>。<details>` with the same unit on every line. It is shown with the number first and a bar, so the heavy items stand out
- Put comparisons in a GFM table. Write numbers with their unit in the cell (`38 秒`, `12 円`) and nothing else; such columns get right-aligned bars
- Use `>` for notes. Do not write raw HTML (it is shown as text)

## Receiving questions

`wait` prints:

```json
{ "file": "/path/report.md", "section": { "level": 2, "heading": "Results" },
  "thread": { "id": "t-…", "messages": [{ "from": "user", "text": "…", "at": "…" }, …] },
  "instruction": "the latest message", "reply": "reportboard reply --thread t-… --file <path>" }
```

- `thread.messages` is the whole conversation in that section (user and your past replies). Read it before answering
- rc: 0 = got one / 1 = the window is not open / 2 = `--timeout` passed / 3 = the user closed the window (stop waiting)
- The reply is plain text shown in the section; keep it short and say what you changed in the file, if anything

## Closing

`reportboard --close <name>` closes the window. `reportboard --list` lists open ones.

Details: [docs/reportboard.md](https://github.com/mohhh-ok/agent-boards/blob/main/docs/reportboard.md)
