# agent-boards

macOS windows your coding agent (Claude Code etc.) opens to show you its work.

| Command | What it shows | Docs |
| --- | --- | --- |
| `moodboard` | Images, videos and audio side by side, to compare and pick | [docs/moodboard.md](docs/moodboard.md) |
| `textboard` | A text file you edit and comment on, sending instructions back to the agent | [docs/textboard.md](docs/textboard.md) |
| `reportboard` | A Markdown report (measurements, research, estimates), laid out to read | [docs/reportboard.md](docs/reportboard.md) |

## Requirements

- macOS (tested on macOS only)
- [bun](https://bun.sh)

## Setup

```sh
bun install -g github:mohhh-ok/agent-boards
npx skills add mohhh-ok/agent-boards
```

This installs all three commands. The skills in `skills/<command>/SKILL.md` tell your agent how to use each window; they follow the [Agent Skills](https://github.com/anthropics/skills) format.

## Development

- How the repository is split and what is shared: [docs/design.md](docs/design.md)
- Changing each window: [docs/moodboard-development.md](docs/moodboard-development.md), [docs/textboard-development.md](docs/textboard-development.md), [docs/reportboard-development.md](docs/reportboard-development.md)
- Tests: `bun test`

## License

MIT
