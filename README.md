**English** | [Русский](README_ru.md) | [Français](README_fr.md) | [Español](README_es.md) | [中文](README_zh.md)

---

# Vibe Coding Kanban

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-blueviolet.svg)](https://claude.ai/code)

**Vibe coding kanban for Claude Code** — orchestrate multiple AI coding sessions from a single browser tab.

Queue your tasks, press Start, and let Claude Code work through them one by one. Rate limit hits? The board detects it, shows a countdown, and resumes automatically when ready.

<video src="https://github.com/user-attachments/assets/7619b292-83b5-4b10-962b-0accee73841b" controls width="100%"></video>

---

## Features

**Task Management**
- Drag-and-drop kanban: Backlog → In Progress → Review → Done
- Priority levels: High, Medium, Low, Hold — with visual indicators
- Search and filter by text, priority, or project path
- File and URL attachments on tasks
- Return a task to In Progress with a new prompt (re-run with context)

**AI Orchestration**
- Auto-queue: tasks from Backlog start in Claude Code automatically
- Rate-limit detection with countdown timer and auto-resume (sends "continue" when limit resets)
- Auto-approve mode for Claude Code permission prompts
- `/compact` every 10 tasks per terminal to conserve context tokens
- Task stays in **In Progress** during rate limit — moves to Review only after Claude truly finishes

**Terminal Management**
- Real-time xterm.js terminals with WebGL rendering
- One terminal per project path — multiple projects run in parallel
- Helper terminal for drafting task prompts
- Persistent PTY sessions that survive browser refresh
- WebSocket-based live output streaming

**UX**
- Dark and light themes
- Resizable kanban / terminal split panel
- Collapsible columns
- Real-time logs panel

---

## Quick Start

```bash
git clone https://github.com/kekoborn/vibe-coding-kanban.git
cd vibe-coding-kanban
npm install
npm start
```

Open **http://localhost:3000** in your browser.

---

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** installed and authenticated (`claude` available in your PATH)
- **macOS or Linux** (required by `node-pty` for terminal emulation)

---

## How It Works

1. **Create tasks** — add titles and Claude Code prompts to the Backlog
2. **Press "▶ Start queue"** — tasks move to In Progress and Claude Code starts working
3. **Watch live** — terminal panel streams Claude Code output in real time
4. **Auto-complete** — when Claude returns to its prompt (idle detection), the task moves to Review
5. **Rate limit?** — board shows countdown, waits for reset, sends "continue" automatically

---

## Architecture

```
claude-kanban/
├── server.js       — Express + WebSocket server, PTY management, rate-limit & auto-approve logic
├── db.js           — SQLite database layer (better-sqlite3, WAL mode)
└── public/
    ├── index.html  — Single-page app shell
    ├── app.js      — Kanban board logic, drag-and-drop, modals, filters, WS client
    ├── terminal.js — Terminal manager (xterm.js, tab management, PTY lifecycle)
    ├── styles.css  — Full dark/light theme styling
    └── favicon.svg — Kanban board icon
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Server | Node.js, Express, ws (WebSocket) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Terminal | @lydell/node-pty, xterm.js v5 + WebGL |
| Frontend | Vanilla JS, SortableJS, CSS custom properties |
| File uploads | Multer |

---

## Configuration

| Variable / Constant | Default | Description |
|---------------------|---------|-------------|
| `PORT` env var | `3000` | HTTP server port |
| `IDLE_COMPLETE_DELAY` | `10000` ms | Seconds of no output before task completes |
| `PROMPT_COMPLETE_DELAY` | `3000` ms | Time after Claude prompt detected before completing |
| `COMPACT_EVERY_N_TASKS` | `10` | Send `/compact` every N tasks to save tokens |

---

## Contributing

Issues and pull requests are welcome! Please open an issue first for major changes.

---

## License

MIT — see [LICENSE](LICENSE)
