// Terminal manager — helper (Claude Code) + multi-project task terminals with tabs

const XTERM_DARK_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88, 166, 255, 0.3)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39d353',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d364',
  brightWhite: '#f0f6fc',
};

const XTERM_LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(9, 105, 218, 0.2)',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

const XTERM_SOLARIZED_LIGHT_THEME = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#268bd2',
  cursorAccent: '#fdf6e3',
  selectionBackground: 'rgba(38, 139, 210, 0.2)',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#859900',
  brightYellow: '#b58900',
  brightBlue: '#268bd2',
  brightMagenta: '#6c71c4',
  brightCyan: '#2aa198',
  brightWhite: '#fdf6e3',
};

function getXtermTheme() {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'light') return XTERM_LIGHT_THEME;
  if (theme === 'solarized-light') return XTERM_SOLARIZED_LIGHT_THEME;
  return XTERM_DARK_THEME;
}

const XTERM_OPTS = {
  theme: getXtermTheme(),
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: true,
};

function makeTerminal(container) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  const term = new Terminal({ ...XTERM_OPTS, theme: getXtermTheme() });
  const fit = new FitAddon.FitAddon();

  term.loadAddon(fit);

  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
  try {
    const u = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(u);
    term.unicode.activeVersion = '11';
  } catch {}

  term.open(el);

  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {}

  requestAnimationFrame(() => requestAnimationFrame(() => fit.fit()));

  // Auto-scroll: track if user scrolled up, auto-scroll to bottom on new data if not
  let userScrolledUp = false;
  term.onScroll(() => {
    const buf = term.buffer.active;
    userScrolledUp = buf.viewportY < buf.baseY;
  });
  term.onWriteParsed(() => {
    if (!userScrolledUp) {
      term.scrollToBottom();
    }
  });

  return { term, fit, el };
}

function escapeHtmlTerm(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

class TerminalManager {
  constructor() {
    this.helper = null;
    this._fitTimer = null;

    // Project terminals: projectPath -> { term, fit, el, termId, tabEl, queue, currentTaskId, running, spawning }
    this.projects = new Map();
    this.activeProject = null;
    this._manualCounter = 0;
  }

  init() {
    this.helper = makeTerminal('helper-container');
    this.helper.term.onData(d => this._ws('terminal:input', { termId: 'helper', data: d }));

    // Resize
    const doFit = () => {
      clearTimeout(this._fitTimer);
      this._fitTimer = setTimeout(() => this.fitAll(), 60);
    };
    window.addEventListener('resize', doFit);
    new ResizeObserver(doFit).observe(this.helper.el);

    const taskArea = document.getElementById('task-terminals');
    if (taskArea) new ResizeObserver(doFit).observe(taskArea);

    this._initHResizer();

    // Attach to current WS (connectWS will call _attachWS on open)
    this._attachWS();
  }

  // (Re-)attach message listener to the current global ws and request terminal list.
  // Called on every WS (re)connect from connectWS().
  _attachWS() {
    if (!ws) return;

    // Remove previous listener from previous ws object if any
    if (this._wsListener && this._wsPrev) {
      this._wsPrev.removeEventListener('message', this._wsListener);
    }
    this._wsPrev = ws;

    this._wsListener = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'terminal:output') {
        if (msg.termId === 'helper') {
          this.helper.term.write(msg.data);
        } else {
          for (const [, proj] of this.projects) {
            if (proj.termId === msg.termId) {
              proj.term.write(msg.data);
              break;
            }
          }
        }
      } else if (msg.type === 'terminal:exit') {
        console.log('[Terminal] exit event:', msg.termId, 'exitCode:', msg.exitCode);
        this._handleExit(msg);
      } else if (msg.type === 'terminal:list') {
        this._restoreFromServer(msg.terminals);
      }
    };

    ws.addEventListener('message', this._wsListener);

    // Request existing terminals for reconnection (or spawn fresh helper if none)
    setTimeout(() => {
      this.fitAll();
      this._ws('terminal:list', {});
    }, 300);
  }

  _ws(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  }

  _getTabTitle(projectPath) {
    if (!projectPath) return 'default';
    const parts = projectPath.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || 'default';
  }

  _getTermId(projectPath) {
    return 'project:' + (projectPath || 'default');
  }

  _getOrCreateProjectTerminal(projectPath) {
    if (this.projects.has(projectPath)) {
      return this.projects.get(projectPath);
    }

    const termId = this._getTermId(projectPath);
    const tabTitle = this._getTabTitle(projectPath);

    // Create tab
    const tabBar = document.getElementById('task-tab-bar');
    const tab = document.createElement('div');
    tab.className = 'task-tab';
    tab.dataset.project = projectPath;
    tab.innerHTML = `<span class="tab-title">${escapeHtmlTerm(tabTitle)}</span><span class="tab-close" title="Close">&times;</span>`;
    tab.querySelector('.tab-title').addEventListener('click', () => this._switchToProject(projectPath));
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeProjectTerminal(projectPath);
    });
    tabBar.appendChild(tab);

    // Create terminal container
    const area = document.getElementById('task-terminals');
    const container = document.createElement('div');
    container.className = 'term-container project-term-container';
    container.style.display = 'none';
    area.appendChild(container);

    // Create xterm
    const { term, fit } = makeTerminal(container);
    term.onData(d => this._ws('terminal:input', { termId, data: d }));

    const proj = {
      term, fit, el: container, termId, tabEl: tab,
      queue: [], currentTaskId: null, running: false, spawning: false, sessionAlive: false,
    };
    this.projects.set(projectPath, proj);

    this._switchToProject(projectPath);

    return proj;
  }

  _switchToProject(projectPath) {
    for (const [path, proj] of this.projects) {
      const isActive = path === projectPath;
      proj.el.style.display = isActive ? '' : 'none';
      proj.tabEl.classList.toggle('active', isActive);
    }
    this.activeProject = projectPath;

    const proj = this.projects.get(projectPath);
    if (proj) {
      requestAnimationFrame(() => {
        proj.fit.fit();
        this._ws('terminal:resize', { termId: proj.termId, cols: proj.term.cols, rows: proj.term.rows });
      });
    }
  }

  _restoreFromServer(terminals) {
    let helperFound = false;
    const serverTermIds = new Set();

    for (const t of terminals) {
      if (t.termId === 'helper') {
        helperFound = true;
        serverTermIds.add('helper');
        this._ws('terminal:reattach', { termId: 'helper' });
        continue;
      }

      // Only restore project terminals (skip manual terminals)
      if (!t.termId.startsWith('project:')) continue;

      const projectPath = t.cwd || '';
      if (!projectPath) continue;

      serverTermIds.add(t.termId);

      // Create tab + xterm widget and reattach to existing PTY
      const proj = this._getOrCreateProjectTerminal(projectPath);
      proj.currentTaskId = t.currentTaskId;
      proj.running = !!t.running;
      proj.sessionAlive = true;

      if (t.running) proj.tabEl.classList.add('running');

      // Reattach — server will replay buffered output
      this._ws('terminal:reattach', { termId: proj.termId });
    }

    // Reset sessionAlive for project terminals not found on server (e.g. after server restart)
    for (const [, proj] of this.projects) {
      if (!serverTermIds.has(proj.termId)) {
        proj.sessionAlive = false;
      }
    }

    if (!helperFound) {
      // No existing helper on server, spawn fresh
      this._ws('terminal:spawn', {
        termId: 'helper',
        command: 'claude',
        cols: this.helper.term.cols,
        rows: this.helper.term.rows,
      });
    }
  }

  _closeProjectTerminal(projectPath) {
    const proj = this.projects.get(projectPath);
    if (!proj) return;

    this._ws('terminal:kill', { termId: proj.termId });
    proj.term.dispose();
    proj.el.remove();
    proj.tabEl.remove();
    this.projects.delete(projectPath);

    if (this.activeProject === projectPath) {
      const remaining = [...this.projects.keys()];
      if (remaining.length > 0) {
        this._switchToProject(remaining[remaining.length - 1]);
      } else {
        this.activeProject = null;
      }
    }
  }

  runInTaskTerminal(taskId, command, cwd, prompt) {
    const projectPath = cwd || '';
    const proj = this._getOrCreateProjectTerminal(projectPath);
    if (!proj) {
      // Terminal limit reached — _getOrCreateProjectTerminal already logged the error
      console.warn(`[Terminal] Skipping task #${taskId} — terminal limit reached`);
      return;
    }
    const logMsg = `[Terminal] runTask #${taskId}: running=${proj.running}, sessionAlive=${proj.sessionAlive}, queue=${proj.queue.length}`;
    console.log(logMsg);
    if (typeof addLog === 'function') addLog(logMsg, 'client');

    if (proj.running) {
      // Queue — same project, sequential execution
      proj.queue.push({ taskId, command, cwd, prompt });
      const task = tasks.find(t => t.id === taskId);
      const label = task ? task.title : `#${taskId}`;
      proj.term.write(`\r\n\x1b[90m── Queued: ${label} ──\x1b[0m\r\n`);
      // Update tab badge
      this._updateTabBadge(proj);
      return;
    }

    // If this project already has a live session (PTY alive, just idle), continue in it
    if (proj.sessionAlive && prompt) {
      const task = tasks.find(t => t.id === taskId);
      const label = task ? task.title : `#${taskId}`;
      proj.term.write(`\r\n\x1b[90m── Running next: ${label} ──\x1b[0m\r\n`);
      this._continueInProject(projectPath, proj, taskId, prompt, cwd);
      return;
    }

    this._runInProject(projectPath, proj, taskId, cwd, prompt, command);
  }

  _runInProject(projectPath, proj, taskId, cwd, prompt, command) {
    if (typeof addLog === 'function') addLog(`[Terminal] spawn new session #${taskId} in ${projectPath}`, 'pty');
    proj.currentTaskId = taskId;
    proj.running = true;
    proj.spawning = true;
    proj.sessionAlive = true;
    proj.term.clear();

    proj.tabEl.classList.add('running');
    this._updateTabBadge(proj);

    // Switch to this tab
    this._switchToProject(projectPath);

    // Kill old PTY, spawn claude in interactive mode (no prompt arg — stays alive between tasks)
    this._ws('terminal:kill', { termId: proj.termId });

    setTimeout(() => {
      proj.fit.fit();
      this._ws('terminal:spawn', {
        termId: proj.termId,
        taskId,
        command: command || 'claude',  // interactive mode — won't exit after task
        cwd,
        autoApprove: true,
        cols: proj.term.cols,
        rows: proj.term.rows,
        prompt,  // server will detect ❯ and type this automatically
      });
      proj.spawning = false;
    }, 500);
  }

  _updateTabBadge(proj) {
    let badge = proj.tabEl.querySelector('.tab-badge');
    if (proj.queue.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tab-badge';
        proj.tabEl.insertBefore(badge, proj.tabEl.querySelector('.tab-close'));
      }
      badge.textContent = proj.queue.length;
    } else if (badge) {
      badge.remove();
    }
  }

  stopTaskInProject(taskId, projectPath) {
    // Find the project terminal running this task
    const proj = this.projects.get(projectPath);
    if (!proj) return;

    // BUG-19: always filter proj.queue to remove stopped task (whether running or queued)
    const wasQueued = proj.queue.some(q => q.taskId === taskId);
    proj.queue = proj.queue.filter(q => q.taskId !== taskId);
    if (wasQueued) {
      this._updateTabBadge(proj);
    }

    if (proj.currentTaskId === taskId) {
      // Kill the PTY
      this._ws('terminal:kill', { termId: proj.termId });
      proj.running = false;
      proj.sessionAlive = false;
      proj.currentTaskId = null;
      proj.tabEl.classList.remove('running');
      this._updateTabBadge(proj);
      proj.term.write('\r\n\x1b[90m── Stopped ──\x1b[0m\r\n');

      // Respawn idle shell
      setTimeout(() => {
        if (proj.spawning || proj.running) return;
        proj.fit.fit();
        this._ws('terminal:spawn', {
          termId: proj.termId,
          cwd: projectPath,
          cols: proj.term.cols,
          rows: proj.term.rows,
        });
      }, 500);
    }
  }

  _handleExit(msg) {
    if (msg.termId === 'helper') {
      this.helper.term.write('\r\n\x1b[90m── Claude exited. Restarting... ──\x1b[0m\r\n');
      setTimeout(() => {
        this.helper.fit.fit();
        this._ws('terminal:spawn', {
          termId: 'helper',
          command: 'claude',
          cols: this.helper.term.cols,
          rows: this.helper.term.rows,
        });
      }, 2000);
      return;
    }

    // Find project terminal by termId
    for (const [projectPath, proj] of this.projects) {
      if (proj.termId !== msg.termId) continue;

      // Don't handle exit during spawn
      if (proj.spawning) {
        console.log('[Terminal] ignoring exit — spawning in progress for', msg.termId);
        return;
      }

      const completedTaskId = proj.currentTaskId;
      proj.running = false;
      proj.sessionAlive = false;
      proj.tabEl.classList.remove('running');
      proj.currentTaskId = null;

      // Auto-move completed task to Review (send termId so server can capture last response)
      if (completedTaskId) {
        console.log('[Terminal] completing task', completedTaskId, 'with termId', proj.termId);
        fetch(`/api/tasks/${completedTaskId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ termId: proj.termId }),
        });
      }

      if (proj.queue.length > 0) {
        // Run next queued task
        const next = proj.queue.shift();
        this._updateTabBadge(proj);
        const task = tasks.find(t => t.id === next.taskId);
        const label = task ? task.title : `#${next.taskId}`;
        proj.term.write(`\r\n\x1b[90m── Running next: ${label} ──\x1b[0m\r\n`);
        setTimeout(() => this._runInProject(projectPath, proj, next.taskId, next.cwd, next.prompt, next.command), 1000);
      } else {
        proj.term.write('\r\n\x1b[90m── Session ended ──\x1b[0m\r\n');
        this._updateTabBadge(proj);
      }
      break;
    }
  }

  // Called when server completes a task via idle detection (session:completed)
  onTaskCompleted(taskId) {
    if (typeof addLog === 'function') addLog(`[Terminal] onTaskCompleted #${taskId}`, 'idle');
    for (const [projectPath, proj] of this.projects) {
      if (proj.currentTaskId !== taskId) continue;

      proj.tabEl.classList.remove('running');
      proj.currentTaskId = null;

      // Process internal queue (tasks queued while another was running)
      if (proj.queue.length > 0) {
        const next = proj.queue.shift();
        this._updateTabBadge(proj);
        const task = tasks.find(t => t.id === next.taskId);
        const label = task ? task.title : `#${next.taskId}`;
        proj.term.write(`\r\n\x1b[90m── Running next: ${label} ──\x1b[0m\r\n`);
        setTimeout(() => this._continueInProject(projectPath, proj, next.taskId, next.prompt, next.cwd), 500);
        return;
      }

      // No queue — mark idle, let tryAutoQueue() handle the rest
      // sessionAlive stays true so next runInTaskTerminal uses _continueInProject
      proj.running = false;
      this._updateTabBadge(proj);
      break;
    }
  }

  // Find next backlog task for a given project path
  _findNextBacklogTask(projectPath) {
    const normalizedPath = projectPath || '';
    const backlog = tasks
      .filter(t => t.column === 'backlog' && t.priority !== 'hold' && (t.project_path || '') === normalizedPath)
      .sort((a, b) => {
        const pa = { high: 0, medium: 1, low: 2, hold: 3 }[a.priority] ?? 1;
        const pb = { high: 0, medium: 1, low: 2, hold: 3 }[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return a.position - b.position;
      });
    return backlog[0] || null;
  }

  // Continue existing Claude Code session with a new prompt (no kill/respawn)
  _continueInProject(projectPath, proj, taskId, prompt, cwd) {
    if (typeof addLog === 'function') addLog(`[Terminal] continue #${taskId} in ${projectPath}`, 'pty');
    proj.currentTaskId = taskId;
    proj.running = true;
    proj.tabEl.classList.add('running');
    this._updateTabBadge(proj);
    this._switchToProject(projectPath);

    // Tell server to update task tracking and type the prompt
    this._ws('terminal:continue', {
      termId: proj.termId,
      taskId,
      prompt,
    });
  }

  addManualTerminal() {
    this._manualCounter++;
    const key = `__manual__${this._manualCounter}`;
    const termId = `manual:${this._manualCounter}`;
    const tabTitle = `Terminal ${this._manualCounter}`;

    // Create tab
    const tabBar = document.getElementById('task-tab-bar');
    const tab = document.createElement('div');
    tab.className = 'task-tab';
    tab.dataset.project = key;
    tab.innerHTML = `<span class="tab-title">${escapeHtmlTerm(tabTitle)}</span><span class="tab-close" title="Close">&times;</span>`;
    tab.querySelector('.tab-title').addEventListener('click', () => this._switchToProject(key));
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeProjectTerminal(key);
    });
    tabBar.appendChild(tab);

    // Create terminal container
    const area = document.getElementById('task-terminals');
    const container = document.createElement('div');
    container.className = 'term-container project-term-container';
    container.style.display = 'none';
    area.appendChild(container);

    // Create xterm
    const { term, fit } = makeTerminal(container);
    term.onData(d => this._ws('terminal:input', { termId, data: d }));

    const proj = {
      term, fit, el: container, termId, tabEl: tab,
      queue: [], currentTaskId: null, running: false, spawning: false, sessionAlive: false,
    };
    this.projects.set(key, proj);

    this._switchToProject(key);

    // Spawn shell
    setTimeout(() => {
      proj.fit.fit();
      this._ws('terminal:spawn', {
        termId,
        cols: proj.term.cols,
        rows: proj.term.rows,
      });
    }, 300);
  }

  fitAll() {
    if (this.helper) {
      this.helper.fit.fit();
      this._ws('terminal:resize', { termId: 'helper', cols: this.helper.term.cols, rows: this.helper.term.rows });
    }
    // Only fit the active project terminal
    if (this.activeProject !== null) {
      const proj = this.projects.get(this.activeProject);
      if (proj) {
        proj.fit.fit();
        this._ws('terminal:resize', { termId: proj.termId, cols: proj.term.cols, rows: proj.term.rows });
      }
    }
  }

  _initHResizer() {
    const resizer = document.getElementById('h-resizer');
    const top = document.getElementById('helper-section');
    const bottom = document.getElementById('task-section');
    let active = false;

    resizer.addEventListener('mousedown', e => {
      active = true;
      resizer.classList.add('active');
      document.body.classList.add('h-resizing');
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!active) return;
      const panel = document.getElementById('terminal-panel');
      const r = panel.getBoundingClientRect();
      const y = e.clientY - r.top;
      const topH = Math.max(100, Math.min(y, r.height - 105));
      top.style.flex = 'none';
      top.style.height = topH + 'px';
      bottom.style.flex = 'none';
      bottom.style.height = (r.height - topH - 5) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      resizer.classList.remove('active');
      document.body.classList.remove('h-resizing');

      // Save ratio to localStorage
      const panel = document.getElementById('terminal-panel');
      const r = panel.getBoundingClientRect();
      const topH = top.getBoundingClientRect().height;
      localStorage.setItem('kanban:hSplit', (topH / r.height).toFixed(4));

      this.fitAll();
    });

    const applyHSplit = () => {
      const saved = localStorage.getItem('kanban:hSplit');
      const ratio = saved ? parseFloat(saved) : 0.5;
      const panel = document.getElementById('terminal-panel');
      const r = panel.getBoundingClientRect();
      const topH = Math.max(100, Math.min(ratio * r.height, r.height - 105));
      top.style.flex = 'none';
      top.style.height = topH + 'px';
      bottom.style.flex = 'none';
      bottom.style.height = (r.height - topH - 5) + 'px';
      this.fitAll();
    };

    // Apply on init
    requestAnimationFrame(applyHSplit);

    // Reapply on window resize
    window.addEventListener('resize', applyHSplit);
  }
}

// Update all xterm themes (called on theme toggle)
function updateAllTerminalThemes() {
  const tm = window.terminalManager;
  if (!tm) return;
  const theme = getXtermTheme();
  if (tm.helper) tm.helper.term.options.theme = theme;
  for (const [, proj] of tm.projects) {
    proj.term.options.theme = theme;
  }
}

// Wait for WS, then init
document.addEventListener('DOMContentLoaded', () => {
  const t = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      clearInterval(t);
      window.terminalManager = new TerminalManager();
      window.terminalManager.init();
    }
  }, 100);
});
