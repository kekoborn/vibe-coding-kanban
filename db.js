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

const getAllTasks = db.prepare(`
  SELECT * FROM tasks ORDER BY "column",
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 WHEN 'hold' THEN 3 END,
    position
`);

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
      updated_at = datetime('now')
  WHERE id = @id
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
    if (position === undefined || position === null) {
      const maxPos = getMaxPosition.get(column).max_pos;
      position = maxPos + 1;
    }
    moveTask.run({ id, column, position });
    return getTaskById.get(id);
  },

  setLastResponse(id, text) {
    setLastResponse.run(text, id);
    return getTaskById.get(id);
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
};
