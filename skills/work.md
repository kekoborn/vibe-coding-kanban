---
name: work
description: |
  Autonomous work mode. Picks the next task from Kanban backlog, executes it, commits, then loops.
  Use when the user says /work, "работай", "запусти очередь", "автономный режим".
user-invocable: true
---

# /work — Автономный режим

Ты работаешь в автономном режиме. Твоя цель — взять следующую задачу из Kanban и выполнить её полностью.

## Шаги

### 1. Получить следующую задачу

```bash
curl -sf http://localhost:3000/api/tasks/next
```

Если ответ `null` — задач нет, сообщи пользователю и остановись.

Если задача есть — запомни `id`, `title`, `description`, `project_path`.

### 2. Перейти в директорию проекта

```bash
cd /path/to/project_path
```

Если `project_path` пустой — работай в текущей директории.

### 3. Выполнить задачу

- Прочитай CLAUDE.md и README.md проекта для контекста
- Выполни `description` задачи — это и есть промпт для выполнения
- Пиши код, тести, исправляй ошибки
- После выполнения запусти `npm run build` или аналог если есть

### 4. Закоммитить результат

```bash
git add -A
git commit -m "task #ID: Краткое описание что сделано"
git push
```

### 5. Отметить задачу выполненной

```bash
curl -sf -X POST http://localhost:3000/api/tasks/ID/complete \
  -H 'Content-Type: application/json' \
  -d '{"completion_type":"manual"}'
```

### 6. Взять следующую задачу

Повтори с шага 1.

## Правила

- Выполняй по одной задаче за раз
- Каждый коммит = одна задача
- Если задача слишком размыта — разбей на подшаги и выполни их последовательно
- Если что-то сломалось — исправь до коммита, не коммить сломанный код
- Не трогай файлы, которых нет в scope задачи
