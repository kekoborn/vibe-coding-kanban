const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');
const pty = require('@lydell/node-pty');
const db = require('./db');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- File uploads ---
const uploadsDir = path.join(__dirname, 'uploads');
const fs = require('fs');
fs.mkdirSync(uploadsDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));

const multerStorage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({ storage: multerStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// --- Skill auto-install ---
function installKanbanLeadSkill() {
  const skillSrc = path.join(__dirname, 'skills', 'kanban-lead.md');
  const commandsDir = path.join(process.env.HOME, '.claude', 'commands');
  const skillDst = path.join(commandsDir, 'kanban-lead.md');
  try {
    if (!fs.existsSync(skillSrc)) { console.log('[Skill] source not found, skip'); return; }
    if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });
    const srcContent = fs.readFileSync(skillSrc, 'utf8');
    const dstContent = fs.existsSync(skillDst) ? fs.readFileSync(skillDst, 'utf8') : null;
    if (srcContent !== dstContent) {
      fs.writeFileSync(skillDst, srcContent, 'utf8');
      console.log('[Skill] kanban-lead synced to ' + skillDst);
    } else {
      console.log('[Skill] kanban-lead up to date');
    }
  } catch (err) { console.error('[Skill] install failed:', err.message); }
}
installKanbanLeadSkill();

// --- PTY store ---
const termOutputBuffers = new Map(); // termId -> stripped output text (last 10k chars)
const termTaskMap = new Map(); // termId -> { taskId, idleTimer, lastDataTime }
const globalPtys = new Map(); // termId -> { pty, replayBuffer, subscribers: Set<ws>, meta }
const termTaskCounter = new Map(); // termId -> number of tasks completed (for /compact every N tasks)
const COMPACT_EVERY_N_TASKS = 10; // send /compact after every N tasks
const IDLE_COMPLETE_DELAY = 45000; // 45 seconds of no output = task completed (was 10s — too aggressive)
const PROMPT_COMPLETE_DELAY = 7000; // 7 seconds after Claude prompt detected = completed
const TASK_START_DELAY = 4000; // delay before sending next task prompt (let Claude settle)
const MAX_CONCURRENT_TASKS = 5; // max tasks running simultaneously (0 = unlimited)
let autoApproveEnabled = db.getSetting('autoApproveEnabled', 'false') === 'true';
let autoQueueEnabled = db.getSetting('autoQueueEnabled', 'false') === 'true';

// Rate-limited terminals — termIds currently blocked by API rate limit
const rateLimitedTerms = new Set();

// BUG-02: track clientId -> ws mapping for targeted broadcasts
const clientIdMap = new Map(); // clientId -> ws

// --- Sleep prevention (caffeinate) ---
let caffeinateProc = null;

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[>=<]/g, '');
}

function updateCaffeinate() {
  const inProgress = db.getTasksByColumn('in_progress');
  const backlog = autoQueueEnabled ? db.getTasksByColumn('backlog') : [];
  const hasActive = inProgress.length > 0 || backlog.length > 0;

  if (hasActive && !caffeinateProc) {
    caffeinateProc = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
    caffeinateProc.on('error', () => { caffeinateProc = null; });
    caffeinateProc.on('exit', () => { caffeinateProc = null; });
    console.log(`[Caffeinate] Sleep prevention ON (${inProgress.length} active, ${backlog.length} queued)`);
  } else if (!hasActive && caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
    console.log('[Caffeinate] Sleep prevention OFF (no active tasks)');
  }
}

// --- REST API ---

app.get('/api/tasks', (req, res) => {
  res.json(db.getAllTasks());
});

app.post('/api/tasks', (req, res) => {
  const { title, description, priority, project_path, parent_id, position } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const task = db.createTask({ title, description, priority, project_path, parent_id, position });
  db.logEvent(task.id, 'created', { title: task.title, priority: task.priority, project_path: task.project_path });
  broadcast({ type: 'task:created', task });
  res.status(201).json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const task = db.updateTask({ id: parseInt(req.params.id), ...req.body });
  if (!task) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'task:updated', task });
  updateCaffeinate();
  res.json(task);
});

app.put('/api/tasks/:id/move', (req, res) => {
  const { column, position } = req.body;
  if (column && !db.VALID_COLUMNS.includes(column)) {
    return res.status(400).json({ error: `Invalid column: "${column}". Note: "hold" is a priority level — set priority field instead.` });
  }
  const task = db.moveTask({ id: parseInt(req.params.id), column, position });
  if (!task) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'task:moved', task });
  updateCaffeinate();
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);

  // BUG-04: kill PTY and clear termTaskMap before deleting
  for (const [tid, entry] of termTaskMap) {
    if (entry.taskId === id) {
      termTaskMap.delete(tid);
      // Kill the PTY
      const gEntry = globalPtys.get(tid);
      if (gEntry) {
        try { gEntry.pty.kill(); } catch {}
        globalPtys.delete(tid);
      }
      break;
    }
  }

  // Notify clients to stop the task terminal and clear session status
  if (task) {
    broadcast({ type: 'task:stop', taskId: id, projectPath: task.project_path || '' });
  }

  db.deleteTask(id);
  broadcast({ type: 'task:deleted', id });
  updateCaffeinate();
  res.json({ ok: true });
});

// Auto-approve toggle
app.post('/api/auto-approve', (req, res) => {
  autoApproveEnabled = !!req.body.enabled;
  db.setSetting('autoApproveEnabled', autoApproveEnabled);
  console.log(`[AutoApprove] ${autoApproveEnabled ? 'ENABLED' : 'DISABLED'}`);
  broadcast({ type: 'settings:autoApprove', enabled: autoApproveEnabled });
  res.json({ ok: true, enabled: autoApproveEnabled });
});

app.get('/api/auto-approve', (req, res) => {
  res.json({ enabled: autoApproveEnabled });
});

// Auto-queue server-side state
app.post('/api/auto-queue', (req, res) => {
  autoQueueEnabled = !!req.body.enabled;
  db.setSetting('autoQueueEnabled', autoQueueEnabled);
  console.log(`[AutoQueue] ${autoQueueEnabled ? 'ENABLED' : 'DISABLED'}`);
  broadcast({ type: 'settings:autoQueue', enabled: autoQueueEnabled });
  res.json({ ok: true, enabled: autoQueueEnabled });
});

app.get('/api/auto-queue', (req, res) => {
  res.json({ enabled: autoQueueEnabled });
});


app.get('/api/response-language', (req, res) => {
  res.json({ language: db.getSetting('responseLanguage', '') });
});

app.put('/api/response-language', (req, res) => {
  const language = String(req.body.language ?? '');
  db.setSetting('responseLanguage', language);
  res.json({ ok: true, language });
});

app.get('/api/skill-status', (req, res) => {
  const dst = path.join(process.env.HOME, '.claude', 'commands', 'kanban-lead.md');
  res.json({ installed: fs.existsSync(dst) });
});

app.get('/api/pick-folder', (req, res) => {
  const { exec } = require('child_process');
  exec(`osascript -e 'POSIX path of (choose folder with prompt "Choose project folder:")'`, (err, stdout) => {
    if (err) return res.json({ path: null });
    res.json({ path: stdout.trim().replace(/\/$/, '') });
  });
});

app.get('/api/check-path', (req, res) => {
  const p = (req.query.path || '').trim();
  if (!p) return res.json({ exists: false, isDir: false });
  try {
    const stat = fs.statSync(p);
    res.json({ exists: true, isDir: stat.isDirectory() });
  } catch {
    res.json({ exists: false, isDir: false });
  }
});

// Temporary file upload for re-run context (not saved to task attachments)
app.post('/api/tasks/:id/return-upload', upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ path: req.file.path, name: req.file.originalname });
});

// Return a task from review — re-run with previous result + new instructions
app.post('/api/tasks/:id/return', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const newPrompt = (req.body.prompt || '').trim();
  if (!newPrompt) return res.status(400).json({ error: 'prompt is required' });

  const extraFiles = req.body.extraFiles || []; // [{ path, name }]
  const extraUrls = req.body.extraUrls || [];   // [string]

  const previousResponse = task.last_response || '';

  // Update description to new prompt
  db.updateTask({ id, description: newPrompt });

  // Build context: previous result + new instructions (old prompt is NOT included)
  let contextPrompt;
  if (previousResponse) {
    contextPrompt = `[PREVIOUS RESULT]\n${previousResponse}\n\n[NEW INSTRUCTIONS]\n${newPrompt}`;
  } else {
    contextPrompt = newPrompt;
  }

  // Append file attachments from task + re-run extras
  let attachments = [];
  try { attachments = JSON.parse(task.attachments || '[]'); } catch {}
  const fileAttachments = attachments.filter(a => a.type === 'file');

  const contextLines = [];
  if (fileAttachments.length > 0 || extraFiles.length > 0 || extraUrls.length > 0) {
    contextLines.push('\n\n[ATTACHED CONTEXT]');
    for (const a of fileAttachments) contextLines.push(`- File: ${a.path} (${a.name})`);
    for (const f of extraFiles) contextLines.push(`- File: ${f.path} (${f.name})`);
    for (const url of extraUrls) contextLines.push(`- URL: ${url}`);
  }
  contextPrompt += contextLines.join('\n');

  const projectPath = task.project_path || process.env.HOME;

  // BUG-18: clear last_response before running so stale response isn't shown
  db.setLastResponse(id, '');

  // Move to in_progress (moveTask increments return_count automatically)
  const updated = db.moveTask({ id, column: 'in_progress' });
  const afterMove = db.getTaskById(id);
  broadcast({ type: 'task:moved', task: updated });

  // Log returned event
  db.logEvent(id, 'returned', {
    return_count: afterMove.return_count,
    new_prompt_length: newPrompt.length,
    project_path: projectPath,
  });

  // BUG-02: send task:run only to the originating client
  const clientId = req.body?.clientId;
  const runMsg = { type: 'task:run', taskId: id, prompt: contextPrompt, autoApprove: true, cwd: projectPath };
  if (clientId && clientIdMap.has(clientId)) {
    sendToClient(clientId, runMsg);
  } else {
    broadcast(runMsg);
  }

  updateCaffeinate();
  res.json({ ok: true });
});

// Build a prompt string that includes attachment context
function buildPromptWithAttachments(task) {
  let prompt = task.description || task.title;
  let attachments = [];
  try { attachments = JSON.parse(task.attachments || '[]'); } catch {}

  if (attachments.length === 0) return prompt;

  const lines = ['\n\n[ATTACHED CONTEXT]'];
  for (const a of attachments) {
    if (a.type === 'file') {
      lines.push(`- File: ${a.path} (${a.name})`);
    } else if (a.type === 'url') {
      lines.push(`- URL: ${a.url}${a.label && a.label !== a.url ? ' — ' + a.label : ''}`);
    }
  }
  return prompt + lines.join('\n');
}

function buildClaudeCommand() {
  const lang = db.getSetting('responseLanguage');
  if (lang) {
    return `claude --append-system-prompt "Respond entirely in ${lang}. All output, code comments, and commit messages must be in ${lang}."`;
  }
  return 'claude';
}

// Run a task — tell client to spawn claude in its task terminal
app.post('/api/tasks/:id/run', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // Enforce MAX_CONCURRENT_TASKS limit
  if (MAX_CONCURRENT_TASKS > 0) {
    const activeCount = db.getTasksByColumn('in_progress').length;
    if (activeCount >= MAX_CONCURRENT_TASKS) {
      return res.status(429).json({
        error: `Max concurrent tasks reached (${MAX_CONCURRENT_TASKS}). Wait for a running task to complete.`,
        activeCount,
        limit: MAX_CONCURRENT_TASKS,
      });
    }
  }


  const rawPrompt = buildPromptWithAttachments(task);
  const projectPath = task.project_path || process.env.HOME;

  // BUG-18: clear last_response before running to avoid stale response on card
  db.setLastResponse(id, '');

  // Move to in_progress
  const updated = db.moveTask({ id, column: 'in_progress' });
  broadcast({ type: 'task:moved', task: updated });

  // Log started event with queue wait time
  const queueSeconds = task.created_at
    ? Math.round((Date.now() - new Date(task.created_at).getTime()) / 1000)
    : null;
  db.logEvent(id, 'started', { project_path: projectPath, queue_seconds: queueSeconds });

  // BUG-02: send task:run only to the originating client (not all tabs)
  const clientId = req.body?.clientId;
  const runMsg = { type: 'task:run', taskId: id, prompt: rawPrompt, autoApprove: true, cwd: projectPath, command: buildClaudeCommand() };
  if (clientId && clientIdMap.has(clientId)) {
    sendToClient(clientId, runMsg);
  } else {
    // Fallback: broadcast to all (e.g. direct API calls without clientId)
    broadcast(runMsg);
  }

  updateCaffeinate();
  res.json({ ok: true });
});

// Task completed — move to review and save last response
app.post('/api/tasks/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  const { termId } = req.body || {};
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // Extract last Claude response from terminal output buffer
  if (termId) {
    const rawOutput = termOutputBuffers.get(termId) || '';
    const lastResponse = extractLastResponse(rawOutput);
    if (lastResponse) {
      db.setLastResponse(id, lastResponse);
    }
    termOutputBuffers.delete(termId);
  }

  if (task.column === 'in_progress') {
    const updated = db.moveTask({ id, column: 'review' });
    const full = db.getTaskById(id);
    broadcast({ type: 'task:moved', task: full });
    broadcast({ type: 'session:completed', taskId: id });

    // Log completed event (prompt-detection path)
    const execSeconds = full.started_at
      ? Math.round((Date.now() - new Date(full.started_at).getTime()) / 1000)
      : null;
    db.logEvent(id, 'completed', {
      completion_type: 'prompt_detected',
      response_length: (full.last_response || '').length,
      execution_seconds: execSeconds,
      project_path: full.project_path,
    });
    updateCaffeinate();
  }
  res.json({ ok: true });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);

  // Clear task mapping so onExit doesn't auto-complete
  for (const [tid, entry] of termTaskMap) {
    if (entry.taskId === id) {
      termTaskMap.delete(tid);
      break;
    }
  }

  // Kill the PTY in all connected WS clients
  broadcast({ type: 'task:stop', taskId: id, projectPath: task?.project_path || '' });

  // Move back to backlog only if in_progress (don't move if already elsewhere)
  if (task && task.column === 'in_progress') {
    const updated = db.moveTask({ id, column: 'backlog' });
    broadcast({ type: 'task:moved', task: updated });
  }

  broadcast({ type: 'session:stopped', taskId: id });
  updateCaffeinate();
  res.json({ ok: true });
});

// BUG-03: atomic stop+move — avoids race condition where stopTask moves to backlog
// and then moveTask moves to target column (triggering autoQueue in between)
app.post('/api/tasks/:id/stop-move', (req, res) => {
  const id = parseInt(req.params.id);
  const { column, position } = req.body;
  if (column && !db.VALID_COLUMNS.includes(column)) {
    return res.status(400).json({ error: `Invalid column: "${column}". Note: "hold" is a priority level — set priority field instead.` });
  }
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  // Clear task mapping so onExit doesn't auto-complete
  for (const [tid, entry] of termTaskMap) {
    if (entry.taskId === id) {
      termTaskMap.delete(tid);
      break;
    }
  }

  // Kill the PTY in all connected WS clients
  broadcast({ type: 'task:stop', taskId: id, projectPath: task.project_path || '' });

  // Move directly to target column (no intermediate backlog move)
  const updated = db.moveTask({ id, column: column || 'backlog', position });
  broadcast({ type: 'task:moved', task: updated });
  broadcast({ type: 'session:stopped', taskId: id });
  updateCaffeinate();
  res.json({ ok: true });
});

// Upload a file attachment
app.post('/api/tasks/:id/attachments', upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const attachments = JSON.parse(task.attachments || '[]');

  if (req.file) {
    attachments.push({
      id: crypto.randomUUID(),
      type: 'file',
      name: req.file.originalname,
      filename: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
    });
  } else {
    return res.status(400).json({ error: 'no file provided' });
  }

  const updated = db.setAttachments(id, attachments);
  broadcast({ type: 'task:updated', task: updated });
  res.json({ ok: true, attachments: updated.attachments });
});

// Add a URL attachment
app.post('/api/tasks/:id/attachments/url', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const { url, label } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
  catch { return res.status(400).json({ error: 'invalid url: only http/https allowed' }); }

  const attachments = JSON.parse(task.attachments || '[]');
  attachments.push({ id: crypto.randomUUID(), type: 'url', url, label: label || url });

  const updated = db.setAttachments(id, attachments);
  broadcast({ type: 'task:updated', task: updated });
  res.json({ ok: true, attachments: updated.attachments });
});

// Delete an attachment
app.delete('/api/tasks/:id/attachments/:attachId', (req, res) => {
  const id = parseInt(req.params.id);
  const task = db.getTaskById(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  let attachments = JSON.parse(task.attachments || '[]');
  const attach = attachments.find(a => a.id === req.params.attachId);

  if (attach?.filename) {
    try { fs.unlinkSync(path.join(uploadsDir, attach.filename)); } catch {}
  }

  attachments = attachments.filter(a => a.id !== req.params.attachId);
  const updated = db.setAttachments(id, attachments);
  broadcast({ type: 'task:updated', task: updated });
  res.json({ ok: true, attachments: updated.attachments });
});

app.get('/api/tasks/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const alive = [...termTaskMap.values()].some(e => e.taskId === id);
  res.json({ taskId: id, alive, status: alive ? 'running' : 'none' });
});

// Complete a task from server-side idle detection
function completeTaskFromServer(taskId, termId) {
  const task = db.getTaskById(taskId);
  if (!task || task.column !== 'in_progress') {
    // Clear taskId but keep entry so polling continues for terminal:continue
    const entry = termTaskMap.get(termId);
    if (entry) entry.taskId = null;
    return;
  }

  // Save last response — prefer JSONL (clean) over PTY output (noisy)
  const taskEntry = termTaskMap.get(termId);
  const checkpoint = taskEntry?.jsonlCheckpoint || null;
  let lastResponse = '';
  lastResponse = extractLastResponseFromJSONL(task.project_path, checkpoint);
  if (!lastResponse) {
    const rawOutput = termOutputBuffers.get(termId) || '';
    lastResponse = extractLastResponse(rawOutput);
  }
  if (lastResponse) {
    db.setLastResponse(taskId, lastResponse);
  }
  termOutputBuffers.delete(termId);

  // Clear taskId but keep entry — polling stays alive for next task via terminal:continue
  const entry = termTaskMap.get(termId);
  if (entry) entry.taskId = null;

  // Update global meta
  const gEntry = globalPtys.get(termId);
  if (gEntry && gEntry.meta) {
    gEntry.meta.currentTaskId = null;
    gEntry.meta.running = false;
  }

  // Move to review
  const updated = db.moveTask({ id: taskId, column: 'review' });
  const full = db.getTaskById(taskId);
  broadcast({ type: 'task:moved', task: full });
  broadcast({ type: 'session:completed', taskId });
  updateCaffeinate();

  // Log completed event
  const execSeconds = full.started_at
    ? Math.round((Date.now() - new Date(full.started_at).getTime()) / 1000)
    : null;
  db.logEvent(taskId, 'completed', {
    completion_type: 'idle_timeout',
    response_length: lastResponse.length,
    execution_seconds: execSeconds,
    project_path: full.project_path,
  });
  console.log(`[Complete] Task #${taskId} moved to review (idle detection)`);
  setTimeout(triggerServerAutoQueue, 1000);
}

function runTaskOnServer(task) {
  const rawPrompt = buildPromptWithAttachments(task);
  const projectPath = task.project_path || process.env.HOME;
  const termId = 'project:' + (task.project_path || 'default');

  db.setLastResponse(task.id, '');
  const updated = db.moveTask({ id: task.id, column: 'in_progress' });
  broadcast({ type: 'task:moved', task: updated });

  const existing = globalPtys.get(termId);
  if (existing && existing.pty) {
    // Reuse existing session — mirror terminal:continue logic
    if (existing.meta) {
      existing.meta.currentTaskId = task.id;
      existing.meta.running = true;
    }
    const prev = termTaskMap.get(termId);
    if (prev?.idleTimer) clearTimeout(prev.idleTimer);
    const checkpoint = getJsonlCheckpoint(task.project_path || '');
    termTaskMap.set(termId, { taskId: task.id, idleTimer: null, lastDataTime: Date.now(), jsonlCheckpoint: checkpoint });
    console.log(`[ServerAutoQueue] continue termId=${termId} -> taskId=${task.id}, checkpoint line=${checkpoint?.lineOffset ?? 'none'}`);

    const p = existing.pty;
    const wasAtPrompt = p._claudeAtPrompt?.() || false;
    if (p._resetWaiting) p._resetWaiting();
    if (p._state) { p._state.outputBuffer = ''; p._state.lastDataTime = Date.now(); }
    if (p._promptReset) p._promptReset();
    termOutputBuffers.delete(termId);

    updateCaffeinate();

    const count = (termTaskCounter.get(termId) || 0) + 1;
    termTaskCounter.set(termId, count);
    const safePrompt = rawPrompt.replace(/[\r\n]+/g, ' ').trim();

    if (wasAtPrompt) {
      if (count % COMPACT_EVERY_N_TASKS === 0) {
        p.write('/compact\r');
        setTimeout(() => p.write(safePrompt + '\r'), 3000);
      } else {
        setTimeout(() => { p.write(safePrompt); setTimeout(() => p.write('\r'), 200); }, TASK_START_DELAY);
      }
    } else {
      p._setPendingPrompt(safePrompt);
      setTimeout(() => p._sendPendingNow?.(), TASK_START_DELAY + 5000);
    }

    // Notify UI to switch to the correct terminal tab (do NOT send task:run — that would
    // trigger runInTaskTerminal on the client and cause a double terminal:continue / double prompt)
    broadcast({ type: 'session:started', taskId: task.id, cwd: projectPath });
  } else if (clients.size === 0) {
    // Headless mode — no browser connected, spawn PTY directly on server
    console.log(`[ServerAutoQueue] Headless spawn for task #${task.id}`);
    spawnShell(null, termId, { cwd: projectPath, command: buildClaudeCommand(), taskId: task.id, prompt: rawPrompt, autoApprove: true });
  } else {
    // Clients connected but no PTY yet — let the browser handle the spawn via task:run
    broadcast({ type: 'task:run', taskId: task.id, prompt: rawPrompt, autoApprove: true, cwd: projectPath, command: buildClaudeCommand() });
  }

  console.log(`[ServerAutoQueue] Started task #${task.id} "${task.title}"`);
}

function triggerServerAutoQueue() {
  if (!autoQueueEnabled) return;
  const inProgress = db.getTasksByColumn('in_progress');
  const busyProjects = new Set(inProgress.map(t => t.project_path || ''));
  const backlog = db.getTasksByColumn('backlog');
  const started = new Set();
  for (const task of backlog) {
    const proj = task.project_path || '';
    const termId = 'project:' + (proj || 'default');
    if (busyProjects.has(proj) || started.has(proj)) continue;
    // Skip terminals currently blocked by rate limit
    if (rateLimitedTerms.has(termId)) {
      console.log(`[AutoQueue] skipping task #${task.id} — terminal ${termId} is rate-limited`);
      continue;
    }
    // Enforce MAX_CONCURRENT_TASKS
    if (MAX_CONCURRENT_TASKS > 0 && (busyProjects.size + started.size) >= MAX_CONCURRENT_TASKS) break;
    started.add(proj);
    setTimeout(() => runTaskOnServer(task), 500);
  }
}

// --- Analytics API ---

app.get('/api/analytics/daily', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    res.json(db.getDailyAnalytics(date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/events', (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: 'task_id required' });
  res.json(db.getEventsByTask(parseInt(task_id)));
});

// --- WebSocket ---

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// BUG-02: send a message only to a specific client identified by clientId
function sendToClient(clientId, data) {
  const ws = clientIdMap.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // BUG-02: client will register its clientId via 'client:register' message

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const termId = msg.termId || 'default';

    switch (msg.type) {
      // BUG-02: register clientId -> ws mapping for targeted task:run delivery
      case 'client:register': {
        if (msg.clientId) {
          ws._clientId = msg.clientId;
          clientIdMap.set(msg.clientId, ws);
        }
        break;
      }

      case 'terminal:spawn':
        console.log(`[WS] spawn: ${termId}, cmd: ${msg.command || 'shell'}, cwd: ${msg.cwd || 'HOME'}, taskId: ${msg.taskId || 'none'}`);
        spawnShell(ws, termId, msg);
        break;

      case 'terminal:set-autoapprove': {
        const entry = globalPtys.get(termId);
        if (entry && entry.meta) {
          entry.meta.autoApprove = !!msg.enabled;
          console.log(`[AutoApprove] terminal ${termId} per-terminal: ${entry.meta.autoApprove}`);
        }
        break;
      }

      case 'terminal:input': {
        const entry = globalPtys.get(termId);
        if (entry) entry.pty.write(msg.data);
        break;
      }

      case 'terminal:resize': {
        const entry = globalPtys.get(termId);
        if (entry) {
          try { entry.pty.resize(msg.cols, msg.rows); } catch {}
        }
        break;
      }

      case 'terminal:continue': {
        // Continue existing Claude Code session with a new prompt (same PTY)
        const entry = globalPtys.get(termId);
        const p = entry?.pty;
        if (p) {
          console.log(`[WS] continue: ${termId}, taskId: ${msg.taskId}, prompt length: ${(msg.prompt || '').length}`);
          // Update global meta
          if (entry.meta) {
            entry.meta.currentTaskId = msg.taskId;
            entry.meta.running = true;
          }
          // Update task tracking
          const prev = termTaskMap.get(termId);
          if (prev?.idleTimer) clearTimeout(prev.idleTimer);
          const contTask = db.getTaskById(msg.taskId);
          const contCheckpoint = getJsonlCheckpoint(contTask?.project_path || '');
          termTaskMap.set(termId, { taskId: msg.taskId, idleTimer: null, lastDataTime: Date.now(), jsonlCheckpoint: contCheckpoint });
          console.log(`[Task] continue termId=${termId} -> taskId=${msg.taskId}, checkpoint line=${contCheckpoint?.lineOffset ?? 'none'}`);
          // Save prompt-ready state BEFORE reset (reset clears the flag)
          const wasAtPrompt = p._claudeAtPrompt?.() || false;
          // Clear any stuck pending-prompt state from previous task (prevents perpetual deadlock)
          if (p._resetWaiting) p._resetWaiting();
          // Reset PTY state for polling (outputBuffer, lastDataTime, promptSeenSince)
          if (p._state) {
            p._state.outputBuffer = '';
            p._state.lastDataTime = Date.now();
          }
          // Reset prompt detection for the new task
          if (p._promptReset) p._promptReset();
          // Clear output buffer for new task
          termOutputBuffers.delete(termId);
          // Move task to in_progress
          if (msg.taskId) {
            const updated = db.moveTask({ id: msg.taskId, column: 'in_progress' });
            if (updated) broadcast({ type: 'task:moved', task: updated });
            updateCaffeinate();
          }
          // Track task count for /compact
          const count = (termTaskCounter.get(termId) || 0) + 1;
          termTaskCounter.set(termId, count);

          // Replace newlines with spaces to prevent multi-line shell execution
          const safePrompt = (msg.prompt || '').replace(/[\r\n]+/g, ' ').trim();

          const sendOrQueue = (text) => {
            if (wasAtPrompt) {
              // Claude was at ❯ — send after settle delay
              if (count % COMPACT_EVERY_N_TASKS === 0) {
                console.log(`[Compact] ${termId}: sending /compact after ${count} tasks`);
                p.write('/compact\r');
                db.logEvent(msg.taskId, 'compact', { term_id: termId, task_count: count });
                setTimeout(() => {
                  console.log(`[Compact] ${termId}: compact done, typing prompt`);
                  p.write(text + '\r');
                }, 3000);
              } else {
                console.log(`[PTY] Claude ready, sending prompt in ${TASK_START_DELAY}ms for ${termId}`);
                setTimeout(() => {
                  p.write(text);
                  setTimeout(() => p.write('\r'), 200);
                }, TASK_START_DELAY);
              }
            } else {
              // Claude not ready yet — queue via pendingPrompt mechanism
              // with a fallback: if onData never sees ❯ (e.g. idle-completed task), send directly
              console.log(`[PTY] Claude not at ❯ for ${termId}, queuing prompt with fallback`);
              p._setPendingPrompt(text);
              setTimeout(() => p._sendPendingNow?.(), TASK_START_DELAY + 5000);
            }
          };

          sendOrQueue(safePrompt);
        }
        break;
      }

      case 'terminal:kill':
        killShell(termId);
        break;

      case 'terminal:list': {
        // Return list of active terminals for client reconnection
        const terminals = [];
        for (const [id, entry] of globalPtys) {
          terminals.push({
            termId: id,
            cwd: entry.meta.cwd,
            currentTaskId: entry.meta.currentTaskId,
            running: entry.meta.running,
            isHelper: entry.meta.isHelper,
          });
        }
        ws.send(JSON.stringify({ type: 'terminal:list', terminals }));
        break;
      }

      case 'terminal:reattach': {
        // Reattach to an existing PTY (subscribe + replay buffer)
        const entry = globalPtys.get(termId);
        if (entry) {
          entry.subscribers.add(ws);
          // Send replay buffer so client sees previous output
          if (entry.replayBuffer) {
            ws.send(JSON.stringify({ type: 'terminal:output', termId, data: entry.replayBuffer }));
          }
          ws.send(JSON.stringify({ type: 'terminal:spawned', termId }));
          console.log(`[PTY] reattached ${termId}, replay ${entry.replayBuffer.length} bytes`);
        } else {
          ws.send(JSON.stringify({ type: 'terminal:exit', termId, exitCode: -1 }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // Unsubscribe from all terminals — PTYs stay alive
    for (const [, entry] of globalPtys) {
      entry.subscribers.delete(ws);
    }
    clients.delete(ws);
    // BUG-02: remove clientId mapping
    if (ws._clientId) clientIdMap.delete(ws._clientId);
  });
});

// Spawn a real interactive shell (or shell + command)
function spawnShell(ws, termId, opts = {}) {
  killShell(termId);
  termTaskCounter.delete(termId); // reset compact counter for fresh session

  const shell = '/bin/zsh';
  const cwd = opts.cwd || process.env.HOME || '/tmp';
  const cols = Math.max(40, opts.cols || 120);
  const rows = Math.max(10, opts.rows || 40);

  let p;
  try {
    if (opts.command) {
      // Run command directly — e.g. "claude"
      p = pty.spawn(shell, ['-l', '-c', opts.command], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', SHELL: shell },
      });
    } else {
      // Interactive login shell
      p = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', SHELL: shell },
      });
    }
  } catch (err) {
    console.error(`[PTY] spawn failed for ${termId}:`, err.message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal:exit', termId, error: err.message }));
    } else {
      broadcast({ type: 'terminal:exit', termId, error: err.message });
    }
    return;
  }

  // Store in global registry for persistence across WS reconnections
  globalPtys.set(termId, {
    pty: p,
    replayBuffer: '',
    subscribers: ws ? new Set([ws]) : new Set(),
    meta: {
      cwd,
      command: opts.command || null,
      currentTaskId: opts.taskId || null,
      running: !!opts.taskId,
      isHelper: termId === 'helper',
      autoApprove: !!opts.autoApprove,
    },
  });

  // Auto-approve Claude Code prompts for task terminals
  // State object shared between closure and terminal:continue handler
  const ptyState = { outputBuffer: '', lastDataTime: Date.now() };
  let claudeAtPrompt = false; // true when ❯ is visible and Claude is idle
  p._state = ptyState; // expose for terminal:continue to reset
  p._promptReset = () => {
    promptSeenSince = null;
    rateLimitDetected = false;
    claudeAtPrompt = false;
    if (promptApproveTimer) { clearTimeout(promptApproveTimer); promptApproveTimer = null; }
  };
  // Allow terminal:continue to queue a prompt if Claude is not yet at ❯
  p._setPendingPrompt = (text) => {
    pendingPrompt = text;
    waitingForClaude = true;
    claudeAtPrompt = false;
  };
  p._isWaitingForClaude = () => waitingForClaude;
  p._claudeAtPrompt = () => claudeAtPrompt;
  // Clear stuck pending-prompt state (used at start of each terminal:continue)
  p._resetWaiting = () => {
    waitingForClaude = false;
    pendingPrompt = null;
  };
  // Force-send pending prompt (fallback if onData never fires with ❯)
  p._sendPendingNow = () => {
    if (pendingPrompt !== null) {
      const toSend = pendingPrompt.replace(/[\r\n]+/g, ' ').trim();
      pendingPrompt = null;
      waitingForClaude = false;
      console.log(`[PTY] Fallback: force-sending stuck prompt for ${termId}`);
      p.write(toSend);
      setTimeout(() => p.write('\r'), 200);
      ptyState.outputBuffer = '';
      ptyState.lastDataTime = Date.now();
      termOutputBuffers.delete(termId);
    }
  };

  // Register task mapping and start polling for auto-approve + idle detection
  let pollInterval = null;
  let rateLimitUntil = null; // timestamp when rate limit resets
  let rateLimitTimer = null;
  let promptSeenSince = null; // timestamp when Claude's input prompt was first detected
  let rateLimitDetected = false; // sticky flag — set in onData, not lost when buffer rotates
  let rateLimitFirstDetectedAt = null; // when rate limit was first seen — used to wait for full message
  let promptApproveTimer = null; // debounce for auto-approve in onData

  function hasPrompt(text, nospaceText) {
    // BUG-10: "1.yes + no" pattern requires "Esc to cancel" to distinguish
    // Claude Code system prompts from Claude's own questions (which may contain
    // "1. Yes" / "2. No" as answer options)
    const isSystemPromptPattern = nospaceText.includes('1.yes') && nospaceText.includes('no') && nospaceText.includes('esctocancel');
    return (
      text.includes('Do you want to') || nospaceText.includes('doyouwantto') ||
      text.includes('Run command') || nospaceText.includes('runcommand') ||
      text.includes('trust this folder') || nospaceText.includes('trustthisfolder') ||
      /\(y\/n\)/i.test(text) ||
      text.includes('Enter to confirm') || nospaceText.includes('entertoconfirm') ||
      nospaceText.includes('esctocancel') ||
      isSystemPromptPattern
    );
  }

  // Lightweight auto-approve poll for manual/helper terminals (no taskId)
  // Fires when: global autoApproveEnabled OR this terminal's per-terminal meta.autoApprove is set
  if (!opts.taskId) {
    const gEntryRef = globalPtys.get(termId);
    const manualApproveInterval = setInterval(() => {
      const perTerminal = gEntryRef?.meta?.autoApprove;
      if (!autoApproveEnabled && !perTerminal) return;
      const clean = stripAnsi(ptyState.outputBuffer.slice(-2000));
      const norm = clean.replace(/\r/g, '');
      const nospace = norm.replace(/\s+/g, '').toLowerCase();
      if (hasPrompt(norm.slice(-300), nospace.slice(-300))) {
        console.log(`[AutoApprove] ${termId}: prompt detected in manual/helper terminal, sending Enter`);
        try { p.write('\r'); } catch {}
        ptyState.outputBuffer = '';
        ptyState.lastDataTime = Date.now();
      }
    }, 3000);
    p.onExit(() => clearInterval(manualApproveInterval));
  }

  if (opts.autoApprove && opts.taskId) {
    const prev = termTaskMap.get(termId);
    if (prev?.idleTimer) clearTimeout(prev.idleTimer);
    const initTask = db.getTaskById(opts.taskId);
    const initCheckpoint = getJsonlCheckpoint(initTask?.project_path || opts.cwd || '');
    termTaskMap.set(termId, { taskId: opts.taskId, idleTimer: null, lastDataTime: Date.now(), jsonlCheckpoint: initCheckpoint });
    console.log(`[Task] Registered termId=${termId} -> taskId=${opts.taskId}, checkpoint line=${initCheckpoint?.lineOffset ?? 'none'}`);

    // Poll every 3 seconds — handles auto-approve, rate-limit, and idle completion
    // Uses termTaskMap for current taskId so it stays correct after terminal:continue
    function getCurrentTaskId() {
      const entry = termTaskMap.get(termId);
      return entry?.taskId || null;
    }

    pollInterval = setInterval(() => {
      if (waitingForClaude) return; // still initializing, skip all detection
      const currentTaskId = getCurrentTaskId();
      if (!currentTaskId) return; // no active task (between tasks)

      const clean = stripAnsi(ptyState.outputBuffer.slice(-2000));
      const idleSeconds = (Date.now() - ptyState.lastDataTime) / 1000;

      const norm = clean.replace(/\r/g, '');
      const nospace = norm.replace(/\s+/g, '').toLowerCase();

      // --- Rate limit detection ---
      const nospaceNorm = nospace.replace(/[\u2018\u2019']/g, '');  // normalize curly/straight quotes
      const isRateLimited = rateLimitDetected || nospaceNorm.includes('youvehityourlimit') || nospace.includes('you\'vehityourlimit');

      if (isRateLimited && !rateLimitUntil) {
        const timeMatch = norm.match(/reset[^.\n]*?(\d{1,2}(?::\d{2})?\s*[ap]m)/i)
          || norm.match(/(\d{1,2}:\d{2}\s*(?:[ap]m)?)/i)
          || norm.match(/(\d{1,2}\s*[ap]m)/i)
          || nospace.match(/reset[^.]*?(\d{1,2}(?::\d{2})?[ap]m)/i);
        let resetTime;
        if (timeMatch) {
          resetTime = parseResetTime(timeMatch[1]);
          rateLimitFirstDetectedAt = null; // found — reset for next time
        } else {
          // Time not in buffer yet — give up to 15s for the full message to arrive
          if (!rateLimitFirstDetectedAt) rateLimitFirstDetectedAt = Date.now();
          if (Date.now() - rateLimitFirstDetectedAt < 15000) return; // retry next poll
          rateLimitFirstDetectedAt = null;
          resetTime = Date.now() + 30 * 60 * 1000;
        }

        const continueAt = resetTime + 60000;
        rateLimitUntil = continueAt;

        // Task stays in_progress — wait for rate limit reset, then send "continue"
        console.log(`[RateLimit] ${termId}: detected! Task #${currentTaskId} stays in_progress. Reset at ${new Date(resetTime).toLocaleTimeString()}, continue at ${new Date(continueAt).toLocaleTimeString()}`);

        // Block new task starts for this terminal globally
        rateLimitedTerms.add(termId);

        db.logEvent(currentTaskId, 'rate_limited', {
          term_id: termId,
          reset_time: new Date(resetTime).toISOString(),
          continue_at: new Date(continueAt).toISOString(),
          wait_minutes: Math.round((continueAt - Date.now()) / 60000),
        });

        broadcast({
          type: 'ratelimit:detected',
          taskId: currentTaskId,
          termId,
          resetTime: new Date(resetTime).toISOString(),
          continueAt: new Date(continueAt).toISOString(),
        });

        const delayMs = continueAt - Date.now();
        rateLimitTimer = setTimeout(() => {
          rateLimitUntil = null;
          rateLimitDetected = false;
          rateLimitFirstDetectedAt = null;
          ptyState.lastDataTime = Date.now();
          ptyState.outputBuffer = '';

          // Unblock this terminal for new tasks
          rateLimitedTerms.delete(termId);

          db.logEvent(currentTaskId, 'rate_limit_resolved', {
            term_id: termId,
            waited_ms: Math.max(delayMs, 1000),
          });

          // Send continue prompt to Claude Code
          try { p.write('continue\r'); } catch {}
          console.log(`[RateLimit] ${termId}: resumed, sent "continue" for task #${currentTaskId}`);

          broadcast({
            type: 'ratelimit:resolved',
            taskId: currentTaskId,
            termId,
          });
        }, Math.max(delayMs, 1000));

        return;
      }

      // --- Permission prompt detection ---
      // Only check the tail of the output — prompts appear at the end, not mid-stream
      const promptWindow = norm.slice(-200);
      const promptWindowNospace = promptWindow.replace(/\s+/g, '').toLowerCase();
      const isPrompt = hasPrompt(promptWindow, promptWindowNospace);

      if (autoApproveEnabled && isPrompt) {
        console.log(`[AutoApprove] ${termId}: prompt detected (idle ${idleSeconds.toFixed(0)}s), sending Enter`);
        try { p.write('\r'); } catch {}
        ptyState.outputBuffer = '';
        ptyState.lastDataTime = Date.now();
        db.logEvent(currentTaskId, 'auto_approved', { source: 'poll', term_id: termId });
        return;
      }

      // --- Claude prompt detection (fast completion) ---
      if (!rateLimitUntil) {
        const lines = norm.split('\n').filter(l => l.trim());
        // Claude Code shows ❯ as input prompt, but status bar lines appear below it
        // Only check the last 4 lines to avoid false positives from ❯ in earlier tool output
        const recentLines = lines.slice(-4);
        // Only match bare ❯ (idle input prompt), not ❯ followed by echoed task text
        // e.g. "❯ Review /Users/..." is echoed input, NOT an idle prompt
        const isClaudeReady = recentLines.some(l => /^❯\s*$/.test(l.trim()));

        // Detect active Claude work patterns — tool calls, spinners, running indicators
        const claudeWorking = /[⎿↳●◆⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Running\b|Bash\s*\(|Read\s*\(|Write\s*\(|Edit\s*\(|Glob\s*\(|Grep\s*\(|Task\s*\(|WebFetch\s*\(|LS\s*\(/
          .test(clean.slice(-800));

        if (isClaudeReady && !isPrompt && !claudeWorking && idleSeconds >= 3) {
          claudeAtPrompt = true;
          if (!promptSeenSince) {
            promptSeenSince = Date.now();
            console.log(`[IdleDetect] ${termId}: Claude prompt detected, starting ${PROMPT_COMPLETE_DELAY}ms countdown`);
          }
          const promptAge = Date.now() - promptSeenSince;
          if (promptAge >= PROMPT_COMPLETE_DELAY) {
            console.log(`[IdleDetect] ${termId}: Claude prompt stable for ${(promptAge / 1000).toFixed(1)}s, completing task ${currentTaskId}`);
            promptSeenSince = null;
            completeTaskFromServer(currentTaskId, termId);
            return;
          }
        } else {
          promptSeenSince = null;
        }

        // --- Fallback idle completion (skip if waiting for rate limit) ---
        if (idleSeconds >= IDLE_COMPLETE_DELAY / 1000) {
          if (isPrompt) {
            console.log(`[IdleDetect] ${termId}: idle ${idleSeconds.toFixed(0)}s but has pending prompt`);
            return;
          }
          console.log(`[IdleDetect] ${termId}: idle for ${idleSeconds.toFixed(0)}s, completing task ${currentTaskId}`);
          completeTaskFromServer(currentTaskId, termId);
        }
      }
    }, 3000);
  }

  // If a prompt was provided, wait for Claude's ❯ prompt then type it
  let waitingForClaude = !!(opts.prompt);
  let pendingPrompt = opts.prompt || null;

  p.onData((data) => {
    // Broadcast to all subscribers + buffer for replay on reconnect
    const gEntry = globalPtys.get(termId);
    if (gEntry) {
      gEntry.replayBuffer += data;
      if (gEntry.replayBuffer.length > 50000) {
        gEntry.replayBuffer = gEntry.replayBuffer.slice(-40000);
      }
      const outMsg = JSON.stringify({ type: 'terminal:output', termId, data });
      for (const sub of gEntry.subscribers) {
        if (sub.readyState === WebSocket.OPEN) sub.send(outMsg);
      }
    }

    // Detect Claude ready (❯ prompt) and type the pending prompt
    if (waitingForClaude && pendingPrompt) {
      const clean = stripAnsi(data);
      // Auto-approve permission prompts even while waiting for Claude to start —
      // they can appear before ❯ (e.g. "trust this folder" on first run)
      if (opts.autoApprove && autoApproveEnabled) {
        const cleanCheck = clean;
        const nospaceCheck = clean.replace(/\s+/g, '').toLowerCase();
        if (hasPrompt(cleanCheck, nospaceCheck)) {
          console.log(`[AutoApprove] ${termId}: permission prompt during waitingForClaude, sending Enter`);
          try { p.write('\r'); } catch {}
        }
      }
      if (clean.includes('❯')) {
        const toSend = pendingPrompt;
        pendingPrompt = null;
        // waitingForClaude stays true until prompt is actually sent
        setTimeout(() => {
          console.log(`[PTY] Claude ready, typing prompt for ${termId}`);
          const safeSend = toSend.replace(/[\r\n]+/g, ' ').trim();
          p.write(safeSend);
          setTimeout(() => p.write('\r'), 200);
          // Now release — Claude will start processing
          waitingForClaude = false;
          promptSeenSince = null;
          ptyState.outputBuffer = '';
          ptyState.lastDataTime = Date.now();
          termOutputBuffers.delete(termId);
        }, 300);
      }
      // While waiting for Claude to start, skip all other detection
      return;
    }
    // Still waiting for prompt to be sent (in the 300ms setTimeout)
    if (waitingForClaude) return;

    if (!opts.autoApprove) return;

    // Any new output means Claude is still working — reset prompt completion timer
    promptSeenSince = null;

    // Sticky rate limit detection — catch it in onData before buffer rotates
    if (!rateLimitDetected) {
      const stripped = stripAnsi(data).replace(/\s+/g, '').toLowerCase().replace(/[\u2018\u2019']/g, '');
      if (stripped.includes('youvehityourlimit')) {
        rateLimitDetected = true;
        console.log(`[RateLimit] ${termId}: detected in onData (sticky flag set)`);
      }
    }

    // Auto-approve in onData — catches prompts that disappear from buffer before poll fires
    if (autoApproveEnabled && !rateLimitUntil && !waitingForClaude) {
      const clean = stripAnsi(data);
      const nospaceClean = clean.replace(/\s+/g, '').toLowerCase();
      // Check last 150 chars of buffer — permission prompts appear at the END of output,
      // not in the middle. Smaller window prevents false positives on Claude's conversational text.
      const bufSample = stripAnsi(ptyState.outputBuffer.slice(-150)).replace(/\r/g, '');
      const bufNospace = bufSample.replace(/\s+/g, '').toLowerCase();
      if (hasPrompt(clean, nospaceClean) || hasPrompt(bufSample, bufNospace)) {
        if (!promptApproveTimer) {
          promptApproveTimer = setTimeout(() => {
            promptApproveTimer = null;
            if (autoApproveEnabled && !rateLimitUntil) {
              console.log(`[AutoApprove] ${termId}: prompt caught in onData, sending Enter`);
              try { p.write('\r'); } catch {}
              ptyState.outputBuffer = '';
              ptyState.lastDataTime = Date.now();
            }
          }, 400);
        }
      }
    }

    // Store stripped output for last_response capture
    let buf = termOutputBuffers.get(termId) || '';
    buf += stripAnsi(data);
    if (buf.length > 10000) buf = buf.slice(-8000);
    termOutputBuffers.set(termId, buf);

    ptyState.outputBuffer += data;
    if (ptyState.outputBuffer.length > 5000) {
      ptyState.outputBuffer = ptyState.outputBuffer.slice(-3000);
    }

    ptyState.lastDataTime = Date.now();
  });

  p.onExit(({ exitCode }) => {
    // Clear polling and rate limit timers
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; }
    if (promptApproveTimer) { clearTimeout(promptApproveTimer); promptApproveTimer = null; }
    // Unblock rate limit tracking for this terminal
    rateLimitedTerms.delete(termId);
    // If task was still mapped (not stopped), complete it
    const entry = termTaskMap.get(termId);
    if (entry?.taskId) {
      if (exitCode !== 0) {
        broadcast({ type: 'session:error', taskId: entry.taskId, error: `Process exited with code ${exitCode}` });
        db.logEvent(entry.taskId, 'process_exit', { exit_code: exitCode, term_id: termId });
      }
      completeTaskFromServer(entry.taskId, termId);
    }
    // Full cleanup on exit — PTY is gone, no more continue possible
    termTaskMap.delete(termId);
    // Broadcast exit to all subscribers
    const gEntry = globalPtys.get(termId);
    if (gEntry) {
      const exitMsg = JSON.stringify({ type: 'terminal:exit', termId, exitCode });
      for (const sub of gEntry.subscribers) {
        if (sub.readyState === WebSocket.OPEN) sub.send(exitMsg);
      }
    }
    globalPtys.delete(termId);
  });

  console.log(`[PTY] spawned ${termId}: ${cols}x${rows}, pid=${p.pid}`);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal:spawned', termId }));
  } else {
    broadcast({ type: 'terminal:spawned', termId });
  }
}

function killShell(termId) {
  const entry = globalPtys.get(termId);
  if (entry) {
    try { entry.pty.kill(); } catch {}
    globalPtys.delete(termId);
  }
}


// Extract last Claude response from JSONL session files (clean, no TUI artifacts)
// Get the current JSONL file + line count for a project — used as checkpoint at task start
function getJsonlCheckpoint(projectPath) {
  try {
    const effectivePath = projectPath || process.env.HOME;
    const dirName = effectivePath.replace(/\//g, '-');
    const claudeProjectDir = path.join(process.env.HOME, '.claude', 'projects', dirName);
    const files = fs.readdirSync(claudeProjectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(claudeProjectDir, f);
        return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const lineCount = fs.readFileSync(files[0].path, 'utf8').split('\n').filter(l => l.trim()).length;
    return { file: files[0].path, lineOffset: lineCount };
  } catch {
    return null;
  }
}

function extractLastResponseFromJSONL(projectPath, checkpoint) {
  try {
    // Fix 1: fall back to HOME when project_path is empty
    const effectivePath = projectPath || process.env.HOME;
    const dirName = effectivePath.replace(/\//g, '-');
    const claudeProjectDir = path.join(process.env.HOME, '.claude', 'projects', dirName);

    // Find the most recently modified .jsonl file
    const files = fs.readdirSync(claudeProjectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(claudeProjectDir, f);
        return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return '';

    // Fix 2: if we have a checkpoint, prefer that file and only search lines written after task started
    let targetFile = files[0];
    let lineStart = 0;
    if (checkpoint) {
      const cpFile = files.find(f => f.path === checkpoint.file);
      if (cpFile) {
        targetFile = cpFile;
        lineStart = checkpoint.lineOffset;
      }
    }

    const content = fs.readFileSync(targetFile.path, 'utf8');
    const allLines = content.split('\n').filter(l => l.trim());
    // Only look at lines written after the checkpoint (task's own messages)
    const lines = lineStart > 0 ? allLines.slice(lineStart) : allLines;
    const searchLines = lines.length > 0 ? lines : allLines; // fallback to all if slice empty

    // Find the last assistant message with text content
    const findLastAssistantText = (linesToSearch) => {
      for (let i = linesToSearch.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(linesToSearch[i]);
          if (obj.type !== 'assistant') continue;
          const blocks = obj.message?.content || [];
          const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
          if (texts.length > 0) return texts.join('\n').slice(-2000);
        } catch {}
      }
      return '';
    };

    const result = findLastAssistantText(searchLines);
    if (result) return result;

    // Fallback: if checkpoint pointed to an older file and Claude Code created a new session,
    // search the newest file (without checkpoint restriction)
    if (targetFile.path !== files[0].path) {
      const newestContent = fs.readFileSync(files[0].path, 'utf8');
      const newestLines = newestContent.split('\n').filter(l => l.trim());
      const newestResult = findLastAssistantText(newestLines);
      if (newestResult) return newestResult;
    }

    return '';
  } catch (err) {
    console.error('[JSONL] Failed to extract response:', err.message);
    return '';
  }
}

// Fallback: extract from raw PTY output (used when JSONL is unavailable)
function extractLastResponse(rawOutput) {
  if (!rawOutput) return '';
  let text = rawOutput.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(-5000);
  const S = '◐◑◒◓✻✶✳✢✣✤·✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣷⣯⣟⡿⢿⣻⣽⣾';
  const lines = text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (new RegExp(`^[${S}\\s\\d]*$`).test(trimmed)) return false;
    if (new RegExp(`^[${S}]*\\s*[A-Z][a-z]+(?:ing|ed|ling|ering|ting)?[…\\.]`).test(trimmed)) return false;
    if (new RegExp(`^[${S}]*\\s*[A-Z][a-z]+(?:ed|ing)?\\s+for\\s+\\d+[ms]`).test(trimmed)) return false;
    if (/\?\s*for\s+shortcuts/i.test(trimmed)) return false;
    if (/esctointerrupt/i.test(trimmed)) return false;
    if (/esc\s*to\s*interrupt/i.test(trimmed)) return false;
    if (/·\/?effort/i.test(trimmed)) return false;
    if (/running\s+\w+\s+hook/i.test(trimmed)) return false;
    if (/IDE\s*extension\s*install\s*failed/i.test(trimmed)) return false;
    if (/IDEextensioninstallfailed/i.test(trimmed)) return false;
    if (/^[─━]{3,}/.test(trimmed)) return false;
    if (/^❯\s*$/.test(trimmed)) return false;
    if (/^\[Pasted\s*text\s*#\d+/i.test(trimmed)) return false;
    if (/^Searched\s+for\s+\d+\s+pattern/i.test(trimmed)) return false;
    return true;
  });
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('⏺')) { start = i; break; }
  }
  const response = lines.slice(start).join('\n').trim();
  return (response || lines.join('\n').trim()).slice(-2000);
}

function parseResetTime(timeStr) {
  // Supports: "12pm", "12:30pm", "2:30 PM", "14:30"
  const match = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!match) return Date.now() + 60000;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target <= new Date()) target.setDate(target.getDate() + 1);
  return target.getTime();
}


// --- Start ---

// On startup, reset any tasks stuck in in_progress — their PTY processes no longer exist
(function cleanupStuckTasks() {
  const stuck = db.getTasksByColumn('in_progress');
  if (stuck.length > 0) {
    stuck.forEach(task => {
      db.moveTask({ id: task.id, column: 'backlog' });
      db.logEvent(task.id, 'stuck_reset', { title: task.title, project_path: task.project_path });
    });
    console.log(`[Startup] Moved ${stuck.length} stuck in_progress task(s) back to backlog`);
    // If auto-queue was on before crash, resume it after clients connect
    if (autoQueueEnabled) {
      setTimeout(() => {
        console.log('[Startup] Auto-queue was ON before restart — triggering server auto-queue');
        triggerServerAutoQueue();
      }, 5000);
    }
  }
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Kanban running at http://localhost:${PORT}`);
  updateCaffeinate(); // check on startup in case tasks were left in_progress
});

// Clean up caffeinate on shutdown
process.on('exit', () => {
  if (caffeinateProc) { try { caffeinateProc.kill(); } catch {} }
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
