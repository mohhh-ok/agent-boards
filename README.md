# moodboard

A window for checking what your AI generated.

When your coding agent (Claude Code etc.) generates images, videos or audio, it opens them in moodboard, laid out side by side like prints on a light table. You look them over, compare the candidates, and tell the agent which one to keep. You don't open the files one by one, and the agent doesn't need to describe them in text.

https://github.com/user-attachments/assets/11d5acf0-a678-4173-bbcd-b4a53262e03f

What you can check:

- **Images**: PNG / WebP / animated GIF. Zoom in to the pixel, overlap two candidates, check transparency on a checkerboard
- **Videos**: mov / webm / mp4. They loop silently side by side; open one to watch it with sound
- **Audio**: wav / mp3 / m4a / aac / flac / ogg / opus. Each file is a player card, so you can listen to takes one after another

The agent can add a heading and a short label to each card ("current", "retake 2" …), so you know what you are comparing.

## Requirements

- macOS (tested on macOS only)
- [bun](https://bun.sh)

## Setup

Install the command, then give your agent the skill that tells it how to use moodboard:

```sh
bun install -g github:mohhh-ok/moodboard
npx skills add mohhh-ok/moodboard
```

The skill follows the [Agent Skills](https://github.com/anthropics/skills) format.

After that, ask your agent to "show me in moodboard" or "put them side by side", and a window opens with the files. The agent reuses the same window for the same task, so new results replace the old ones instead of piling up windows.

## Checking the results

When you find the one you want, tell the agent — or select cards and copy their paths ([Copy file paths](#copy-file-paths)) to paste back into the conversation.

### Controls

| Action | What happens |
| --- | --- |
| wheel / pinch | Resize the card under the cursor (up = bigger, like Google Maps) |
| drag | Move a card freely. Cards can overlap, and the one you grab comes to the front |
| click | Open the card full-size (images and videos) |
| `r` | Put every card back in its original layout |
| `b` | Switch background: dark → checkerboard → white (use checkerboard to check transparency) |
| slider, `+` / `-` | Change the base size of all cards |
| `s` | Selection mode (see below) |
| `⌘W` (`Ctrl+W`) | Close the window. Works in the full-size view and in selection mode too |

In the full-size view: `0` = fit to window, `1` = actual pixels, `2` = 200%, `←` / `→` = previous / next, `m` = sound on/off, `Esc` = close.

At 200% of the actual pixels or more (on the table or full-size), pixels are shown sharp, without smoothing.

When you resize the window, the cards are re-laid out automatically. Once you have moved or resized a card yourself, this stops so your placement is kept; press `r` to lay everything out again.

#### Videos and audio

- Videos play muted and on loop on the table. Open one full-size to hear it; sound is on by default there and `m` toggles it
- An audio card has a play button, a seek bar and the time. Click anywhere on the card to play or pause. The card that is playing turns green
- Only one thing makes sound at a time: starting an audio card pauses the others, and opening a video full-size pauses any audio card that is playing
- A file that can't be played shows "Can't play" with its file name. Some VP9 `.webm` files with transparency don't play; HEVC `.mov` with transparency does

#### Copy file paths

Press `s` to enter selection mode. Each card gets a checkbox, and clicking a card toggles it. The "Copy" button, or `⌘C`, copies the absolute paths of the selected files to the clipboard, one per line. `⌘A` selects all and `Esc` leaves selection mode. Paste them into the conversation to tell the agent which files you picked.

## Commands (what the agent runs)

You normally don't type these yourself; the skill teaches them to the agent. You can still run them from a terminal.

```sh
moodboard a.png b.png c.webp
```

A window opens with the three images side by side. Paths can be relative or absolute, and may contain spaces or non-ASCII characters.

### Reuse one window

```sh
moodboard --target logo v1.png v2.png
# replaces the contents of the "logo" window
moodboard --target logo v3.png v4.png
```

If a window with that name is already open, its contents are replaced and the window stays where it is. If not, a new window opens under that name. The name also becomes the window title. Names may use letters, digits and `. _ -`.
Without `--target`, every call opens a new window.

```sh
# show the open named windows
moodboard --list
# close only the "logo" window
moodboard --close logo
```

When several projects or agents share one machine, give each one its own name (the project directory name, for example). Close windows with `--close <name>`. Don't use `pkill`, because it closes every project's windows.

### Headings and labels

To group files under headings, or to put a short label on each card, write a board JSON file and pass it with `--json`:

```sh
moodboard --target voice --json board.json
```

```json
{
  "sections": [
    {
      "title": "take A",
      "note": "The script these takes were read from.\nNewlines are kept.",
      "items": [
        { "path": "/tmp/project/take_prod.wav", "label": "current production" },
        { "path": "take_2.wav", "label": "retake 2" }
      ]
    }
  ]
}
```

The window shows each section as a block from top to bottom: heading, note, then its cards.

### Board JSON

- `sections` (required, non-empty): the list of blocks
- `title`, `note` (optional): the heading and the text under it
- `items` (required, non-empty): `path` (required) is absolute, or relative to the JSON file's directory. `label` (optional) is shown under the card; the file name is shown when it is omitted
- Unknown keys, wrong types, empty `sections` / `items` and missing files are rejected with exit code 1, before any window opens
- `--json` cannot be combined with a list of paths. `moodboard <paths...>` is the same as one section with no heading and no labels

### Language

The window and the error messages are shown in Japanese or English. moodboard follows the first language in macOS System Settings (`defaults read -g AppleLanguages`, not `$LANG`): Japanese if it is Japanese, English otherwise.
To choose one yourself, put `--lang ja` or `--lang en` before the other arguments, or set `MOODBOARD_LANG=ja|en`. `--lang` wins over `MOODBOARD_LANG`.

```sh
moodboard --lang en --target logo v1.png v2.png
```

The `opened ...` line on success is for scripts and stays the same in every language.

### Exit codes

`moodboard` waits until the window has actually loaded the files, then exits. You can run it in the foreground; the window stays open after the command ends. Agents and scripts can check the exit code to know whether the files are really on screen:

| code | meaning |
| --- | --- |
| 0 | Shown. Prints `opened target=<name> pid=<pid> 新規\|差し替え images=<n>` (新規 = new window, 差し替え = replaced) |
| 1 | Bad arguments, an invalid board JSON, or a missing file |
| 2 | Could not confirm the window within 20 s (for a new window, the log path is printed) |
| 3 | Shown, but some files failed to load (they are listed) |

## Development

Notes for changing the viewer itself (how to verify changes, how it works inside) are in [docs/development.md](docs/development.md).

## License

MIT
