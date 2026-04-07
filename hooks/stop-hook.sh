#!/usr/bin/env bash
# Stop Hook — RalfLoop pattern for Claude Kanban
# Перехватывает завершение сессии Claude и подаёт следующую задачу из backlog.
#
# Установка в .claude/settings.json проекта (или ~/.claude/settings.json глобально):
#   "hooks": {
#     "Stop": [{ "matcher": "", "hooks": [{ "type": "command",
#       "command": "bash /Users/ruslanalyev/Documents/Projects/claude-kanban/hooks/stop-hook.sh"
#     }] }]
#   }

PORT="${KANBAN_PORT:-3000}"

# Читаем JSON-вход от Claude Code
INPUT=$(cat)

# Защита от бесконечного цикла: если хук уже активен (предыдущая итерация заблокировала),
# позволяем выйти, чтобы не зациклиться навсегда
if [ "$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)" = "True" ]; then
  exit 0
fi

# Определяем project_path из рабочей директории Claude
PROJECT_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
if [ -z "$PROJECT_PATH" ]; then
  PROJECT_PATH="$(pwd)"
fi

# URL-encode project_path
ENCODED_PATH=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PROJECT_PATH" 2>/dev/null)

# Запросить следующую задачу из Kanban
RESPONSE=$(curl -sf "http://localhost:${PORT}/api/tasks/next?project_path=${ENCODED_PATH}" 2>/dev/null)

if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "null" ]; then
  # Задач нет — разрешаем выход
  exit 0
fi

# Извлечь данные задачи
TASK_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
TASK_TITLE=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null)
TASK_DESC=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('description',''))" 2>/dev/null)
TASK_PATH=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('project_path','') or '')" 2>/dev/null)

if [ -z "$TASK_ID" ]; then
  exit 0
fi

# Формируем context для Claude
CONTEXT="Kanban task #${TASK_ID}: ${TASK_TITLE}"
if [ -n "$TASK_PATH" ]; then
  CONTEXT="${CONTEXT}\nProject: ${TASK_PATH}"
fi
CONTEXT="${CONTEXT}\n\n${TASK_DESC}"
if [ -n "$TASK_PATH" ]; then
  CONTEXT="${CONTEXT}\n\nAfter completing: run \`curl -sf -X POST http://localhost:${PORT}/api/tasks/${TASK_ID}/complete -H 'Content-Type: application/json' -d '{\"completion_type\":\"autonomous\"}\`\` then commit with: git add -A && git commit -m \"task #${TASK_ID}: brief description\""
fi

# Выводим JSON-блокировку с задачей как additionalContext
python3 -c "
import json, sys
context = sys.argv[1]
print(json.dumps({
  'decision': 'block',
  'reason': 'Kanban backlog has pending tasks',
  'hookSpecificOutput': {
    'hookEventName': 'Stop',
    'additionalContext': context
  }
}))
" "$CONTEXT"
