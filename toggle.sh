#!/bin/bash
LABEL="com.user.claude-kanban"

if launchctl list | grep -q "$LABEL"; then
    launchctl unload ~/Library/LaunchAgents/${LABEL}.plist
    osascript -e 'display notification "Claude Kanban остановлен" with title "Claude Kanban"'
else
    launchctl load ~/Library/LaunchAgents/${LABEL}.plist
    sleep 1
    osascript -e 'display notification "Claude Kanban запущен → http://localhost:3000" with title "Claude Kanban"'
    open "http://localhost:3000"
fi
