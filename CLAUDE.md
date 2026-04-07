# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Vibe Coding Kanban

Vibe coding kanban для Claude Code. Веб-UI: канбан (слева) + терминалы (справа).
Опубликован: **github.com/kekoborn/vibe-coding-kanban**

## Запуск

```bash
npm start    # production, порт 3000
npm run dev  # development (auto-reload)
PORT=9999 node server.js  # на кастомном порту
```

## Команды Claude Code

| Команда | Описание |
|---------|---------|
| `/kanban-lead` | Интервью → план → создать задачи |
| `/work` | Автономный режим: взять задачу → выполнить → закоммитить → следующая |
| `/next` | Взять следующую задачу и начать работу |
| `/status` | Отчёт: колонки, аналитика, активные проекты |

## RalfLoop — автономный ночной режим

Паттерн: Claude работает сам, пока не закончатся задачи в backlog.

**Как работает:**
1. Stop hook (`hooks/stop-hook.sh`) перехватывает выход Claude
2. Запрашивает `GET /api/tasks/next` — если есть задача, блокирует выход (exit 2)
3. Выводит задачу в терминал — Claude продолжает с новым промптом
4. Цикл завершается когда backlog пуст (hook возвращает exit 0)

**Установка stop hook** — добавить в `.claude/settings.json` проекта:
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "bash /Users/ruslanalyev/Documents/Projects/claude-kanban/hooks/stop-hook.sh"
      }]
    }]
  }
}
```

**Запуск автономного режима:**
```bash
claude --dangerously-skip-permissions
```

Или через UI: включить Auto-queue + Auto-approve на доске.

Для чистого инстанса (видео, демо): скопируй папку в /tmp, удали kanban.db, запусти с PORT=.

## Стек

- Node.js, Express, WebSocket (ws), better-sqlite3 (WAL), node-pty, multer
- Vanilla JS, xterm.js v5 + WebGL, SortableJS
- PTY: `@lydell/node-pty` (форк с поддержкой новых Node)

## Архитектура

```
server.js   — Express + WebSocket, PTY lifecycle, rate-limit, idle/prompt detection, auto-approve, auto-queue
db.js       — SQLite CRUD (задачи, колонки, позиции, settings, analytics events)
public/
  app.js      — канбан, drag-and-drop, фильтры, WS-клиент, модалки
  terminal.js — xterm.js, PTY-вкладки, attach/detach, onTaskCompleted
  styles.css  — dark/light theme через CSS custom properties
  index.html  — SPA shell
skills/kanban-lead.md  — задача-планировщик (авто-установка в ~/.claude/commands/)
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
- `IDLE_COMPLETE_DELAY = 45000ms` — пауза без вывода → задача в review
- `PROMPT_COMPLETE_DELAY = 7000ms` — стабильный `❯` → задача в review
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

**Multi-tab безопасность:**
- Каждый браузерный таб получает уникальный `CLIENT_ID` (UUID)
- `task:run` рассылается ТОЛЬКО на вкладку, которая запустила задачу
- Состояние `autoApprove` / `autoQueue` синхронизируется на всех вкладках при реконнекте

**Auto-queue:**
- Серверная очередь (SQLite settings `autoQueueEnabled`) — задачи запускаются без браузера
- На macOS: при наличии задач в очереди запускается `caffeinate -i` (убивается когда очередь пуста)
- При старте сервера: задачи в `in_progress` сбрасываются в `backlog`

**БД:**
- Путь захардкожен: `path.join(__dirname, 'kanban.db')`
- Нет env-переменной для смены пути — копируй всю папку для изоляции

## Конфигурация

| Константа | Значение | Описание |
|-----------|----------|----------|
| `PORT` (env) | 3000 | HTTP порт |
| `IDLE_COMPLETE_DELAY` | 45000 ms | Пауза без вывода → завершение |
| `PROMPT_COMPLETE_DELAY` | 7000 ms | Ожидание после промпта Claude |
| `TASK_START_DELAY` | 4000 ms | Пауза перед отправкой следующей задачи |
| `MAX_CONCURRENT_TASKS` | 5 | Макс. параллельных задач (0 = без лимита) |
| `COMPACT_EVERY_N_TASKS` | 10 | `/compact` каждые N задач |

## Известные ограничения

- `PROMPT_COMPLETE_DELAY` — может срабатывать раньше времени если `❯` появляется во время stop hook
- `/compact` отправляется ДО промпта задачи — poll может сработать на `❯` после compact (race condition)

## Деплой

Публичный репо: https://github.com/kekoborn/vibe-coding-kanban
Лицензия: MIT, author: kekoborn
