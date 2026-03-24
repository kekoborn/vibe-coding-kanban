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

**Rate-limit (server.js):**
- `rateLimitDetected` — sticky-флаг, ставится в `onData` (не в poll), не теряется при ротации буфера
- При обнаружении: задача ОСТАЁТСЯ в in_progress, ждёт сброса лимита
- `rateLimitUntil` — timestamp, блокирует idle/prompt detection пока лимит активен
- После сброса: `p.write('продолжи\r')` → broadcast `ratelimit:resolved`
- Флаг сбрасывается в `p._promptReset()` и по истечении таймера

**Auto-approve:**
- Основной путь: `onData` + debounce 400ms — ловит промпты до ротации буфера
- Резервный путь: poll каждые 3 секунды (fallback)
- Промпты: `Do you want to`, `Run command`, `(y/n)`, `Enter to confirm`, `esc to cancel`

**Idle/Prompt completion detection:**
- `IDLE_COMPLETE_DELAY = 10000ms` — пауза без вывода → задача в review
- `PROMPT_COMPLETE_DELAY = 3000ms` — стабильный `❯` → задача в review
- Оба блокируются пока `rateLimitUntil` активен

**JSONL checkpoint (Claude Response):**
- При старте задачи: `getJsonlCheckpoint(project_path)` сохраняет текущий номер строки в JSONL
- При завершении: `extractLastResponseFromJSONL` читает только строки ПОСЛЕ checkpoint
- Исключает захват ответов от других задач в той же PTY-сессии
- При пустом `project_path` — ищет JSONL в HOME (`~/.claude/projects/-Users-{user}/`)

**Терминалы:**
- Один PTY на `project_path` — несколько проектов параллельно
- PTY сессии переживают перезагрузку страницы (persistent)
- `termTaskMap` — маппинг termId → `{ taskId, jsonlCheckpoint, ... }`

**БД:**
- Путь захардкожен: `path.join(__dirname, 'kanban.db')`
- Нет env-переменной для смены пути — копируй всю папку для изоляции

## Конфигурация

| Константа | Значение | Описание |
|-----------|----------|----------|
| `PORT` (env) | 3000 | HTTP порт |
| `IDLE_COMPLETE_DELAY` | 45000 ms | Пауза без вывода → завершение (было 10000 — слишком агрессивно) |
| `PROMPT_COMPLETE_DELAY` | 3000 ms | Ожидание после промпта Claude |
| `COMPACT_EVERY_N_TASKS` | 10 | `/compact` каждые N задач |

## Известные ограничения

- `PROMPT_COMPLETE_DELAY = 3000ms` — может срабатывать раньше времени если `❯` появляется во время stop hook
- `/compact` каждые N задач: во время compact `❯` детектируется → race condition с idle detection

## Деплой

Публичный репо: https://github.com/kekoborn/vibe-coding-kanban
Лицензия: MIT, author: kekoborn
