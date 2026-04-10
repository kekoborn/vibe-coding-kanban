const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'kanban.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Valid column names — 'hold' is a priority level, NOT a column
const VALID_COLUMNS = ['backlog', 'in_progress', 'review', 'done'];
const VALID_PRIORITIES = ['high', 'medium', 'low', 'hold'];

function validateColumn(column) {
  if (!VALID_COLUMNS.includes(column)) {
    const hint = column === 'hold' ? ' ("hold" is a priority level — set task.priority = "hold" instead)' : '';
    throw new Error(`Invalid column: "${column}"${hint}. Valid columns: ${VALID_COLUMNS.join(', ')}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    "column" TEXT NOT NULL DEFAULT 'backlog',
    position INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    project_path TEXT DEFAULT '',
    parent_id INTEGER DEFAULT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migration: add priority column if missing
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`);
} catch {}

// Migration: add parent_id column if missing
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN parent_id INTEGER DEFAULT NULL REFERENCES tasks(id) ON DELETE SET NULL`);
} catch {}

// Migration: add last_response column if missing
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN last_response TEXT DEFAULT ''`);
} catch {}

// Migration: add column_changed_at column if missing
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN column_changed_at TEXT DEFAULT NULL`);
} catch {}

// Migration: add attachments column if missing
try {
  db.exec(`ALTER TABLE tasks ADD COLUMN attachments TEXT DEFAULT '[]'`);
} catch {}

// Migration: analytics columns
try { db.exec(`ALTER TABLE tasks ADD COLUMN started_at TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN completed_at TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN return_count INTEGER DEFAULT 0`); } catch {}

// Migration: auto-review columns
try { db.exec(`ALTER TABLE tasks ADD COLUMN review_status TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN review_notes TEXT DEFAULT ''`); } catch {}

// Analytics events table
db.exec(`
  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    event_type TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    data TEXT DEFAULT '{}'
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_date ON task_events (date(timestamp))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_task ON task_events (task_id)`);

// Settings table — persists server state across restarts
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Default settings
db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('responseLanguage', '')`);
db.exec(`INSERT OR IGNORE INTO settings (key, value) VALUES ('autoReviewEnabled', 'false')`);

const _getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const _setSetting = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);

function getSetting(key, defaultValue = null) {
  const row = _getSetting.get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  _setSetting.run(key, String(value));
}

const getAllTasks = db.prepare(`
  SELECT * FROM tasks ORDER BY "column",
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 WHEN 'hold' THEN 3 END,
    position
`);

const getNonDoneTasks = db.prepare(`
  SELECT * FROM tasks WHERE "column" != 'done'
  ORDER BY "column",
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 WHEN 'hold' THEN 3 END,
    position
`);

const getDoneTasksLimited = db.prepare(`
  SELECT * FROM tasks WHERE "column" = 'done'
  ORDER BY COALESCE(column_changed_at, created_at) DESC
  LIMIT ?
`);

const getDoneCount = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE "column" = 'done'`);

const getTaskById = db.prepare(`
  SELECT * FROM tasks WHERE id = ?
`);

const getTasksByColumn = db.prepare(`
  SELECT * FROM tasks WHERE "column" = ? ORDER BY
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 WHEN 'hold' THEN 3 END,
    position
`);

const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, "column", position, priority, project_path, parent_id)
  VALUES (@title, @description, @column, @position, @priority, @project_path, @parent_id)
`);

const updateTask = db.prepare(`
  UPDATE tasks
  SET title = @title,
      description = @description,
      "column" = @column,
      position = @position,
      priority = @priority,
      project_path = @project_path,
      parent_id = @parent_id,
      updated_at = datetime('now')
  WHERE id = @id
`);

const moveTask = db.prepare(`
  UPDATE tasks
  SET "column" = @column,
      position = @position,
      column_changed_at = datetime('now'),
      started_at   = CASE WHEN @column = 'in_progress' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
      completed_at = CASE WHEN @column IN ('review', 'done') THEN datetime('now') ELSE completed_at END,
      updated_at = datetime('now')
  WHERE id = @id
`);

const incrementReturnCount = db.prepare(`
  UPDATE tasks SET return_count = return_count + 1, started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
`);

const insertEvent = db.prepare(`
  INSERT INTO task_events (task_id, event_type, data) VALUES (?, ?, ?)
`);

const deleteTask = db.prepare(`
  DELETE FROM tasks WHERE id = ?
`);

const setLastResponse = db.prepare(`
  UPDATE tasks SET last_response = ?, updated_at = datetime('now') WHERE id = ?
`);

const setAttachments = db.prepare(`
  UPDATE tasks SET attachments = ?, updated_at = datetime('now') WHERE id = ?
`);

const getMaxPosition = db.prepare(`
  SELECT COALESCE(MAX(position), -1) as max_pos FROM tasks WHERE "column" = ?
`);

const normalizePosUpdate = db.prepare(`
  UPDATE tasks SET position = ?, updated_at = datetime('now') WHERE id = ?
`);

const normalizePositionsTx = db.transaction((column) => {
  const tasks = getTasksByColumn.all(column);
  tasks.forEach((task, idx) => {
    normalizePosUpdate.run(idx, task.id);
  });
});

module.exports = {
  db,
  VALID_COLUMNS,

  getAllTasks() {
    return getAllTasks.all();
  },

  getTasksLimited(doneLimit = 50) {
    const nonDone = getNonDoneTasks.all();
    const done = getDoneTasksLimited.all(doneLimit);
    const doneTotal = getDoneCount.get().count;
    return { tasks: [...nonDone, ...done], doneTotal };
  },

  getTaskById(id) {
    return getTaskById.get(id);
  },

  getTasksByColumn(column) {
    return getTasksByColumn.all(column);
  },

  createTask({ title, description = '', column = 'backlog', priority = 'medium', project_path = '', position = null }) {
    validateColumn(column);
    const pos = position !== null ? position : getMaxPosition.get(column).max_pos + 1;
    const result = insertTask.run({
      title,
      description,
      column,
      position: pos,
      priority,
      project_path,
      parent_id: null,
    });
    return getTaskById.get(result.lastInsertRowid);
  },

  updateTask({ id, title, description, column, position, priority, project_path }) {
    const existing = getTaskById.get(id);
    if (!existing) return null;
    const newColumn = column ?? existing.column;
    validateColumn(newColumn);
    updateTask.run({
      id,
      title: title ?? existing.title,
      description: description ?? existing.description,
      column: newColumn,
      position: position ?? existing.position,
      priority: priority ?? existing.priority,
      project_path: project_path ?? existing.project_path,
      parent_id: existing.parent_id,
    });
    return getTaskById.get(id);
  },

  moveTask({ id, column, position }) {
    validateColumn(column);
    const existing = getTaskById.get(id);
    if (!existing) return null;
    const isReturn = existing.column === 'review' && column === 'in_progress';
    if (position === undefined || position === null) {
      const maxPos = getMaxPosition.get(column).max_pos;
      position = maxPos + 1;
    }
    moveTask.run({ id, column, position });
    if (isReturn) incrementReturnCount.run(id);
    return getTaskById.get(id);
  },

  setLastResponse(id, text) {
    setLastResponse.run(text, id);
    return getTaskById.get(id);
  },

  setReviewResult(id, status, notes) {
    db.prepare(`UPDATE tasks SET review_status = ?, review_notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, notes, id);
    return getTaskById.get(id);
  },

  clearReviewResult(id) {
    db.prepare(`UPDATE tasks SET review_status = NULL, review_notes = '' WHERE id = ?`).run(id);
  },

  setAttachments(id, attachments) {
    setAttachments.run(JSON.stringify(attachments), id);
    return getTaskById.get(id);
  },

  deleteTask(id) {
    const existing = getTaskById.get(id);
    const col = existing?.column;
    const result = deleteTask.run(id);
    if (col) normalizePositionsTx(col);
    return result;
  },

  // --- Analytics ---

  logEvent(taskId, eventType, data = {}) {
    try {
      insertEvent.run(taskId ?? null, eventType, JSON.stringify(data));
    } catch (err) {
      console.error('[Analytics] logEvent failed:', err.message);
    }
  },

  getDailyAnalytics(date) {
    // date: 'YYYY-MM-DD', defaults to today
    const d = date || new Date().toISOString().slice(0, 10);

    // Tasks active on this date: started or created on this day
    const tasks = db.prepare(`
      SELECT
        t.*,
        CASE
          WHEN t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
          THEN CAST((julianday(t.completed_at) - julianday(t.started_at)) * 86400 AS INTEGER)
          ELSE NULL
        END AS execution_seconds,
        CASE
          WHEN t.started_at IS NOT NULL
          THEN CAST((julianday(t.started_at) - julianday(t.created_at)) * 86400 AS INTEGER)
          ELSE NULL
        END AS queue_seconds
      FROM tasks t
      WHERE date(t.started_at) = ? OR (t.started_at IS NULL AND date(t.created_at) = ?)
      ORDER BY t.started_at, t.created_at
    `).all(d, d);

    // All events for this date
    const events = db.prepare(`
      SELECT e.*, t.title as task_title, t.project_path
      FROM task_events e
      LEFT JOIN tasks t ON t.id = e.task_id
      WHERE date(e.timestamp) = ?
      ORDER BY e.timestamp
    `).all(d);

    // Aggregate stats
    const completed = tasks.filter(t => t.completed_at && t.started_at);
    const avgExecution = completed.length
      ? Math.round(completed.reduce((s, t) => s + (t.execution_seconds || 0), 0) / completed.length)
      : null;

    const rateLimitEvents = events.filter(e => e.event_type === 'rate_limited');
    const autoApproveCount = events.filter(e => e.event_type === 'auto_approved').length;
    const compactCount = events.filter(e => e.event_type === 'compact').length;
    const returnedTasks = tasks.filter(t => t.return_count > 0);

    // Problem flags per task
    const tasksWithFlags = tasks.map(t => {
      const taskEvents = events.filter(e => e.task_id === t.id);
      const completionEvent = taskEvents.find(e => e.event_type === 'completed');
      const completionData = completionEvent ? JSON.parse(completionEvent.data || '{}') : {};
      const flags = [];
      if (completionData.completion_type === 'idle_timeout' && (completionData.response_length || 0) < 100) {
        flags.push('short_idle');
      }
      if (t.return_count > 1) flags.push('multi_return');
      if (t.execution_seconds > 900) flags.push('slow'); // >15min
      if (completionData.completion_type === 'process_exit') flags.push('crashed');
      return { ...t, flags, completionData };
    });

    return {
      date: d,
      summary: {
        tasks_started: tasks.filter(t => t.started_at).length,
        tasks_completed: completed.length,
        tasks_returned: returnedTasks.length,
        avg_execution_seconds: avgExecution,
        rate_limit_count: rateLimitEvents.length,
        auto_approve_count: autoApproveCount,
        compact_count: compactCount,
        problem_count: tasksWithFlags.filter(t => t.flags.length > 0).length,
      },
      tasks: tasksWithFlags,
      events,
      rate_limits: rateLimitEvents.map(e => ({ ...e, data: JSON.parse(e.data || '{}') })),
    };
  },

  getEventsByTask(taskId) {
    return db.prepare(`
      SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp
    `).all(taskId);
  },

  getSetting,
  setSetting,
};
