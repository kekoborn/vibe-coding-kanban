#!/bin/bash

PLIST=~/Library/LaunchAgents/com.user.claude-kanban.plist

if launchctl list 2>/dev/null | grep -q "com.user.claude-kanban"; then
  launchctl unload "$PLIST" 2>/dev/null
  osascript <<'EOF'
tell application "Safari"
  set tabsToClose to {}
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with "http://localhost:3000" then
        set end of tabsToClose to t
      end if
    end repeat
  end repeat
  repeat with t in tabsToClose
    close t
  end repeat
end tell
EOF
  osascript -e 'display notification "Сервер остановлен" with title "Claude Kanban"'
else
  launchctl load "$PLIST" 2>/dev/null
  sleep 1.5
  osascript -e 'tell application "Safari" to open location "http://localhost:3000"'
  osascript -e 'display notification "Сервер запущен → localhost:3000" with title "Claude Kanban"'
fi
