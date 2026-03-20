# Claude Kanban

Kanban-оркестратор для Claude Code. Веб-UI: канбан (слева) + терминалы (справа).

## Стек
- Node.js, Express, WebSocket (ws), better-sqlite3, node-pty
- Vanilla JS, xterm.js, SortableJS

## Запуск
```bash
npm start    # production
npm run dev  # development (auto-reload)
```
Порт: 3000

## Структура
- `server.js` — Express + WebSocket сервер, управление PTY, авто-approve, rate-limit
- `db.js` — SQLite database layer
- `public/` — фронтенд (HTML/CSS/JS)
