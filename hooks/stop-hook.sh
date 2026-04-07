#!/usr/bin/env bash
# Stop Hook — RalfLoop pattern
# Вызывается Claude Code при завершении сессии (stop hook).
# Если в Kanban есть задачи в backlog — перехватывает выход и выводит следующую задачу.
#
# Установка в settings.json:
#   "hooks": {
#     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bash /path/to/stop-hook.sh" }] }]
#   }
#
# Переменные окружения (передаёт Claude Code):
#   CLAUDE_PROJECT_PATH — путь к текущему проекту (может быть пустым)

PORT="${KANBAN_PORT:-3000}"
PROJECT_PATH="${CLAUDE_PROJECT_PATH:-$(pwd)}"

# Получить следующую задачу из Kanban
RESPONSE=$(curl -sf "http://localhost:${PORT}/api/tasks/next?project_path=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PROJECT_PATH" 2>/dev/null || echo "")" 2>/dev/null)

if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "null" ]; then
  # Задач нет — разрешаем выход
  exit 0
fi

# Извлечь поля задачи
TASK_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
TASK_TITLE=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null)
TASK_DESC=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('description',''))" 2>/dev/null)
TASK_PATH=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('project_path',''))" 2>/dev/null)

if [ -z "$TASK_ID" ]; then
  exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 KANBAN: Следующая задача #${TASK_ID}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Задача: ${TASK_TITLE}"
if [ -n "$TASK_PATH" ]; then
  echo "Проект: ${TASK_PATH}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -n "$TASK_DESC" ]; then
  echo "$TASK_DESC"
fi

# Возвращаем exit code 2 = блокируем выход Claude, он продолжит с новой задачей
# (exit 0 = разрешить выход, exit 2 = блокировать и подать prompt)
exit 2
