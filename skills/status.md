---
name: status
description: |
  Show Kanban board status: tasks by column, today's analytics, active projects.
  Use when the user says /status, "что сделано", "статус", "отчёт".
user-invocable: true
---

# /status — Статус Kanban

Запроси состояние доски и выведи краткий отчёт.

## Данные

```bash
# Все задачи
curl -sf http://localhost:3000/api/tasks

# Дневная аналитика
TODAY=$(date +%Y-%m-%d)
curl -sf "http://localhost:3000/api/analytics/daily?date=$TODAY"
```

## Формат отчёта

```
📋 KANBAN STATUS — DD.MM.YYYY

Backlog:     N задач
In Progress: N задач  [titles]
Review:      N задач  [titles]
Done:        N задач

Сегодня:
  ✅ Выполнено: N
  🔄 Возвращено: N
  ⚡ Rate limit: N раз
  ⏱ Среднее время: Xm

Активные проекты: [список project_path из in_progress]
```

Если есть задачи в `review` — укажи: "Требуют проверки: [titles]"
