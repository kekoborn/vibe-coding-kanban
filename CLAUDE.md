# Vibe Coding Kanban

Vibe coding kanban для Claude Code. Веб-UI: канбан (слева) + терминалы (справа).
Опубликован: **github.com/kekoborn/vibe-coding-kanban**

## Запуск

```bash
npm start    # production, порт 3000
npm run dev  # development (auto-reload)
PORT=9999 node server.js  # на кастомном порту
```

Для чистого инстанса (видео, демо): скопируй папку в /tmp, удали kanban.db, запусти с PORT=.

## Стек

- Node.js, Express, WebSocket (ws), better-sqlite3 (WAL), node-pty, multer
- Vanilla JS, xterm.js v5 + WebGL, SortableJS
- PTY: `@lydell/node-pty` (форк с поддержкой новых Node)

## Архитектура

```
server.js   — Express + WebSocket, PTY lifecycle, rate-limit, idle/prompt detection, auto-approve
db.js       — SQLite CRUD (задачи, колонки, позиции)
public/
  app.js      — канбан, drag-and-drop, фильтры, WS-клиент, модалки
  terminal.js — xterm.js, PTY-вкладки, attach/detach, onTaskCompleted
  styles.css  — dark/light theme через CSS custom properties
  index.html  — SPA shell
```

## Ключевые паттерны

**Rate-limit (server.js ~628-668):**
- Обнаруживается по строке `youvehityourlimit` в PTY output
- При обнаружении: задача ОСТАЁТСЯ в in_progress, НЕ переходит в review
- `rateLimitUntil` — timestamp, блокирует idle/prompt detection пока лимит активен
- После сброса: `p.write('продолжи\r')` → broadcast `ratelimit:resolved`

**Idle detection:**
- `IDLE_COMPLETE_DELAY = 10000ms` — таймер без вывода
- `PROMPT_COMPLETE_DELAY = 3000ms` — таймер после обнаружения промпта Claude
- Оба блокируются пока `rateLimitUntil` активен

**Терминалы:**
- Один PTY на `project_path` — несколько проектов параллельно
- PTY сессии переживают перезагрузку страницы (persistent)
- `termTaskMap` — маппинг termId → текущий taskId

**БД:**
- Путь захардкожен: `path.join(__dirname, 'kanban.db')`
- Нет env-переменной для смены пути — копируй всю папку для изоляции

## Конфигурация

| Константа | Значение | Описание |
|-----------|----------|----------|
| `PORT` (env) | 3000 | HTTP порт |
| `IDLE_COMPLETE_DELAY` | 10000 ms | Пауза без вывода → завершение |
| `PROMPT_COMPLETE_DELAY` | 3000 ms | Ожидание после промпта Claude |
| `COMPACT_EVERY_N_TASKS` | 10 | `/compact` каждые N задач |

## Деплой

Публичный репо: https://github.com/kekoborn/claude-kanban
Лицензия: MIT, author: kekoborn
