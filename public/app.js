// --- State ---
let tasks = [];
let sessionStatuses = {}; // taskId -> { status, resetTime }
let ws = null;
let autoQueueEnabled = false;
let autoApproveEnabled = false;
let maxTerminals = parseInt(localStorage.getItem('maxTerminals') || '0'); // 0 = unlimited

// BUG-02: unique ID for this browser tab — sent in run requests so server
// can broadcast task:run only to the originating client
const CLIENT_ID = crypto.randomUUID();

// --- Filters ---
let filterSearch = '';
let filterPriority = '';
let filterProject = '';

function applyFilters() {
  filterSearch = (document.getElementById('filter-search').value || '').toLowerCase();
  filterPriority = document.getElementById('filter-priority').value;
  filterProject = document.getElementById('filter-project').value;
  renderBoard();
}

function updateProjectFilter() {
  const select = document.getElementById('filter-project');
  const current = select.value;
  const projects = [...new Set(tasks.map(t => t.project_path).filter(Boolean))].sort();

  // Keep first option, rebuild rest
  select.length = 1;
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p.replace(/\/+$/, '').split('/').pop() || p;
    select.appendChild(opt);
  }
  select.value = current; // restore selection
}

function filterTasks(taskList) {
  return taskList.filter(t => {
    if (filterPriority && (t.priority || 'medium') !== filterPriority) return false;
    if (filterProject && t.project_path !== filterProject) return false;
    if (filterSearch) {
      const haystack = ((t.title || '') + ' ' + (t.description || '')).toLowerCase();
      if (!haystack.includes(filterSearch)) return false;
    }
    return true;
  });
}

// --- API ---

async function fetchTasks() {
  const res = await fetch('/api/tasks');
  tasks = await res.json();
  renderBoard();
  // BUG-20: restore sessionStatuses for in_progress tasks after page reload
  const inProgressTasks = tasks.filter(t => t.column === 'in_progress');
  for (const t of inProgressTasks) {
    if (!sessionStatuses[t.id]) {
      fetch(`/api/tasks/${t.id}/status`)
        .then(r => r.json())
        .then(data => {
          if (data.alive) {
            sessionStatuses[t.id] = { status: 'running' };
            renderBoard();
          }
        })
        .catch(() => {});
    }
  }
}

async function createTask(data) {
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function updateTaskApi(id, data) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function deleteTask(id) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
}

async function moveTask(id, column, position) {
  await fetch(`/api/tasks/${id}/move`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column, position }),
  });
}

async function runTask(id) {
  // BUG-02: pass clientId so server broadcasts task:run only to this tab
  const res = await fetch(`/api/tasks/${id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error || `Failed to run task (${res.status})`;
    addLog(`[Error] ${msg}`, 'error');
    console.error('[runTask]', msg);
  }
}

async function stopTask(id) {
  await fetch(`/api/tasks/${id}/stop`, { method: 'POST' });
}

// --- WebSocket ---

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  });

  ws.onopen = () => {
    addLog('WebSocket connected', 'ws');
    // BUG-02: register this tab's clientId with the server
    ws.send(JSON.stringify({ type: 'client:register', clientId: CLIENT_ID }));
    // BUG-12: re-sync auto-approve state on every reconnect (server may have restarted)
    fetchAutoApprove();
    // BUG-06: re-sync auto-queue state on every reconnect
    fetchAutoQueue();
    fetchMaxTerminals();
    // Re-attach terminal manager listeners on every (re)connect
    if (window.terminalManager) {
      window.terminalManager._attachWS();
    }
  };

  ws.onclose = () => {
    addLog('WebSocket disconnected, reconnecting in 2s...', 'error');
    setTimeout(connectWS, 2000);
  };
}

function handleWSMessage(msg) {
  // Log non-terminal-output messages
  if (msg.type !== 'terminal:output') {
    const taskLabel = msg.taskId ? ` #${msg.taskId}` : (msg.task?.id ? ` #${msg.task.id}` : '');
    const cat = msg.type.startsWith('ratelimit') ? 'error'
      : msg.type === 'session:completed' ? 'complete'
      : msg.type === 'session:error' ? 'error'
      : msg.type.startsWith('task:') ? 'ws'
      : 'info';
    addLog(`[WS] ${msg.type}${taskLabel}`, cat);
  }

  switch (msg.type) {
    case 'task:created':
      resetAllCompletedFlag();
      // fall through
    case 'task:updated':
    case 'task:moved': {
      // BUG-07: detect if a slot freed up from in_progress (for tryAutoQueue)
      const prevTask = tasks.find(t => t.id === msg.task.id);
      const wasInProgress = prevTask?.column === 'in_progress';
      const idx = tasks.findIndex(t => t.id === msg.task.id);
      if (idx >= 0) tasks[idx] = msg.task;
      else tasks.push(msg.task);
      renderBoard();
      if (msg.type === 'task:moved') {
        // Only check completion when a task leaves in_progress (not on manual ✓ Done click)
        if (wasInProgress) checkAllTasksCompleted();
        // BUG-27: reset allCompletedFlag when task moved to backlog
        if (msg.task.column === 'backlog') resetAllCompletedFlag();
        // BUG-07: if task left in_progress, a slot freed up — try to run next
        if (wasInProgress && msg.task.column !== 'in_progress') {
          tryAutoQueue();
        }
      }
      break;
    }

    case 'task:deleted':
      // BUG-04: clear sessionStatus for the deleted task
      delete sessionStatuses[msg.id];
      tasks = tasks.filter(t => t.id !== msg.id);
      renderBoard();
      break;

    case 'task:run':
      addLog(`[Run] Task #${msg.taskId} → ${msg.cwd || 'HOME'}`, 'pty');
      if (window.terminalManager) {
        window.terminalManager.runInTaskTerminal(msg.taskId, msg.command, msg.cwd, msg.prompt);
      }
      sessionStatuses[msg.taskId] = { status: 'running' };
      renderBoard();
      break;

    case 'task:stop':
      if (window.terminalManager) {
        window.terminalManager.stopTaskInProject(msg.taskId, msg.projectPath);
      }
      delete sessionStatuses[msg.taskId];
      renderBoard();
      break;

    case 'session:started':
      sessionStatuses[msg.taskId] = { status: 'running' };
      renderBoard();
      break;

    case 'session:status':
      sessionStatuses[msg.taskId] = { status: msg.status, resetTime: msg.resetTime };
      renderBoard();
      updateTerminalStatus(msg.taskId);
      break;

    case 'session:completed': {
      const t = tasks.find(t => t.id === msg.taskId);
      addLog(`[Complete] Task #${msg.taskId} "${t?.title || ''}" → review`, 'complete');
      sessionStatuses[msg.taskId] = { status: 'completed' };
      renderBoard();
      if (window.terminalManager) {
        window.terminalManager.onTaskCompleted(msg.taskId);
      }
      tryAutoQueue();
      checkAllTasksCompleted();
      break;
    }

    case 'session:stopped':
      delete sessionStatuses[msg.taskId];
      renderBoard();
      break;

    case 'ratelimit:detected':
      addLog(`[RateLimit] Detected! Task #${msg.taskId}, reset: ${msg.resetTime}`, 'error');
      sessionStatuses[msg.taskId] = { status: 'waiting_reset', resetTime: msg.resetTime, continueAt: msg.continueAt };
      renderBoard();
      updateTerminalStatus(msg.taskId);
      showRateLimitOverlay(msg.taskId, msg.resetTime, msg.continueAt);
      break;

    case 'ratelimit:resolved':
      addLog(`[RateLimit] Resolved, resuming`, 'complete');
      if (msg.taskId) {
        sessionStatuses[msg.taskId] = { status: 'running' };
      }
      renderBoard();
      updateTerminalStatus(msg.taskId);
      hideRateLimitOverlay();
      break;

    case 'session:error':
      addLog(`[Error] Task #${msg.taskId}: ${msg.error}`, 'error');
      break;

    case 'settings:autoApprove':
      addLog(`[Settings] Auto-approve: ${msg.enabled ? 'ON' : 'OFF'}`, 'approve');
      autoApproveEnabled = msg.enabled;
      updateAutoApproveBtn();
      break;

    // BUG-05: sync auto-queue state across tabs via WS broadcast
    case 'settings:autoQueue':
      addLog(`[Settings] Auto-queue: ${msg.enabled ? 'ON' : 'OFF'}`, 'idle');
      autoQueueEnabled = msg.enabled;
      updateStartBtn();
      break;

    case 'settings:maxTerminals':
      maxTerminals = msg.value;
      updateMaxTerminalsUI();
      break;

    case 'terminal:spawned':
      addLog(`[PTY] Spawned: ${msg.termId}`, 'pty');
      break;

    case 'terminal:exit':
      addLog(`[PTY] Exit: ${msg.termId} (code ${msg.exitCode})`, msg.exitCode === 0 ? 'idle' : 'error');
      break;
  }
}

let rateLimitCountdown = null;

function showRateLimitOverlay(taskId, resetTime, continueAt) {
  hideRateLimitOverlay();
  const continueDate = new Date(continueAt);
  const resetDate = new Date(resetTime);

  const overlay = document.createElement('div');
  overlay.id = 'ratelimit-overlay';
  overlay.innerHTML = `
    <div class="ratelimit-content">
      <div class="ratelimit-icon">⏳</div>
      <div class="ratelimit-title">Rate limit reached</div>
      <div class="ratelimit-reset">Resets at ${resetDate.toLocaleTimeString()}</div>
      <div class="ratelimit-continue">Auto-continue at ${continueDate.toLocaleTimeString()}</div>
      <div class="ratelimit-countdown" id="ratelimit-countdown"></div>
    </div>
  `;
  document.getElementById('task-section').appendChild(overlay);

  rateLimitCountdown = setInterval(() => {
    const remaining = continueDate - Date.now();
    const el = document.getElementById('ratelimit-countdown');
    if (!el) { clearInterval(rateLimitCountdown); return; }
    if (remaining <= 0) {
      el.textContent = 'Resuming...';
      clearInterval(rateLimitCountdown);
    } else {
      const hrs = Math.floor(remaining / 3600000);
      const min = Math.floor((remaining % 3600000) / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      el.textContent = `${hrs.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

function hideRateLimitOverlay() {
  if (rateLimitCountdown) { clearInterval(rateLimitCountdown); rateLimitCountdown = null; }
  const overlay = document.getElementById('ratelimit-overlay');
  if (overlay) overlay.remove();
}

function updateTerminalStatus(taskId) {
  const status = sessionStatuses[taskId];
  const el = document.getElementById('terminal-status');
  if (!el) return;

  if (status?.status === 'waiting_reset' && status.resetTime) {
    const resetDate = new Date(status.resetTime);
    el.textContent = `Rate limited — resets at ${resetDate.toLocaleTimeString()}`;
    el.style.color = 'var(--warning)';
  } else if (status?.status === 'running') {
    el.textContent = 'Running';
    el.style.color = 'var(--success)';
  } else {
    el.textContent = '';
    el.style.color = '';
  }
}

// --- Column collapse ---

function toggleColumn(col) {
  const colEl = document.querySelector(`.column[data-column="${col}"]`);
  if (!colEl) return;
  colEl.classList.toggle('collapsed');
  const btn = colEl.querySelector('.column-collapse-btn');
  if (btn) btn.textContent = colEl.classList.contains('collapsed') ? '›' : '‹';

  // Persist state
  const collapsed = JSON.parse(localStorage.getItem('kanban:collapsed') || '[]');
  const isCollapsed = colEl.classList.contains('collapsed');
  if (isCollapsed && !collapsed.includes(col)) collapsed.push(col);
  else if (!isCollapsed) {
    const idx = collapsed.indexOf(col);
    if (idx >= 0) collapsed.splice(idx, 1);
  }
  localStorage.setItem('kanban:collapsed', JSON.stringify(collapsed));
}

function restoreCollapsed() {
  const collapsed = JSON.parse(localStorage.getItem('kanban:collapsed') || '[]');
  for (const col of collapsed) {
    const colEl = document.querySelector(`.column[data-column="${col}"]`);
    if (colEl) {
      colEl.classList.add('collapsed');
      const btn = colEl.querySelector('.column-collapse-btn');
      if (btn) btn.textContent = '›';
    }
  }
}

// --- Render ---

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low', hold: 'Hold' };

function renderBoard() {
  if (isDragging) return; // BUG-28: don't clobber SortableJS DOM during active drag
  updateProjectFilter();
  const columns = ['backlog', 'in_progress', 'review', 'done'];
  const filtered = filterTasks(tasks);

  for (const col of columns) {
    const list = document.querySelector(`.task-list[data-column="${col}"]`);
    const count = document.querySelector(`.column[data-column="${col}"] .column-count`);
    const colTasks = filtered.filter(t => t.column === col).sort((a, b) => {
      if (col === 'review' || col === 'done') {
        // Newest first: sort by when task entered this column
        return (b.column_changed_at || b.created_at || '').localeCompare(a.column_changed_at || a.created_at || '');
      }
      const pa = { high: 0, medium: 1, low: 2, hold: 3 }[a.priority] ?? 1;
      const pb = { high: 0, medium: 1, low: 2, hold: 3 }[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.position - b.position;
    });

    count.textContent = colTasks.length;

    if (col === 'review') {
      const approveBtn = document.getElementById('approve-all-btn');
      if (approveBtn) approveBtn.style.display = colTasks.length ? '' : 'none';
    }

    // Priority stats
    const statsEl = document.querySelector(`.priority-stats[data-column="${col}"]`);
    if (statsEl) {
      const h = colTasks.filter(t => t.priority === 'high').length;
      const m = colTasks.filter(t => (t.priority || 'medium') === 'medium').length;
      const l = colTasks.filter(t => t.priority === 'low').length;
      const hd = colTasks.filter(t => t.priority === 'hold').length;
      const parts = [];
      if (h) parts.push(`<span class="pstat-h">${h}H</span>`);
      if (m) parts.push(`<span class="pstat-m">${m}M</span>`);
      if (l) parts.push(`<span class="pstat-l">${l}L</span>`);
      if (hd) parts.push(`<span class="pstat-hold">${hd}Hold</span>`);
      statsEl.innerHTML = parts.join('');
      statsEl.style.display = parts.length ? '' : 'none';
    }

    const html = colTasks.map(t => renderTaskCard(t, col)).join('');
    if (list.innerHTML !== html) {
      list.innerHTML = html;
    }
  }
}

function renderTaskCard(task, column) {
  const status = sessionStatuses[task.id];
  const statusAttr = status ? ` data-status="${status.status}"` : '';
  const priority = task.priority || 'medium';

  // Compact card for Done column
  if (column === 'done') {
    const priorityBadge = `<span class="priority-badge ${priority}">${PRIORITY_LABELS[priority]}</span>`;
    const deleteBtn = `<button class="btn-delete-trash done-card-action" onclick="event.stopPropagation(); deleteTask(${task.id})" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>`;
    const rerunBtn = `<button class="btn btn-sm btn-run done-rerun-btn done-card-action" onclick="event.stopPropagation(); runTask(${task.id})" title="Re-run this task">▶ Re-run</button>`;
    return `
      <div class="task-card done-card-compact" data-id="${task.id}" data-priority="${priority}"${statusAttr} onclick="openEditModal(${task.id})">
        <div class="done-card-top">
          ${priorityBadge}
          <div class="done-card-actions">${rerunBtn}${deleteBtn}</div>
        </div>
        <div class="done-card-title">${escapeHtml(task.title)}</div>
        ${task.created_at ? `<span class="done-card-date">${formatDate(task.created_at)}</span>` : ''}
      </div>
    `;
  }

  let statusBadge = '';
  if (status?.status === 'running') {
    statusBadge = '<div class="status-badge running" title="Running"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></circle><path d="M8 3v5l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>';
  } else if (status?.status === 'waiting_reset') {
    const resetTime = status.resetTime ? new Date(status.resetTime).toLocaleTimeString() : '...';
    statusBadge = `<div class="status-badge rate-limited" title="Rate limited — ${resetTime}"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 011 1v3.25l2.13 1.28a1 1 0 01-1.03 1.72L7.5 8.75V4.5a1 1 0 011-1z"/></svg></div>`;
  }

  const priorityBadge = `<span class="priority-badge ${priority}">${PRIORITY_LABELS[priority]}</span>`;

  let actions = '';
  const isRunning = status?.status === 'running' || status?.status === 'waiting_reset';

  if (!isRunning && column !== 'done') {
    actions += `<button class="btn btn-sm btn-run" onclick="event.stopPropagation(); runTask(${task.id})">▶ Run</button>`;
  }
  if (isRunning) {
    actions += `<button class="btn btn-sm btn-stop" onclick="event.stopPropagation(); stopTask(${task.id})">■ Stop</button>`;
  }
  if (column === 'review') {
    actions += `<button class="btn btn-sm btn-return" onclick="event.stopPropagation(); openReturnModal(${task.id}, event)">↩ Return</button>`;
    actions += `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); moveTask(${task.id}, 'done')">✓ Done</button>`;
  }
  const editBtn = `<button class="btn-edit-pencil" onclick="event.stopPropagation(); openEditModal(${task.id})" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
  const deleteBtn = `<button class="btn-delete-trash" onclick="event.stopPropagation(); deleteTask(${task.id})" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>`;

  const projectTag = task.project_path
    ? `<div class="project-tag" title="${escapeAttr(task.project_path)}">${escapeHtml(task.project_path.replace(/\/+$/, '').split('/').pop())}</div>`
    : '';

  const descHtml = task.description
    ? `<div class="task-card-desc" onclick="event.stopPropagation(); this.classList.toggle('expanded')">${escapeHtml(task.description)}</div>`
    : '';

  // Blocked-by badge (subtask indicator)
  let blockedByHtml = '';
  if (task.parent_id) {
    const parent = tasks.find(t => t.id === task.parent_id);
    const parentTitle = parent ? escapeHtml(parent.title) : `#${task.parent_id}`;
    blockedByHtml = `<div class="blocked-by-badge" title="Blocked by: ${escapeAttr(parent?.title || '#' + task.parent_id)}">⛓ ${parentTitle}</div>`;
  }

  // Subtask count
  const subtaskCount = tasks.filter(t => t.parent_id === task.id).length;
  const subtaskHtml = subtaskCount > 0
    ? `<div class="subtask-count">${subtaskCount} subtask${subtaskCount > 1 ? 's' : ''}</div>`
    : '';

  // Attachments badge
  let attachmentsHtml = '';
  try {
    const attList = JSON.parse(task.attachments || '[]');
    if (attList.length > 0) {
      const fileCount = attList.filter(a => a.type === 'file').length;
      const urlCount = attList.filter(a => a.type === 'url').length;
      const parts = [];
      if (fileCount > 0) parts.push(`📎 ${fileCount}`);
      if (urlCount > 0) parts.push(`🔗 ${urlCount}`);
      attachmentsHtml = `<div class="attachment-badge" title="${escapeAttr(attList.map(a => a.type === 'url' ? a.url : a.name).join(', '))}">${parts.join(' ')}</div>`;
    }
  } catch {}

  // Last response from Claude (shown in review and backlog if available)
  // RESP-BUG-01: convert newlines to <br> for readability in the card
  const lastResponseHtml = (column === 'review' || column === 'backlog') && task.last_response
    ? `<div class="task-card-response-wrapper collapsed" onclick="event.stopPropagation(); this.classList.toggle('collapsed')"><div class="response-label">Claude Response ▾</div><div class="task-card-response">${escapeHtml(task.last_response).replace(/\n/g, '<br>')}</div></div>`
    : '';

  const NO_OP_PHRASES = [
    'already done', 'Already done',
    'уже сделан', 'уже реализован',
    'nothing to do',
    'ничего не делать', 'Ничего делать не нужно',
    'рабочее дерево чистое',
    'нечего добавлять',
  ];
  const isNoOp = column === 'done' && task.last_response
    && NO_OP_PHRASES.some(p => task.last_response.includes(p));
  const noOpBadge = isNoOp
    ? `<span class="task-noop-badge" title="Task was already done — no changes were made">no-op</span>`
    : '';

  return `
    <div class="task-card" data-id="${task.id}" data-priority="${priority}"${statusAttr} onclick="openEditModal(${task.id})">
      ${statusBadge}
      ${priorityBadge}
      <div class="task-card-title">${escapeHtml(task.title)}${noOpBadge}</div>
      ${descHtml}
      ${lastResponseHtml}
      ${projectTag}
      ${blockedByHtml}
      ${subtaskHtml}
      ${attachmentsHtml}
      <div class="task-card-actions">${actions}</div>
      <div class="task-card-footer">
        ${task.created_at ? `<span class="task-card-date">${formatDate(task.created_at)}${task.column_changed_at ? ' · ' + formatTimeAgo(task.column_changed_at) + ' in column' : ''}</span>` : '<span></span>'}
        <div class="task-card-footer-actions">${editBtn}${deleteBtn}</div>
      </div>
    </div>
  `;
}

function parseUTCDate(isoStr) {
  // SQLite datetime('now') stores UTC without 'Z' suffix — append it for correct parsing
  if (isoStr && !isoStr.endsWith('Z') && !isoStr.includes('+') && !isoStr.includes('T')) {
    return new Date(isoStr.replace(' ', 'T') + 'Z');
  }
  return new Date(isoStr);
}

function formatDate(isoStr) {
  const d = parseUTCDate(isoStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${day} ${month}, ${hours}:${mins}`;
}

function formatTimeAgo(isoStr) {
  const diff = Date.now() - parseUTCDate(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function viewTerminal(taskId) {
  // Find the project path for this task and switch to its tab
  if (window.terminalManager) {
    const task = tasks.find(t => t.id === taskId);
    if (task && task.project_path) {
      const proj = window.terminalManager.projects.get(task.project_path);
      if (proj) {
        window.terminalManager._switchToProject(task.project_path);
      }
    }
  }
}

// --- Drag and Drop ---

let isDragging = false; // BUG-28: prevent renderBoard from clobbering SortableJS during drag

function initSortable() {
  document.querySelectorAll('.task-list').forEach(list => {
    new Sortable(list, {
      group: 'kanban',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'dragging',
      onStart() {
        isDragging = true;
      },
      onEnd(evt) {
        isDragging = false;
        const taskId = parseInt(evt.item.dataset.id);
        const oldColumn = evt.from.dataset.column;
        const newColumn = evt.to.dataset.column;
        const newPosition = evt.newIndex;

        // BUG-01: skip if reordering within in_progress (don't re-run)
        if (oldColumn === 'in_progress' && newColumn === 'in_progress') {
          moveTask(taskId, newColumn, newPosition);
          return;
        }

        if (newColumn === 'in_progress') {
          runTask(taskId);
        } else {
          // BUG-03: if dragging out of in_progress, just moveTask — server will kill PTY
          // Don't call stopTask (which moves to backlog) + moveTask (race condition)
          if (oldColumn === 'in_progress') {
            // Use stop+move combo: pass target column to avoid double-move race
            fetch(`/api/tasks/${taskId}/stop-move`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ column: newColumn, position: newPosition }),
            });
          } else {
            moveTask(taskId, newColumn, newPosition);
          }
          // BUG-27: reset allCompletedFlag when task moved to backlog
          if (newColumn === 'backlog') {
            resetAllCompletedFlag();
          }
        }
      },
    });
  });
}

// --- Modal (Create & Edit) ---

function initModal() {
  const overlay = document.getElementById('modal-overlay');
  const form = document.getElementById('task-form');
  const addBtn = document.getElementById('add-task-btn');
  const cancelBtn = document.getElementById('modal-cancel');

  document.getElementById('task-priority').addEventListener('change', updatePrioritySelectStyle);

  const pathInput = document.getElementById('task-project-path');
  pathInput.addEventListener('blur', () => { pathInput.scrollLeft = pathInput.scrollWidth; });
  pathInput.addEventListener('change', () => { pathInput.scrollLeft = pathInput.scrollWidth; });

  addBtn.addEventListener('click', () => openCreateModal());

  cancelBtn.addEventListener('click', () => closeModal());

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('task-edit-id').value;
    const title = document.getElementById('task-title').value.trim();
    const description = document.getElementById('task-description').value.trim();
    const priority = document.getElementById('task-priority').value;
    const project_path = document.getElementById('task-project-path').value.trim();

    if (!title) return;

    if (editId) {
      // BUG-14: only allow priority change for running tasks
      const editTask = tasks.find(t => t.id === parseInt(editId));
      const editStatus = sessionStatuses[editTask?.id];
      const editRunning = editStatus?.status === 'running' || editStatus?.status === 'waiting_reset';
      const updatePayload = editRunning
        ? { priority }
        : { title, description, priority, project_path };
      await updateTaskApi(parseInt(editId), updatePayload);
      await _flushPendingAttachments(parseInt(editId));
    } else {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, priority, project_path }),
      });
      const newTask = await res.json();
      if (newTask?.id && _attachPending.length > 0) {
        await _flushPendingAttachments(newTask.id);
      }
    }
    closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!overlay.classList.contains('hidden')) closeModal();
      const returnPopup = document.getElementById('return-popup');
      if (returnPopup && !returnPopup.classList.contains('hidden')) closeReturnModal();
    }
  });
}

function updateProjectPathDatalist() {
  const datalist = document.getElementById('project-path-list');
  if (!datalist) return;
  const projects = [...new Set(tasks.map(t => t.project_path).filter(Boolean))].sort();
  datalist.innerHTML = projects.map(p => `<option value="${escapeAttr(p)}">`).join('');
}

function openCreateModal() {
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('modal-submit').textContent = 'Create';
  document.getElementById('task-edit-id').value = '';
  document.getElementById('task-form').reset();
  document.getElementById('task-priority').value = 'medium';
  const responseEl = document.getElementById('task-last-response');
  if (responseEl) { responseEl.value = ''; responseEl.parentElement.style.display = 'none'; }
  updatePrioritySelectStyle();
  updateProjectPathDatalist();
  _initAttachments(null); // null = create mode
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('task-title').focus();
}

function openEditModal(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  // BUG-14: lock editing of execution-sensitive fields while task is running
  const status = sessionStatuses[task.id];
  const isRunning = status?.status === 'running' || status?.status === 'waiting_reset';

  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('modal-submit').textContent = 'Save';
  document.getElementById('task-edit-id').value = task.id;
  document.getElementById('task-title').value = task.title;
  document.getElementById('task-description').value = task.description || '';
  document.getElementById('task-priority').value = task.priority || 'medium';
  const pathEl = document.getElementById('task-project-path');
  pathEl.value = task.project_path || '';
  requestAnimationFrame(() => { pathEl.scrollLeft = pathEl.scrollWidth; });

  // BUG-14: disable fields that affect the running session
  const lockedFields = ['task-title', 'task-description', 'task-project-path'];
  for (const id of lockedFields) {
    const el = document.getElementById(id);
    if (el) el.readOnly = isRunning;
  }
  // Show/hide running warning banner
  let banner = document.getElementById('modal-running-banner');
  if (isRunning) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'modal-running-banner';
      banner.style.cssText = 'background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);border-radius:6px;padding:7px 10px;margin-bottom:10px;font-size:12px;color:var(--danger);';
      banner.textContent = '⚠ Task is currently running — title, description and project path are read-only. You can still change priority.';
      const form = document.getElementById('task-form');
      form.insertBefore(banner, form.firstChild);
    }
  } else if (banner) {
    banner.remove();
  }

  // Show last response if available
  const responseEl = document.getElementById('task-last-response');
  if (responseEl) {
    if (task.last_response) {
      responseEl.value = task.last_response;
      responseEl.parentElement.style.display = '';
    } else {
      responseEl.value = '';
      responseEl.parentElement.style.display = 'none';
    }
  }

  updatePrioritySelectStyle();
  updateProjectPathDatalist();
  _initAttachments(task.id); // edit mode: task already exists
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('task-title').focus();
}

function updatePrioritySelectStyle() {
  const select = document.getElementById('task-priority');
  const val = select.value;
  const colors = {
    high: { border: 'rgba(248,81,73,0.6)', color: 'var(--danger)' },
    medium: { border: 'rgba(210,153,34,0.6)', color: 'var(--warning)' },
    low: { border: 'rgba(139,148,158,0.6)', color: 'var(--text-muted)' },
    hold: { border: 'rgba(130,80,223,0.6)', color: '#8250df' },
  };
  const c = colors[val] || colors.medium;
  select.style.borderColor = c.border;
  select.style.color = c.color;
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('task-form').reset();
  document.getElementById('task-edit-id').value = '';
  _attachCurrentTaskId = null;
  _attachPending = [];
  // BUG-14: restore fields after close
  for (const id of ['task-title', 'task-description', 'task-project-path']) {
    const el = document.getElementById(id);
    if (el) el.readOnly = false;
  }
  const banner = document.getElementById('modal-running-banner');
  if (banner) banner.remove();
}

// --- Attachments ---

let _attachCurrentTaskId = null; // null = new task (create mode)
let _attachPending = []; // files queued before task exists (create mode)

function _initAttachments(taskId) {
  _attachCurrentTaskId = taskId;
  _attachPending = [];

  document.getElementById('attachments-section').style.display = '';

  const fileInput = document.getElementById('attach-file-input');
  fileInput.onchange = (e) => {
    for (const file of e.target.files) _attachHandleFile(file);
    fileInput.value = '';
  };

  const dropZone = document.getElementById('attach-drop-zone');
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
  dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    for (const file of e.dataTransfer.files) _attachHandleFile(file);
  };

  _renderAttachmentList();
}

function _attachGetCurrentAttachments() {
  const taskId = _attachCurrentTaskId;
  if (!taskId) return [];
  const task = tasks.find(t => t.id === taskId);
  try { return JSON.parse(task?.attachments || '[]'); } catch { return []; }
}

async function _attachHandleFile(file) {
  if (!_attachCurrentTaskId) {
    // Create mode: queue locally
    _attachPending.push({ type: 'pending-file', file, id: crypto.randomUUID(), name: file.name });
    _renderAttachmentList();
    return;
  }
  // Edit mode: upload immediately
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/tasks/${_attachCurrentTaskId}/attachments`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) return;
  const data = await res.json();
  // Update local task cache
  const task = tasks.find(t => t.id === _attachCurrentTaskId);
  if (task) task.attachments = data.attachments;
  _renderAttachmentList();
}

async function attachAddUrl() {
  const input = document.getElementById('attach-url-input');
  const url = input.value.trim();
  if (!url) return;
  input.value = '';

  if (!_attachCurrentTaskId) {
    _attachPending.push({ type: 'pending-url', url, id: crypto.randomUUID() });
    _renderAttachmentList();
    return;
  }
  const res = await fetch(`/api/tasks/${_attachCurrentTaskId}/attachments/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return;
  const data = await res.json();
  const task = tasks.find(t => t.id === _attachCurrentTaskId);
  if (task) task.attachments = data.attachments;
  _renderAttachmentList();
}

async function _attachDelete(attachId) {
  if (!_attachCurrentTaskId) {
    _attachPending = _attachPending.filter(a => a.id !== attachId);
    _renderAttachmentList();
    return;
  }
  const res = await fetch(`/api/tasks/${_attachCurrentTaskId}/attachments/${attachId}`, { method: 'DELETE' });
  if (!res.ok) return;
  const data = await res.json();
  const task = tasks.find(t => t.id === _attachCurrentTaskId);
  if (task) task.attachments = data.attachments;
  _renderAttachmentList();
}

function _renderAttachmentList() {
  const list = document.getElementById('attachment-list');
  if (!list) return;

  const saved = _attachGetCurrentAttachments();
  const all = [...saved, ..._attachPending];

  if (all.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = all.map(a => {
    const isPending = a.type?.startsWith('pending-');
    const isImage = a.mime?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name || a.url || '');
    const icon = a.type === 'url' || a.type === 'pending-url'
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>'
      : isImage
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';

    const label = a.type === 'url' ? a.url : (a.name || a.filename);
    const preview = isImage && !isPending && a.filename
      ? `<img class="attach-thumb" src="/uploads/${encodeURIComponent(a.filename)}" alt="">`
      : '';
    const pendingMark = isPending ? '<span class="attach-pending-mark" title="Will upload on save">•</span>' : '';

    return `<div class="attachment-item" data-id="${a.id}">
      ${preview}${icon}<span class="attach-name" title="${escapeAttr(label)}">${escapeHtml(label)}</span>${pendingMark}
      <button type="button" class="attach-delete" onclick="_attachDelete('${a.id}')" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

// Upload all pending attachments after task creation
async function _flushPendingAttachments(taskId) {
  for (const pending of _attachPending) {
    if (pending.type === 'pending-file') {
      const formData = new FormData();
      formData.append('file', pending.file);
      await fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: formData });
    } else if (pending.type === 'pending-url') {
      await fetch(`/api/tasks/${taskId}/attachments/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: pending.url }),
      });
    }
  }
  _attachPending = [];
}

// --- Approve all review tasks ---
async function approveAllReview() {
  const reviewTasks = tasks.filter(t => t.column === 'review');
  if (!reviewTasks.length) return;
  if (!confirm('Переместить все задачи из review в done?')) return;
  await Promise.all(reviewTasks.map(t =>
    fetch(`/api/tasks/${t.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'done' })
    })
  ));
  await loadTasks();
  renderBoard();
}

// --- Return task (from review back to run) ---

// --- Return popup attachments ---
let _returnPending = []; // { type: 'file'|'url', file?, url?, id, name? }

function _returnInitAttachments() {
  _returnPending = [];
  _returnRenderAttachments();

  const fileInput = document.getElementById('return-file-input');
  fileInput.onchange = (e) => {
    for (const file of e.target.files) {
      _returnPending.push({ type: 'file', file, id: crypto.randomUUID(), name: file.name });
    }
    fileInput.value = '';
    _returnRenderAttachments();
  };

  const dropZone = document.getElementById('return-drop-zone');
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
  dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    for (const file of e.dataTransfer.files) {
      _returnPending.push({ type: 'file', file, id: crypto.randomUUID(), name: file.name });
    }
    _returnRenderAttachments();
  };
}

function returnAttachAddUrl() {
  const input = document.getElementById('return-url-input');
  const url = input.value.trim();
  if (!url) return;
  input.value = '';
  _returnPending.push({ type: 'url', url, id: crypto.randomUUID() });
  _returnRenderAttachments();
}

function _returnAttachDelete(id) {
  _returnPending = _returnPending.filter(a => a.id !== id);
  _returnRenderAttachments();
}

function _returnRenderAttachments() {
  const list = document.getElementById('return-attach-list');
  if (!list) return;
  if (_returnPending.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = _returnPending.map(a => {
    const icon = a.type === 'url'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
    const label = a.type === 'url' ? a.url : a.name;
    return `<div class="attachment-item">
      ${icon}<span class="attach-name" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
      <button type="button" class="attach-delete" onclick="_returnAttachDelete('${a.id}')">&times;</button>
    </div>`;
  }).join('');
}

function openReturnModal(taskId, event) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  document.getElementById('return-task-id').value = task.id;
  document.getElementById('return-task-title').textContent = task.title;
  document.getElementById('return-prompt').value = '';

  const prevPromptEl = document.getElementById('return-prev-prompt');
  if (task.description) {
    prevPromptEl.textContent = task.description;
    prevPromptEl.parentElement.style.display = '';
  } else {
    prevPromptEl.textContent = '';
    prevPromptEl.parentElement.style.display = 'none';
  }

  const respEl = document.getElementById('return-prev-response');
  if (task.last_response) {
    respEl.textContent = task.last_response;
    respEl.parentElement.style.display = '';
  } else {
    respEl.textContent = '';
    respEl.parentElement.style.display = 'none';
  }

  _returnInitAttachments();

  const popup = document.getElementById('return-popup');
  popup.classList.remove('hidden');

  // Position near the button that was clicked
  if (event) {
    const btn = event.target.closest('.btn-return') || event.target;
    const rect = btn.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.left;

    // Keep within viewport
    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (top + popupRect.height > window.innerHeight - 10) {
        top = rect.top - popupRect.height - 6;
      }
      if (left + popupRect.width > window.innerWidth - 10) {
        left = window.innerWidth - popupRect.width - 10;
      }
      popup.style.top = Math.max(10, top) + 'px';
      popup.style.left = Math.max(10, left) + 'px';
    });
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
  }

  document.getElementById('return-prompt').focus();

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('mousedown', _returnPopupOutsideClick);
  }, 0);
}

function _returnPopupOutsideClick(e) {
  const popup = document.getElementById('return-popup');
  if (popup && !popup.contains(e.target)) {
    closeReturnModal();
  }
}

function closeReturnModal() {
  document.getElementById('return-popup').classList.add('hidden');
  document.removeEventListener('mousedown', _returnPopupOutsideClick);
  _returnPending = [];
  _returnSubmitting = false; // BUG-22: reset on close
  const submitBtn = document.querySelector('#return-popup .btn-primary');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '↩ Re-run'; }
}

let _returnSubmitting = false; // BUG-22: prevent double-submit
async function submitReturn() {
  if (_returnSubmitting) return; // BUG-22: guard against double-submit
  const taskId = parseInt(document.getElementById('return-task-id').value);
  const newPrompt = document.getElementById('return-prompt').value.trim();
  // BUG-21: show validation error if prompt is empty
  if (!newPrompt) {
    const promptEl = document.getElementById('return-prompt');
    promptEl.style.borderColor = 'var(--danger)';
    promptEl.placeholder = 'Prompt is required!';
    promptEl.focus();
    setTimeout(() => {
      promptEl.style.borderColor = '';
      promptEl.placeholder = 'Updated instructions for Claude...';
    }, 2000);
    return;
  }
  if (!taskId) return;
  _returnSubmitting = true;
  const submitBtn = document.querySelector('#return-popup .btn-primary');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }

  // Upload pending files
  const extraFiles = [];
  for (const a of _returnPending) {
    if (a.type === 'file') {
      const formData = new FormData();
      formData.append('file', a.file);
      const res = await fetch(`/api/tasks/${taskId}/return-upload`, { method: 'POST', body: formData });
      if (res.ok) {
        const data = await res.json();
        extraFiles.push({ path: data.path, name: data.name });
      }
    }
  }
  const extraUrls = _returnPending.filter(a => a.type === 'url').map(a => a.url);

  closeReturnModal();
  _returnSubmitting = false; // BUG-22: reset submitting flag after modal closed

  try {
    // BUG-02: pass clientId so server sends task:run only to this tab
    await fetch(`/api/tasks/${taskId}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: newPrompt, extraFiles, extraUrls, clientId: CLIENT_ID }),
    });
  } finally {
    _returnSubmitting = false;
  }
}

// --- Auto-approve ---

async function toggleAutoApprove() {
  const res = await fetch('/api/auto-approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !autoApproveEnabled }),
  });
  const data = await res.json();
  autoApproveEnabled = data.enabled;
  updateAutoApproveBtn();
}

function updateAutoApproveBtn() {
  const btn = document.getElementById('auto-approve-btn');
  if (btn) {
    btn.textContent = `Auto-approve: ${autoApproveEnabled ? 'ON' : 'OFF'}`;
    btn.classList.toggle('active', autoApproveEnabled);
  }
}

async function fetchAutoApprove() {
  // Reset to OFF on page load/refresh — never restore previous state
  try {
    const res = await fetch('/api/auto-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const data = await res.json();
    autoApproveEnabled = data.enabled;
    updateAutoApproveBtn();
  } catch {}
}

async function fetchMaxTerminals() {
  try {
    const res = await fetch('/api/max-terminals');
    const data = await res.json();
    maxTerminals = data.maxTerminals;
    localStorage.setItem('maxTerminals', maxTerminals);
    updateMaxTerminalsUI();
  } catch {}
}

// Reset auto-queue to OFF on page load/refresh instead of restoring server state
async function fetchAutoQueue() {
  try {
    const res = await fetch('/api/auto-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const data = await res.json();
    autoQueueEnabled = data.enabled;
    updateStartBtn();
  } catch {}
}

// --- Logs ---

var logEntries = [];
const MAX_LOG_ENTRIES = 500;

function addLog(text, category = '') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logEntries.push({ time, text, category });
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries = logEntries.slice(-MAX_LOG_ENTRIES);

  // If popup is open, append live
  const container = document.getElementById('logs-content');
  if (container && !document.getElementById('logs-overlay').classList.contains('hidden')) {
    container.appendChild(createLogLine({ time, text, category }));
    container.scrollTop = container.scrollHeight;
  }

  // Update badge
  const btn = document.getElementById('logs-btn');
  if (btn && document.getElementById('logs-overlay').classList.contains('hidden')) {
    const badge = btn.querySelector('.log-badge') || (() => {
      const b = document.createElement('span');
      b.className = 'log-badge';
      b.style.cssText = 'background:var(--border);color:var(--text-muted);border-radius:8px;padding:0 5px;margin-left:4px;font-size:10px;';
      btn.appendChild(b);
      return b;
    })();
    badge.textContent = logEntries.length;
  }
}

function createLogLine(entry) {
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-time">${entry.time}</span><span class="log-${entry.category || 'info'}">${escapeHtml(entry.text)}</span>`;
  return div;
}


function toggleLogsPopup() {
  const overlay = document.getElementById('logs-overlay');
  overlay.classList.toggle('hidden');
  if (!overlay.classList.contains('hidden')) {
    // Render all logs
    const container = document.getElementById('logs-content');
    container.innerHTML = '';
    for (const entry of logEntries) {
      container.appendChild(createLogLine(entry));
    }
    container.scrollTop = container.scrollHeight;
    // Clear badge
    const badge = document.getElementById('logs-btn')?.querySelector('.log-badge');
    if (badge) badge.remove();
  }
}

function clearLogs() {
  logEntries = [];
  const container = document.getElementById('logs-content');
  if (container) container.innerHTML = '';
}

// --- All tasks completed detection ---

let allCompletedShown = false;

function checkAllTasksCompleted() {
  if (allCompletedShown) return;
  if (tasks.length === 0) return;

  const backlogCount = tasks.filter(t => t.column === 'backlog').length;
  const inProgressCount = tasks.filter(t => t.column === 'in_progress').length;

  if (backlogCount === 0 && inProgressCount === 0) {
    allCompletedShown = true;
    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Disable auto-approve
    if (autoApproveEnabled) {
      toggleAutoApprove();
    }
    // Disable auto-queue (BUG-05: use server-side toggle)
    if (autoQueueEnabled) {
      fetch('/api/auto-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }).then(r => r.json()).then(data => {
        autoQueueEnabled = data.enabled;
        updateStartBtn();
      });
    }

    showAllCompletedPopup(dateStr, timeStr);
  }
}

function showAllCompletedPopup(dateStr, timeStr) {
  // Remove if already exists
  const existing = document.getElementById('all-completed-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'all-completed-overlay';
  overlay.innerHTML = `
    <div class="all-completed-content">
      <div class="all-completed-icon">✓</div>
      <div class="all-completed-title">All tasks completed!</div>
      <div class="all-completed-time">${dateStr} ${timeStr}</div>
      <div class="all-completed-info">Auto-approve and auto-queue have been stopped.</div>
      <button class="btn btn-primary" onclick="closeAllCompletedPopup()">OK</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeAllCompletedPopup() {
  const overlay = document.getElementById('all-completed-overlay');
  if (overlay) overlay.remove();
}

// Reset when new tasks are added to backlog
function resetAllCompletedFlag() {
  allCompletedShown = false;
}

// --- Auto-queue ---

async function toggleAutoQueue() {
  // BUG-05: sync auto-queue state server-side (like auto-approve)
  const res = await fetch('/api/auto-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !autoQueueEnabled }),
  });
  const data = await res.json();
  autoQueueEnabled = data.enabled;
  updateStartBtn();
  if (autoQueueEnabled) {
    tryAutoQueue();
  }
}

async function toggleStart() {
  if (autoQueueEnabled) {
    // Stop: disable auto-queue server-side
    const res = await fetch('/api/auto-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const data = await res.json();
    autoQueueEnabled = data.enabled;
    updateStartBtn();
  } else {
    // BUG-23: hint if auto-approve is off
    if (!autoApproveEnabled) {
      addLog('[Hint] Auto-approve is OFF — Claude prompts will pause execution. Enable Auto-approve for uninterrupted queue.', 'info');
    }
    // Start: enable auto-queue server-side and run all backlog tasks
    const res = await fetch('/api/auto-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const data = await res.json();
    autoQueueEnabled = data.enabled;
    updateStartBtn();
    // Start first task per project immediately
    const backlog = tasks
      .filter(t => t.column === 'backlog' && t.priority !== 'hold')
      .sort((a, b) => {
        const pa = { high: 0, medium: 1, low: 2, hold: 3 }[a.priority] ?? 1;
        const pb = { high: 0, medium: 1, low: 2, hold: 3 }[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return a.position - b.position;
      });

    const startedProjects = new Set();
    for (const task of backlog) {
      const proj = task.project_path || '';
      if (startedProjects.has(proj)) continue;
      startedProjects.add(proj);
      setTimeout(() => runTask(task.id), 500 * startedProjects.size);
    }
  }
}

function updateStartBtn() {
  const btn = document.getElementById('start-btn');
  if (btn) {
    if (autoQueueEnabled) {
      btn.innerHTML = '&#9632; Stop queue';
      btn.classList.add('active');
    } else {
      btn.innerHTML = '&#9654; Start queue';
      btn.classList.remove('active');
    }
  }
}

function isAnyRateLimitActive() {
  for (const id in sessionStatuses) {
    if (sessionStatuses[id]?.status === 'waiting_reset') return true;
  }
  return false;
}

function setMaxTerminals(n) {
  maxTerminals = Math.max(0, n);
  localStorage.setItem('maxTerminals', maxTerminals);
  updateMaxTerminalsUI();
  addLog(`[MaxTerminals] Set to ${maxTerminals === 0 ? 'unlimited' : maxTerminals}`, 'idle');
  fetch('/api/max-terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: maxTerminals }),
  }).catch(() => {});
}

function updateMaxTerminalsUI() {
  const display = document.getElementById('max-terminals-display');
  if (display) display.textContent = maxTerminals === 0 ? '∞' : maxTerminals;
}

let _autoQueueTimer = null;
function tryAutoQueue() {
  if (_autoQueueTimer) return; // debounce: absorb rapid back-to-back calls
  _autoQueueTimer = setTimeout(() => { _autoQueueTimer = null; _doAutoQueue(); }, 150);
}
function _doAutoQueue() {
  if (!autoQueueEnabled) {
    addLog('[AutoQueue] Skipped — queue not enabled', 'idle');
    return;
  }

  // BUG-08: Collect busy projects — include ALL in_progress tasks regardless of
  // sessionStatuses (which may be empty after page reload)
  const busyProjects = new Set();
  for (const t of tasks) {
    if (t.column === 'in_progress') {
      busyProjects.add(t.project_path || '');
    }
  }

  // Get backlog sorted by priority then position (skip hold tasks)
  const backlog = tasks
    .filter(t => t.column === 'backlog' && t.priority !== 'hold')
    .sort((a, b) => {
      const pa = { high: 0, medium: 1, low: 2 }[a.priority] ?? 1;
      const pb = { high: 0, medium: 1, low: 2 }[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.position - b.position;
    });

  addLog(`[AutoQueue] backlog=${backlog.length}, busy=${[...busyProjects].join(',')||'none'}`, 'idle');

  // For each free project, start first available task
  const started = new Set();
  for (const task of backlog) {
    const proj = task.project_path || '';
    if (busyProjects.has(proj) || started.has(proj)) continue;
    // Respect maxTerminals limit (0 = unlimited)
    if (maxTerminals > 0 && (busyProjects.size + started.size) >= maxTerminals) break;
    started.add(proj);
    addLog(`[AutoQueue] Starting task #${task.id} "${task.title}" for ${proj || 'HOME'}`, 'client');
    console.log(`[AutoQueue] Starting task #${task.id} for project ${proj}`);
    setTimeout(() => runTask(task.id), 500 * started.size);
  }
}

// --- Resizer ---

function initResizer() {
  const resizer = document.getElementById('resizer');
  const kanban = document.getElementById('kanban');
  const terminal = document.getElementById('terminal-panel');

  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('active');
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const containerRect = document.querySelector('main').getBoundingClientRect();
    const offset = e.clientX - containerRect.left;
    const totalWidth = containerRect.width;
    const resizerWidth = 5;

    const kanbanWidth = Math.max(300, Math.min(offset, totalWidth - 200 - resizerWidth));
    const terminalWidth = totalWidth - kanbanWidth - resizerWidth;

    const pct = offset / totalWidth;
    kanban.style.flex = 'none';
    kanban.style.width = kanbanWidth + 'px';
    terminal.style.flex = 'none';
    terminal.style.width = terminalWidth + 'px';

    if (window.terminalManager) {
      window.terminalManager.fitAll();
    }
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('active');
    document.body.classList.remove('resizing');

    // Save ratio to localStorage
    const totalWidth = document.querySelector('main').getBoundingClientRect().width;
    const kw = kanban.getBoundingClientRect().width;
    localStorage.setItem('kanban:vSplit', (kw / totalWidth).toFixed(4));

    if (window.terminalManager) {
      window.terminalManager.fitAll();
    }
  });

  function applySplit() {
    const saved = localStorage.getItem('kanban:vSplit');
    const ratio = saved ? parseFloat(saved) : 0.5;
    const totalWidth = document.querySelector('main').getBoundingClientRect().width;
    const resizerWidth = 5;
    const kanbanWidth = Math.max(300, Math.min(ratio * totalWidth, totalWidth - 200 - resizerWidth));
    const terminalWidth = totalWidth - kanbanWidth - resizerWidth;
    kanban.style.flex = 'none';
    kanban.style.width = kanbanWidth + 'px';
    terminal.style.flex = 'none';
    terminal.style.width = terminalWidth + 'px';
    if (window.terminalManager) window.terminalManager.fitAll();
  }

  // Apply on init
  requestAnimationFrame(applySplit);

  // Reapply on window resize
  window.addEventListener('resize', applySplit);
}


// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  fetchTasks();
  fetchAutoApprove();
  fetchAutoQueue(); // BUG-05: sync auto-queue state on page load
  fetchMaxTerminals();
  connectWS();
  initSortable();
  initModal();
  initResizer();
  restoreCollapsed();

  // Restore Kanban Lead panel state
  const klSaved = localStorage.getItem('klPanelOpen');
  if (klSaved === 'false') {
    const body = document.getElementById('kl-body');
    const btn = document.getElementById('kl-toggle');
    if (body) body.classList.add('hidden');
    if (btn) btn.textContent = '▼';
  }

  // Check skill status
  fetch('/api/skill-status')
    .then(r => r.json())
    .then(data => {
      const hint = document.getElementById('kl-skill-hint');
      if (hint) {
        hint.textContent = data.installed ? 'skill installed' : 'skill not found — restart the server';
        hint.style.color = data.installed ? '' : 'var(--danger)';
      }
    })
    .catch(() => {});
});

function toggleKanbanLeadPanel() {
  const body = document.getElementById('kl-body');
  const btn = document.getElementById('kl-toggle');
  const isOpen = !body.classList.contains('hidden');
  if (isOpen) {
    body.classList.add('hidden');
    btn.textContent = '▼';
    localStorage.setItem('klPanelOpen', 'false');
  } else {
    body.classList.remove('hidden');
    btn.textContent = '▲';
    localStorage.setItem('klPanelOpen', 'true');
  }
}

function submitKanbanLead() {
  const project = (document.getElementById('kl-project').value || '').trim();
  const prompt = (document.getElementById('kl-prompt').value || '').trim();
  const btn = document.getElementById('kl-submit');

  if (!prompt) {
    document.getElementById('kl-prompt').focus();
    return;
  }

  // Format the command for Claude Code
  let cmd;
  if (project) {
    cmd = '/kanban-lead for project ' + project + ': ' + prompt;
  } else {
    cmd = '/kanban-lead ' + prompt;
  }

  // Send to helper terminal via WebSocket (terminal:input)
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addLog('[KanbanLead] WebSocket not connected', 'error');
    return;
  }
  ws.send(JSON.stringify({ type: 'terminal:input', termId: 'helper', data: cmd + '\r' }));

  // Feedback
  btn.textContent = 'Sending...';
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = 'Help me plan tasks';
    btn.disabled = false;
  }, 3000);

  // Clear prompt (keep project for next use)
  document.getElementById('kl-prompt').value = '';
  addLog('[KanbanLead] Sent command to helper terminal for project: ' + (project || 'unspecified'), 'client');
}
