---
name: next
description: |
  Pick the next priority task from Kanban and start working on it.
  Use when the user says /next, "возьми следующую", "что дальше".
user-invocable: true
---

# /next — Следующая задача

Возьми следующую приоритетную задачу из Kanban и сразу начни работу.

## Действия

```bash
curl -sf http://localhost:3000/api/tasks/next
```

Если `null` — скажи "Задач в backlog нет. Добавь задачи через /kanban-lead".

Если задача есть:
1. Выведи: `Задача #ID: [title]`
2. Перейди в `project_path`
3. Прочитай CLAUDE.md/README.md если есть
4. Выполни `description` задачи
5. Закоммить: `git commit -m "task #ID: ..."`
6. Отметь выполненной: `POST /api/tasks/ID/complete`
