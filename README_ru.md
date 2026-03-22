[English](README.md) | **Русский** | [Français](README_fr.md) | [Español](README_es.md) | [中文](README_zh.md)

---

# Vibe Coding Kanban

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-blueviolet.svg)](https://claude.ai/code)

**Vibe coding kanban для Claude Code** — управляйте несколькими AI-сессиями из одной вкладки браузера.

Добавляйте задачи, нажимайте «Старт» — и Claude Code выполняет их по очереди. Достигли rate limit? Доска обнаружит это, покажет обратный отсчёт и автоматически продолжит работу когда лимит сбросится.

<video src="https://github.com/user-attachments/assets/7619b292-83b5-4b10-962b-0accee73841b" controls width="100%"></video>

---

## Возможности

**Управление задачами**
- Drag-and-drop канбан: Backlog → In Progress → Review → Done
- Приоритеты: High, Medium, Low, Hold — с визуальными индикаторами
- Поиск и фильтрация по тексту, приоритету, проекту
- Вложения: файлы и ссылки
- Возврат задачи в In Progress с новым промптом (повтор с контекстом)
- Done-карточки показывают дату создания, многострочный заголовок и действия при наведении (Re-run, Delete)

**AI-оркестрация**
- Auto-queue: задачи из Backlog автоматически берутся в работу
- **Серверный auto-queue** — задачи выполняются даже без открытого браузера (headless-режим)
- **MaxTerminals синхронизируется между вкладками** — лимит параллельных терминалов хранится на сервере и рассылается всем клиентам
- Обнаружение rate limit с обратным отсчётом и авто-продолжением
- Режим авто-approve для разрешений Claude Code (сбрасывается в OFF при загрузке страницы для безопасности)
- `/compact` каждые 10 задач для экономии токенов
- Задача остаётся в **In Progress** во время rate limit — переходит в Review только после завершения
- `caffeinate` не даёт Mac уснуть пока задачи в очереди или выполняются

**Терминалы**
- Real-time терминалы на xterm.js с WebGL-рендерингом
- Один терминал на проект — несколько проектов работают параллельно
- Вспомогательный терминал для написания промптов
- PTY-сессии, которые переживают перезагрузку страницы
- Потоковая передача вывода через WebSocket

**UX**
- Тёмная и светлая темы
- Изменяемый разделитель канбан/терминал — layout автоматически адаптируется при ресайзе окна
- Сворачиваемые колонки
- Панель логов в реальном времени

---

## Быстрый старт

```bash
git clone https://github.com/kekoborn/vibe-coding-kanban.git
cd vibe-coding-kanban
npm install
npm start
```

Откройте **http://localhost:3000** в браузере.

---

## Требования

- **Node.js 18+**
- **Claude Code CLI** — установлен и авторизован (команда `claude` доступна в PATH)
- **macOS или Linux** (требование `node-pty`)

---

## Как это работает

1. **Создайте задачи** — добавьте названия и промпты для Claude Code в Backlog
2. **Нажмите «▶ Start queue»** — задачи переходят в In Progress, Claude Code начинает работу
3. **Наблюдайте** — панель терминала показывает вывод Claude Code в реальном времени
4. **Авто-завершение** — когда Claude возвращается к промпту (idle detection), задача переходит в Review
5. **Rate limit?** — доска показывает таймер, ждёт сброса, автоматически отправляет «продолжи»

---

## Архитектура

```
claude-kanban/
├── server.js       — Express + WebSocket сервер, управление PTY, rate-limit, авто-approve
├── db.js           — SQLite слой (better-sqlite3, WAL mode)
└── public/
    ├── index.html  — SPA-оболочка
    ├── app.js      — Логика канбана, drag-and-drop, модальные окна, WS клиент
    ├── terminal.js — Менеджер терминалов (xterm.js, табы, жизненный цикл PTY)
    ├── styles.css  — Тёмная/светлая темы
    └── favicon.svg — Иконка канбан-доски
```

---

## Стек

| Слой | Технология |
|------|-----------|
| Сервер | Node.js, Express, ws (WebSocket) |
| База данных | SQLite через better-sqlite3 (WAL mode) |
| Терминал | @lydell/node-pty, xterm.js v5 + WebGL |
| Фронтенд | Vanilla JS, SortableJS, CSS custom properties |
| Загрузка файлов | Multer |

---

## Конфигурация

| Переменная / Константа | По умолчанию | Описание |
|------------------------|--------------|---------|
| `PORT` (env) | `3000` | Порт HTTP-сервера |
| `IDLE_COMPLETE_DELAY` | `10000` мс | Секунды без вывода до завершения задачи |
| `PROMPT_COMPLETE_DELAY` | `3000` мс | Время после обнаружения промпта Claude до завершения |
| `COMPACT_EVERY_N_TASKS` | `10` | Отправлять `/compact` каждые N задач |

---

## Участие в разработке

Issues и pull requests приветствуются! Для крупных изменений сначала откройте issue.

---

## Лицензия

MIT — см. [LICENSE](LICENSE)
