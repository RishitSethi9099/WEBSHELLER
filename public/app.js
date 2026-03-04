/**
 * Sheller — Cloud Terminal Platform
 * Frontend: Local auth (SQLite) + OS picker + xterm.js + WebSocket + Vainko tab
 */

// ─── State ────────────────────────────────────────────────────────────────────

const SESSION_KEY = 'sheller_session_id';
const OS_KEY      = 'sheller_session_os';
const TOKEN_KEY   = 'sheller_token';
const USER_KEY    = 'sheller_user';

let sessionId     = null;
let currentOS     = null;
let ws            = null;
let term          = null;
let fitAddon      = null;
let authToken     = localStorage.getItem(TOKEN_KEY) || null;
let currentUser   = JSON.parse(localStorage.getItem(USER_KEY) || 'null');

// Vainko state
let skillLevel         = localStorage.getItem('sheller_skill_level') || '';
let vainkoHintsEnabled = localStorage.getItem('sheller_vainko_hints') === 'true';
let inputBuffer        = '';
let hintDebounceTimer  = null;
let currentGhostHint   = '';
let ghostHintActive    = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setStatus(dot, label, state, text) {
  const d = document.getElementById(dot);
  const l = document.getElementById(label);
  if (d) { d.className = 'term-status-dot ' + state; }
  if (l) l.textContent = text;
}

function showOverlay(msg) {
  document.getElementById('overlay-msg').textContent = msg;
  document.getElementById('overlay').classList.remove('hidden');
}

function hideOverlay() {
  document.getElementById('overlay').classList.add('hidden');
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.classList.toggle('hidden', !msg); }
}

function setAuthLoading(loading) {
  const btn = document.getElementById('auth-submit-btn');
  if (btn) btn.disabled = loading;
}

function togglePasswordVisibility() {
  const input = document.getElementById('auth-password');
  const open  = document.getElementById('eye-open');
  const closed = document.getElementById('eye-closed');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (open)   open.classList.toggle('hidden', show);
  if (closed) closed.classList.toggle('hidden', !show);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

  // Wire up auth form
  document.getElementById('auth-tab-login') ?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('auth-tab-signup')?.addEventListener('click', () => switchAuthTab('signup'));
  document.getElementById('auth-form')      ?.addEventListener('submit', handleAuthSubmit);

  // Check if we have a saved token
  if (authToken) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
        updateUserDisplay();
        showSkillSurveyIfNeeded();
        await resumeOrPicker();
        return;
      }
    } catch (_) {}
    // Token invalid — clear it
    authToken = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  // No valid token — show auth screen
  showScreen('auth');
});

async function resumeOrPicker() {
  const savedId = localStorage.getItem(SESSION_KEY);
  const savedOs = localStorage.getItem(OS_KEY);

  if (savedId && savedOs) {
    try {
      const res  = await fetch(`/api/session/${savedId}`);
      const json = await res.json();
      if (json.active) {
        sessionId = savedId;
        currentOS = savedOs;
        openTerminalPage(savedOs, json.osName, savedId, /* reconnect */ true);
        return;
      }
    } catch (_) {}
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(OS_KEY);
  }

  showScreen('picker');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

let authMode = 'login';

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('auth-tab-login') ?.classList.toggle('active', mode === 'login');
  document.getElementById('auth-tab-signup')?.classList.toggle('active', mode === 'signup');
  const btn = document.getElementById('auth-submit-btn');
  if (btn) btn.textContent = mode === 'login' ? 'Log In' : 'Sign Up';
  // Show/hide username field
  const usernameWrap = document.getElementById('auth-username-wrap');
  if (usernameWrap) usernameWrap.classList.toggle('hidden', mode === 'login');
  setAuthError('');
}

function devBypass() {
  // Skip auth entirely — go straight to the OS picker (demo mode).
  authToken = null;
  currentUser = { username: 'demo', email: 'demo@sheller.local' };
  updateUserDisplay();
  showSkillSurveyIfNeeded();
  showScreen('picker');
}

async function handleAuthSubmit(e) {
  e.preventDefault();

  const email    = document.getElementById('auth-email')   ?.value?.trim();
  const password = document.getElementById('auth-password')?.value;
  const username = document.getElementById('auth-username')?.value?.trim();

  if (authMode === 'signup' && !username) { setAuthError('Username is required.'); return; }
  if (!email || !password) { setAuthError('Email and password are required.'); return; }

  setAuthLoading(true);
  setAuthError('');

  try {
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const body = authMode === 'login'
      ? { email, password }
      : { username, email, password };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      setAuthError(data.error || 'Authentication failed.');
      setAuthLoading(false);
      return;
    }

    // Success — save token and user
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem(TOKEN_KEY, authToken);
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
    updateUserDisplay();
    showSkillSurveyIfNeeded();
    await resumeOrPicker();
  } catch (err) {
    setAuthError(err.message || 'Authentication failed.');
    setAuthLoading(false);
  }
}

function updateUserDisplay() {
  const emailEl = document.getElementById('user-email-display');
  if (emailEl && currentUser) {
    emailEl.textContent = currentUser.username || currentUser.email || '';
    emailEl.style.display = currentUser.username ? '' : 'none';
  }
}

async function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(OS_KEY);
  sessionId = null; currentOS = null;
  if (ws) { ws.close(); ws = null; }
  if (term) { term.dispose(); term = null; fitAddon = null; }
  inputBuffer = ''; currentGhostHint = ''; ghostHintActive = false;
  // Reset auth form state
  setAuthLoading(false);
  setAuthError('');
  const emailInput    = document.getElementById('auth-email');
  const passInput     = document.getElementById('auth-password');
  const usernameInput = document.getElementById('auth-username');
  if (emailInput) emailInput.value = '';
  if (passInput)  passInput.value  = '';
  if (usernameInput) usernameInput.value = '';
  switchAuthTab('login');
  showScreen('auth');
}

// ─── OS selection ─────────────────────────────────────────────────────────────

function selectOS(os) {
  currentOS = os;
  sessionId = localStorage.getItem(SESSION_KEY) || crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
  localStorage.setItem(OS_KEY, os);

  // Reset loader UI
  showScreen('loader');
  document.getElementById('loader-status').textContent = 'Starting container\u2026';
  document.getElementById('loader-hint').textContent = 'Spinning up your container\u2026';
  const spinner = document.getElementById('loader-spinner');
  if (spinner) spinner.style.display = '';
  const backBtn = document.getElementById('loader-back-btn');
  if (backBtn) backBtn.style.display = 'none';

  connectWebSocket(os, sessionId);
}

function loaderGoBack() {
  // Clean up any pending WebSocket
  if (ws) { ws.close(); ws = null; }
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(OS_KEY);
  sessionId = null; currentOS = null;
  showScreen('picker');
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket(os, sid) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    const token = authToken || '';
    ws.send(JSON.stringify({ type: 'init', sessionId: sid, os, token }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'status':
        document.getElementById('loader-status').textContent = msg.message;
        break;

      case 'ready':
        openTerminalPage(msg.os, msg.osName, msg.sessionId, false);
        break;

      case 'output':
        if (term) {
          const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
          // ── Fix: filter Docker attach JSON header garbage ─────────────────
          // When Dockerode attaches with hijack=true it emits the options object
          // {"stream":true,"stdin":true,...} as raw output. Discard it.
          const str = new TextDecoder().decode(bytes);
          if (str.includes('"hijack"') && str.includes('"stream"')) {
            // Strip the JSON blob and write whatever remains (e.g. prompt)
            const cleaned = str.replace(/[\s\S]*?\{[^}]*"hijack"[^}]*\}\s*/g, '');
            if (cleaned.length > 0) {
              term.write(new TextEncoder().encode(cleaned));
            }
            break;
          }
          term.write(bytes);
        }
        break;

      case 'closed':
        setStatus('term-status-dot', 'term-status-label', 'disconnected', 'Exited');
        showOverlay(msg.message || 'Container shell exited.');
        break;

      case 'timeout':
        setStatus('term-status-dot', 'term-status-label', 'disconnected', 'Timed out');
        showOverlay(msg.message || 'Session expired.');
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(OS_KEY);
        break;

      case 'error':
        if (document.getElementById('loader').classList.contains('active')) {
          document.getElementById('loader-status').textContent = '\u2717 ' + msg.message;
          document.getElementById('loader-hint').textContent = 'Could not start the container.';
          // Stop spinner and show back button
          const spinner = document.getElementById('loader-spinner');
          if (spinner) spinner.style.display = 'none';
          const backBtn = document.getElementById('loader-back-btn');
          if (backBtn) backBtn.style.display = '';
        } else {
          showOverlay(msg.message);
        }
        break;
    }
  });

  ws.addEventListener('close', () => {
    setStatus('term-status-dot', 'term-status-label', 'disconnected', 'Disconnected');
  });

  ws.addEventListener('error', () => {
    document.getElementById('loader-status').textContent = '\u2717 WebSocket error \u2014 is the server running?';
    document.getElementById('loader-hint').textContent = 'Check that the server is started.';
    const spinner = document.getElementById('loader-spinner');
    if (spinner) spinner.style.display = 'none';
    const backBtn = document.getElementById('loader-back-btn');
    if (backBtn) backBtn.style.display = '';
  });
}

// ─── Terminal page ────────────────────────────────────────────────────────────

const OS_ACCENT = { kali: '#e11d48', ubuntu: '#f97316', powershell: '#3b82f6' };
const OS_CURSOR = { kali: '#e11d48', ubuntu: '#f97316', powershell: '#60a5fa' };
const OS_NAMES  = { kali: 'Kali Linux', ubuntu: 'Ubuntu', powershell: 'PowerShell' };

function openTerminalPage(os, osName, sid, isReconnect) {
  hideOverlay();

  document.getElementById('term-title').textContent =
    `${osName || os}  \u2014  ${sid.slice(0, 8)}`;
  setStatus('term-status-dot', 'term-status-label', 'connected', 'Connected');
  updateUserDisplay();
  updateHintToggleUI();

  showScreen('terminal-page');

  const accent = OS_ACCENT[os] || '#3fb950';
  document.documentElement.style.setProperty('--os-accent', accent);

  if (!term) {
    term = new Terminal({
      cursorBlink:   true,
      fontFamily:    '"JetBrains Mono", "Cascadia Code", "Consolas", monospace',
      fontSize:      14,
      lineHeight:    1.3,
      theme: {
        background:   '#0d1117',
        foreground:   '#e6edf3',
        cursor:       OS_CURSOR[os] || '#3fb950',
        black:        '#0d1117',
        red:          '#f85149',
        green:        '#3fb950',
        yellow:       '#e3b341',
        blue:         '#58a6ff',
        magenta:      '#bc8cff',
        cyan:         '#39d353',
        white:        '#e6edf3',
        brightBlack:  '#484f58',
        brightRed:    '#ff7b72',
        brightGreen:  '#56d364',
        brightYellow: '#e3b341',
        brightBlue:   '#79c0ff',
        brightMagenta:'#d2a8ff',
        brightCyan:   '#56d364',
        brightWhite:  '#f0f6fc',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('xterm-mount'));
    fitAddon.fit();

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', sessionId, data: btoa(data) }));
      }
      // Ghost hint tracking
      if (vainkoHintsEnabled) {
        handleTerminalInput(data);
      }
    });

    // Custom key handler for ghost hint Tab/Escape
    term.attachCustomKeyEventHandler((event) => {
      if (vainkoHintsEnabled && currentGhostHint && ghostHintActive) {
        if (event.key === 'Tab' && event.type === 'keydown') {
          event.preventDefault();
          event.stopPropagation();
          acceptGhostHint();
          term.focus();
          return false;
        }
        if (event.key === 'Escape' && event.type === 'keydown') {
          event.preventDefault();
          dismissGhostHint();
          term.focus();
          return false;
        }
      }
      return true;
    });

    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', sessionId, cols, rows }));
      }
    });

    window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });
    term.focus();
  }

  if (isReconnect && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connectWebSocket(os, sid);
  }
}

// ─── Skill Level Survey ───────────────────────────────────────────────────────

function showSkillSurveyIfNeeded() {
  if (!localStorage.getItem('sheller_skill_level')) {
    document.getElementById('skill-survey-overlay').style.display = 'flex';
  }
}

function selectSkillLevel(level) {
  localStorage.setItem('sheller_skill_level', level);
  skillLevel = level;
  document.getElementById('skill-survey-overlay').style.display = 'none';
}

// ─── Vainko Chat Overlay — 3-Phase Learning System ───────────────────────────

function selectVainko() {
  skillLevel = localStorage.getItem('sheller_skill_level') || 'beginner';
  const overlay = document.getElementById('vainko-chat-overlay');
  overlay.classList.remove('hidden');
  loadVainkoChat();
}

function closeVainkoChat() {
  const overlay = document.getElementById('vainko-chat-overlay');
  overlay.classList.add('hidden');
  overlay.innerHTML = '';
}

function loadVainkoChat() {
  const overlay = document.getElementById('vainko-chat-overlay');
  const skill = skillLevel || 'beginner';
  const skillLabel = skill === 'experienced' ? 'Experienced' : skill === 'intermediate' ? 'Intermediate' : 'Beginner';

  // Full lesson data with hardcoded step content
  const LESSONS = {
    navigation: {
      title: 'Navigation', desc: 'Move around the filesystem with confidence',
      difficulty: 'beginner', time: '~8 min', available: true,
      steps: [
        {
          title: 'Understanding the filesystem structure',
          info: 'Linux organizes everything in a single tree starting at <span class="v-highlight">/</span>. Every file and directory lives under root <span class="v-highlight">/</span>. Common directories: <span class="v-highlight">/home</span> (user files), <span class="v-highlight">/etc</span> (config), <span class="v-highlight">/var</span> (logs), <span class="v-highlight">/tmp</span> (temporary).',
          mcqQuestion: 'What directory contains system configuration files?',
          mcqOptions: ['/config', '/etc', '/system', '/conf'],
          mcqAnswer: '/etc',
          terminalPrompt: 'Type the command to print your current directory',
          terminalExpected: ['pwd'],
          terminalOutput: '/home/user'
        },
        {
          title: 'Moving between directories with cd',
          info: '<span class="v-highlight">cd</span> (change directory) moves you between directories. <span class="v-highlight">cd /etc</span> goes to /etc. <span class="v-highlight">cd ..</span> goes up one level. <span class="v-highlight">cd ~</span> or just <span class="v-highlight">cd</span> goes home. <span class="v-highlight">cd -</span> goes to previous directory.',
          mcqQuestion: 'How do you go up one directory level?',
          mcqOptions: ['cd up', 'cd ..', 'cd /', 'cd back'],
          mcqAnswer: 'cd ..',
          terminalPrompt: 'Navigate to the /etc directory',
          terminalExpected: ['cd /etc', 'cd/etc'],
          terminalOutput: ''
        },
        {
          title: 'Listing contents with ls and flags',
          info: '<span class="v-highlight">ls</span> lists directory contents. Useful flags: <span class="v-highlight">-l</span> (long format with permissions), <span class="v-highlight">-a</span> (show hidden files starting with .), <span class="v-highlight">-h</span> (human readable sizes), <span class="v-highlight">-la</span> combines them.',
          mcqQuestion: 'Which flag shows hidden files?',
          mcqOptions: ['-h', '-l', '-a', '-r'],
          mcqAnswer: '-a',
          terminalPrompt: 'List all files including hidden ones in long format',
          terminalExpected: ['ls -la', 'ls -al', 'ls -l -a', 'ls -a -l'],
          terminalOutput: 'total 32\ndrwxr-xr-x  5 user user 4096 Mar  3 10:00 .\ndrwxr-xr-x  3 root root 4096 Mar  1 09:00 ..\n-rw-------  1 user user  220 Mar  1 09:00 .bash_history\n-rw-r--r--  1 user user  807 Mar  1 09:00 .bashrc'
        },
        {
          title: 'Understanding absolute vs relative paths',
          info: '<span class="v-highlight">Absolute paths</span> start from / and always work regardless of where you are. <span class="v-highlight">Relative paths</span> are relative to your current location. <span class="v-highlight">/etc/passwd</span> is absolute. <span class="v-highlight">../config</span> is relative.',
          mcqQuestion: 'Which is an absolute path?',
          mcqOptions: ['../etc', 'etc/passwd', '/etc/passwd', './passwd'],
          mcqAnswer: '/etc/passwd',
          terminalPrompt: 'Navigate to /var/log using an absolute path',
          terminalExpected: ['cd /var/log'],
          terminalOutput: ''
        },
        {
          title: 'Using pwd and tab completion',
          info: '<span class="v-highlight">pwd</span> prints your current working directory. <span class="v-highlight">Tab completion</span> auto-completes file and directory names — type part of a name and press Tab. Double Tab shows all options.',
          mcqQuestion: 'What does pwd stand for?',
          mcqOptions: ['Print Working Directory', 'Path Working Dir', 'Present Working Directory', 'Print Where Directory'],
          mcqAnswer: 'Print Working Directory',
          terminalPrompt: 'Print your current working directory',
          terminalExpected: ['pwd'],
          terminalOutput: '/var/log'
        }
      ]
    },
    permissions: {
      title: 'Permissions', desc: 'Control who can read, write, and execute files',
      difficulty: 'beginner', time: '~10 min', available: true,
      steps: [
        {
          title: 'Understanding rwx notation',
          info: 'Every file has permissions for 3 groups: <span class="v-highlight">owner</span>, <span class="v-highlight">group</span>, <span class="v-highlight">others</span>. Each has <span class="v-highlight">read(r=4)</span>, <span class="v-highlight">write(w=2)</span>, <span class="v-highlight">execute(x=1)</span>. -rwxr-xr-- means owner can do everything, group can read+execute, others can only read.',
          mcqQuestion: "What does 'w' represent in permissions?",
          mcqOptions: ['write', 'wide', 'work', 'watch'],
          mcqAnswer: 'write',
          terminalPrompt: 'List files with their permissions',
          terminalExpected: ['ls -l', 'ls -la', 'ls -al'],
          terminalOutput: 'total 8\n-rw-r--r-- 1 user user 1234 Mar  3 10:00 file.txt\ndrwxr-xr-x 2 user user 4096 Mar  3 09:00 scripts'
        },
        {
          title: 'Reading permission strings',
          info: 'Permission string <span class="v-highlight">-rwxr-xr--</span> has 10 characters. First is file type (<span class="v-highlight">-</span> file, <span class="v-highlight">d</span> directory). Next 3 are owner permissions. Next 3 are group. Last 3 are others.',
          mcqQuestion: "What does 'd' at the start of a permission string mean?",
          mcqOptions: ['deleted', 'directory', 'daemon', 'default'],
          mcqAnswer: 'directory',
          terminalPrompt: 'Show permissions of files in /etc',
          terminalExpected: ['ls -l /etc', 'ls -la /etc', 'ls -al /etc'],
          terminalOutput: 'total 1024\ndrwxr-xr-x  2 root root  4096 Mar  1 10:00 apt\n-rw-r--r--  1 root root  2319 Mar  1 10:00 bash.bashrc'
        },
        {
          title: 'Using chmod with numbers',
          info: '<span class="v-highlight">chmod</span> with numbers changes permissions. Each permission group is a sum: <span class="v-highlight">r=4, w=2, x=1</span>. <span class="v-highlight">chmod 755</span> means owner=7(rwx), group=5(r-x), others=5(r-x). <span class="v-highlight">chmod 644</span> is common for files.',
          mcqQuestion: 'What numeric value represents read and write only?',
          mcqOptions: ['5', '6', '7', '3'],
          mcqAnswer: '6',
          terminalPrompt: 'Give owner full permissions, group and others read only',
          terminalExpected: ['chmod 644', 'chmod 644 file', 'chmod 644 file.txt'],
          terminalOutput: ''
        },
        {
          title: 'Using chmod with symbols',
          info: 'chmod with symbols: <span class="v-highlight">u</span>=user/owner, <span class="v-highlight">g</span>=group, <span class="v-highlight">o</span>=others, <span class="v-highlight">a</span>=all. <span class="v-highlight">+</span> adds, <span class="v-highlight">-</span> removes, <span class="v-highlight">=</span> sets exactly. <span class="v-highlight">chmod u+x</span> adds execute for owner.',
          mcqQuestion: 'How do you add execute permission for the owner?',
          mcqOptions: ['chmod +x', 'chmod u+x', 'chmod o+x', 'chmod a-x'],
          mcqAnswer: 'chmod u+x',
          terminalPrompt: 'Remove write permission from others on a file',
          terminalExpected: ['chmod o-w', 'chmod o-w file', 'chmod o-w file.txt'],
          terminalOutput: ''
        },
        {
          title: 'Changing ownership with chown',
          info: '<span class="v-highlight">chown</span> changes file ownership. <span class="v-highlight">chown user:group file</span> changes both owner and group. <span class="v-highlight">chown john file</span> changes owner to john. Requires sudo for files you don\'t own.',
          mcqQuestion: 'What command changes file ownership?',
          mcqOptions: ['chmod', 'chown', 'chgrp only', 'usermod'],
          mcqAnswer: 'chown',
          terminalPrompt: 'Change owner of a file to root',
          terminalExpected: ['chown root', 'chown root file', 'chown root file.txt', 'sudo chown root'],
          terminalOutput: ''
        }
      ]
    },
    networking: {
      title: 'Networking', desc: 'Inspect and troubleshoot network connections',
      difficulty: 'intermediate', time: '~12 min', available: false, steps: []
    },
    'kali-tools': {
      title: 'Kali Tools', desc: 'Essential security tools in Kali Linux',
      difficulty: 'intermediate', time: '~15 min', available: false, steps: []
    },
    scripting: {
      title: 'Scripting', desc: 'Automate tasks with bash scripts',
      difficulty: 'intermediate', time: '~12 min', available: false, steps: []
    },
    packages: {
      title: 'Package Management', desc: 'Install, update, and remove software',
      difficulty: 'beginner', time: '~8 min', available: false, steps: []
    }
  };

  // Store on window for access by helper functions
  window._vainkoLessons = LESSONS;
  window._vainkoActiveLesson = null;
  window._vainkoActiveStep = 0;
  window._vainkoCurrentPhase = 1; // 1=info, 2=mcq, 3=terminal
  window._vainkoCompleted = {};
  window._vainkoStepPhases = {};

  // Build lesson cards HTML
  let lessonCardsHtml = '';
  for (const [id, lesson] of Object.entries(LESSONS)) {
    const diffLabel = lesson.difficulty === 'beginner' ? 'Beginner' : 'Intermediate';
    const lockedClass = lesson.available ? '' : ' locked';
    const onclick = lesson.available ? 'onclick="selectVainkoLesson(\'' + id + '\')"' : '';
    lessonCardsHtml += '<div class="v-lesson-card' + lockedClass + '" data-lesson-id="' + id + '" ' + onclick + '>' +
      '<div class="v-lesson-card-title">' + lesson.title + '</div>' +
      '<div class="v-lesson-card-desc">' + lesson.desc + '</div>' +
      '<div class="v-lesson-card-meta">' +
        '<span class="v-diff-pill ' + lesson.difficulty + '">' + diffLabel + '</span>' +
        '<span class="v-lesson-card-time">' + lesson.time + '</span>' +
      '</div></div>';
  }

  overlay.innerHTML = '<aside class="v-sidebar">' +
      '<div class="v-sidebar-header">' +
        '<div class="v-sidebar-brand">VAINKO</div>' +
        '<div class="v-sidebar-skill"><span class="v-skill-pill ' + skill + '">' + skillLabel + '</span></div>' +
      '</div>' +
      '<div class="v-sidebar-section">Lessons</div>' +
      '<div class="v-lesson-list">' + lessonCardsHtml + '</div>' +
    '</aside>' +
    '<main class="v-main-area">' +
      '<div class="v-main-header" id="v-main-header" style="display:none;">' +
        '<div class="v-main-lesson-title" id="v-main-lesson-title"></div>' +
        '<div class="v-main-progress"><div class="v-main-progress-fill" id="v-main-progress-fill"></div></div>' +
        '<div class="v-main-progress-label" id="v-main-progress-label">0 / 5 steps</div>' +
      '</div>' +
      '<div class="v-step-nav" id="v-step-nav" style="display:none;"></div>' +
      '<div class="v-main-content" id="v-main-content">' +
        '<div class="v-welcome-state" id="v-welcome-state">' +
          '<h2>Welcome to Vainko</h2>' +
          '<p>Select a lesson from the sidebar to start learning. Each lesson has explanations, quizzes, and hands-on terminal challenges.</p>' +
        '</div>' +
        '<div class="v-phase-container" id="v-phase-info"></div>' +
        '<div class="v-phase-container" id="v-phase-mcq"></div>' +
        '<div class="v-phase-container" id="v-phase-terminal"></div>' +
        '<div class="v-lesson-complete" id="v-lesson-complete">' +
          '<div class="v-lesson-complete-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline></svg></div>' +
          '<div class="v-lesson-complete-text">Lesson Complete!</div>' +
          '<div class="v-lesson-complete-sub">Great work! Pick another lesson from the sidebar to keep learning.</div>' +
        '</div>' +
      '</div>' +
    '</main>' +
    '<aside class="v-chat-column">' +
      '<div class="v-chat-topbar">' +
        '<div class="v-chat-topbar-left">' +
          '<span class="v-chat-wordmark">Vainko</span>' +
          '<span class="v-chat-subtitle">watching your progress</span>' +
        '</div>' +
        '<button class="v-back-link" onclick="closeVainkoChat()">✕</button>' +
      '</div>' +
      '<div class="v-chat-messages" id="vainko-messages"></div>' +
      '<div class="v-chat-inputbar">' +
        '<input type="text" id="vainko-input" placeholder="Ask Vainko..." onkeydown="if(event.key===\'Enter\')sendVainkoMessage()" />' +
        '<button onclick="sendVainkoMessage()">Send</button>' +
      '</div>' +
    '</aside>';

  appendVainkoMessage('assistant', 'Select a lesson from the sidebar to begin. I\'ll guide you through each step and help when you need it.');
}

function selectVainkoLesson(id) {
  const LESSONS = window._vainkoLessons;
  if (!LESSONS || !LESSONS[id] || !LESSONS[id].available) return;
  
  window._vainkoActiveLesson = id;
  window._vainkoActiveStep = 0;
  window._vainkoCurrentPhase = 1;
  
  if (!window._vainkoCompleted[id]) window._vainkoCompleted[id] = new Set();
  if (!window._vainkoStepPhases[id]) window._vainkoStepPhases[id] = {};

  document.querySelectorAll('.v-lesson-card').forEach(c => c.classList.remove('active'));
  const card = document.querySelector('.v-lesson-card[data-lesson-id="' + id + '"]');
  if (card) card.classList.add('active');

  document.getElementById('v-main-header').style.display = 'block';
  document.getElementById('v-step-nav').style.display = 'flex';
  document.getElementById('v-welcome-state').style.display = 'none';
  document.getElementById('v-lesson-complete').classList.remove('visible');

  const lesson = LESSONS[id];
  appendVainkoMessage('assistant', "I'm watching your progress on " + lesson.title + ". Work through the steps — I'll jump in if you need me.");

  renderVainkoLesson();
}

function renderVainkoLesson() {
  const LESSONS = window._vainkoLessons;
  const id = window._vainkoActiveLesson;
  if (!LESSONS || !id) return;

  const lesson = LESSONS[id];
  const done = window._vainkoCompleted[id] || new Set();
  const total = lesson.steps.length;
  const doneCount = done.size;

  // Check if lesson complete
  if (doneCount === total) {
    document.getElementById('v-phase-info').classList.remove('active');
    document.getElementById('v-phase-mcq').classList.remove('active');
    document.getElementById('v-phase-terminal').classList.remove('active');
    document.getElementById('v-lesson-complete').classList.add('visible');
    return;
  }

  // Update header
  document.getElementById('v-main-lesson-title').textContent = lesson.title;
  document.getElementById('v-main-progress-fill').style.width = ((doneCount / total) * 100) + '%';
  document.getElementById('v-main-progress-label').textContent = doneCount + ' / ' + total + ' steps';

  renderVainkoStepNav();
  renderVainkoCurrentPhase();
}

function renderVainkoStepNav() {
  const LESSONS = window._vainkoLessons;
  const id = window._vainkoActiveLesson;
  const lesson = LESSONS[id];
  const navEl = document.getElementById('v-step-nav');
  const done = window._vainkoCompleted[id] || new Set();

  navEl.innerHTML = '';
  lesson.steps.forEach((step, i) => {
    const isCompleted = done.has(i);
    const isActive = i === window._vainkoActiveStep;
    const isLocked = i > 0 && !done.has(i - 1) && !isCompleted;

    const item = document.createElement('div');
    item.className = 'v-step-nav-item' + 
      (isCompleted ? ' completed' : '') + 
      (isActive ? ' active' : '') +
      (isLocked ? ' locked' : '');
    
    if (!isLocked) {
      item.onclick = () => goToVainkoStep(i);
    }

    item.innerHTML = '<div class="v-step-nav-check"></div><span>Step ' + (i + 1) + '</span>';
    navEl.appendChild(item);
  });
}

function goToVainkoStep(index) {
  const done = window._vainkoCompleted[window._vainkoActiveLesson] || new Set();
  if (done.has(index)) {
    window._vainkoActiveStep = index;
    window._vainkoCurrentPhase = 3;
  } else if (index === 0 || done.has(index - 1)) {
    window._vainkoActiveStep = index;
    window._vainkoCurrentPhase = window._vainkoStepPhases[window._vainkoActiveLesson]?.[index] || 1;
  }
  renderVainkoLesson();
}

function renderVainkoCurrentPhase() {
  const LESSONS = window._vainkoLessons;
  const id = window._vainkoActiveLesson;
  const lesson = LESSONS[id];
  const step = lesson.steps[window._vainkoActiveStep];
  const done = window._vainkoCompleted[id] || new Set();

  document.getElementById('v-phase-info').classList.remove('active');
  document.getElementById('v-phase-mcq').classList.remove('active');
  document.getElementById('v-phase-terminal').classList.remove('active');
  document.getElementById('v-lesson-complete').classList.remove('visible');

  if (done.has(window._vainkoActiveStep)) {
    renderVainkoTerminalPhase(step, true);
    return;
  }

  if (window._vainkoCurrentPhase === 1) {
    renderVainkoInfoPhase(step);
  } else if (window._vainkoCurrentPhase === 2) {
    renderVainkoMcqPhase(step);
  } else if (window._vainkoCurrentPhase === 3) {
    renderVainkoTerminalPhase(step, false);
  }
}

function renderVainkoInfoPhase(step) {
  const container = document.getElementById('v-phase-info');
  container.innerHTML = '<div class="v-info-card">' +
    '<div class="v-info-card-title"><span class="v-phase-num">1</span>Learn: ' + step.title + '</div>' +
    '<div class="v-info-card-content">' + step.info + '</div>' +
    '<button class="v-info-card-btn" onclick="completeVainkoInfoPhase()">I understand, continue</button>' +
  '</div>';
  container.classList.add('active');
}

function completeVainkoInfoPhase() {
  window._vainkoCurrentPhase = 2;
  const id = window._vainkoActiveLesson;
  if (!window._vainkoStepPhases[id]) window._vainkoStepPhases[id] = {};
  window._vainkoStepPhases[id][window._vainkoActiveStep] = 2;
  renderVainkoCurrentPhase();
}

function renderVainkoMcqPhase(step) {
  const container = document.getElementById('v-phase-mcq');
  let optionsHtml = '';
  step.mcqOptions.forEach(opt => {
    const escaped = opt.replace(/'/g, "\\'");
    const answerEscaped = step.mcqAnswer.replace(/'/g, "\\'");
    optionsHtml += '<button class="v-mcq-option" onclick="checkVainkoMcqAnswer(this, \'' + escaped + '\', \'' + answerEscaped + '\')">' + opt + '</button>';
  });

  container.innerHTML = '<div class="v-mcq-card">' +
    '<div class="v-mcq-title"><span class="v-phase-num">2</span>Quick Check</div>' +
    '<div class="v-mcq-question">' + step.mcqQuestion + '</div>' +
    '<div class="v-mcq-options">' + optionsHtml + '</div>' +
    '<div class="v-mcq-feedback" id="v-mcq-feedback"></div>' +
    '<button class="v-mcq-continue-btn" id="v-mcq-continue" onclick="completeVainkoMcqPhase()">Nice. Now try it.</button>' +
  '</div>';
  container.classList.add('active');
}

function checkVainkoMcqAnswer(btn, selected, correct) {
  const feedback = document.getElementById('v-mcq-feedback');
  const continueBtn = document.getElementById('v-mcq-continue');
  
  if (selected === correct) {
    btn.classList.add('correct');
    feedback.className = 'v-mcq-feedback correct';
    feedback.textContent = 'Correct!';
    continueBtn.classList.add('visible');
    document.querySelectorAll('.v-mcq-option').forEach(o => o.disabled = true);
  } else {
    btn.classList.add('wrong');
    feedback.className = 'v-mcq-feedback wrong';
    feedback.textContent = 'Not quite. Try again.';
    
    const LESSONS = window._vainkoLessons;
    const lesson = LESSONS[window._vainkoActiveLesson];
    const step = lesson.steps[window._vainkoActiveStep];
    sendVainkoToApiSilent('User got this MCQ wrong: "' + step.mcqQuestion + '". They chose "' + selected + '". Briefly explain why that\'s incorrect without giving away the answer.');
    
    setTimeout(() => {
      btn.classList.remove('wrong');
      if (!document.querySelector('.v-mcq-option.correct')) {
        feedback.className = 'v-mcq-feedback';
      }
    }, 1500);
  }
}

function completeVainkoMcqPhase() {
  window._vainkoCurrentPhase = 3;
  const id = window._vainkoActiveLesson;
  if (!window._vainkoStepPhases[id]) window._vainkoStepPhases[id] = {};
  window._vainkoStepPhases[id][window._vainkoActiveStep] = 3;
  renderVainkoCurrentPhase();
}

function renderVainkoTerminalPhase(step, isCompleted) {
  const container = document.getElementById('v-phase-terminal');
  const completedOutput = isCompleted && step.terminalOutput ? '<div class="v-terminal-success-output">' + step.terminalOutput + '</div>' : '';
  const promptClass = isCompleted ? 'v-terminal-prompt success' : 'v-terminal-prompt';
  const skipBtn = !isCompleted ? '<button class="v-terminal-skip-btn" onclick="skipVainkoTerminal()">Skip with explanation</button>' : '';
  const completeClass = isCompleted ? ' visible' : '';
  const completeText = isCompleted ? 'Completed ✓' : 'Continue to next step';

  container.innerHTML = '<div class="v-terminal-card">' +
    '<div class="v-terminal-header"><div class="v-terminal-header-title"><span class="v-phase-num">3</span>Try It</div></div>' +
    '<div class="v-terminal-instruction">' + step.terminalPrompt + '</div>' +
    '<div class="v-fake-terminal">' +
      '<div class="v-terminal-titlebar"><div class="v-terminal-dot red"></div><div class="v-terminal-dot yellow"></div><div class="v-terminal-dot green"></div></div>' +
      '<div class="v-terminal-body">' +
        completedOutput +
        '<div class="v-terminal-line">' +
          '<span class="' + promptClass + '" id="v-terminal-prompt">root@sheller:~$</span>' +
          '<input type="text" class="v-terminal-input" id="v-terminal-input" autocomplete="off" spellcheck="false" placeholder="' + (isCompleted ? step.terminalExpected[0] : 'Type command here...') + '" onkeydown="if(event.key===\'Enter\')checkVainkoTerminalCommand()" ' + (isCompleted ? 'disabled' : '') + '/>' +
        '</div>' +
        '<div class="v-terminal-error" id="v-terminal-error">Command not correct. Try again.</div>' +
      '</div>' +
    '</div>' +
    '<div class="v-terminal-actions">' +
      skipBtn +
      '<button class="v-terminal-complete-btn' + completeClass + '" id="v-terminal-complete" onclick="completeVainkoStep()">' + completeText + '</button>' +
    '</div>' +
  '</div>';
  container.classList.add('active');

  if (!isCompleted) {
    setTimeout(() => document.getElementById('v-terminal-input')?.focus(), 100);
  }
}

function checkVainkoTerminalCommand() {
  const input = document.getElementById('v-terminal-input');
  const command = input.value.trim().toLowerCase();
  const LESSONS = window._vainkoLessons;
  const lesson = LESSONS[window._vainkoActiveLesson];
  const step = lesson.steps[window._vainkoActiveStep];
  const prompt = document.getElementById('v-terminal-prompt');
  const error = document.getElementById('v-terminal-error');
  const completeBtn = document.getElementById('v-terminal-complete');

  const isCorrect = step.terminalExpected.some(exp => command === exp.toLowerCase() || command.startsWith(exp.toLowerCase()));

  if (isCorrect) {
    prompt.classList.remove('error');
    prompt.classList.add('success');
    error.classList.remove('visible');
    input.disabled = true;
    completeBtn.classList.add('visible');

    if (step.terminalOutput) {
      const body = document.querySelector('.v-terminal-body');
      const outputDiv = document.createElement('div');
      outputDiv.className = 'v-terminal-success-output';
      outputDiv.textContent = step.terminalOutput;
      body.insertBefore(outputDiv, body.querySelector('.v-terminal-line'));
    }
  } else {
    prompt.classList.add('error');
    error.classList.add('visible');
    
    // Give direct feedback: explain both commands briefly
    const correctCmd = step.terminalExpected[0];
    sendVainkoToApiSilent('Wrong command. User typed "' + command + '", correct is [CMD: ' + correctCmd + ']. Explain what both do in 2 sentences max.');
    
    setTimeout(() => {
      prompt.classList.remove('error');
      error.classList.remove('visible');
      input.value = '';
      input.focus();
    }, 3000);
  }
}

function skipVainkoTerminal() {
  const LESSONS = window._vainkoLessons;
  const lesson = LESSONS[window._vainkoActiveLesson];
  const step = lesson.steps[window._vainkoActiveStep];
  
  sendVainkoToApiSilent('User skipped the terminal challenge for step ' + (window._vainkoActiveStep + 1) + ': "' + step.title + '". Explain what the correct command "' + step.terminalExpected[0] + '" does and why it\'s the answer.');
  
  completeVainkoStep();
}

function completeVainkoStep() {
  const LESSONS = window._vainkoLessons;
  const id = window._vainkoActiveLesson;
  const lesson = LESSONS[id];
  
  if (!window._vainkoCompleted[id]) window._vainkoCompleted[id] = new Set();
  window._vainkoCompleted[id].add(window._vainkoActiveStep);

  const step = lesson.steps[window._vainkoActiveStep];
  sendVainkoToApiSilent('User just completed step ' + (window._vainkoActiveStep + 1) + ': "' + step.title + '" in the ' + lesson.title + ' lesson. Share one brief insight about what they just learned.');

  const nextIndex = window._vainkoActiveStep + 1;
  if (nextIndex < lesson.steps.length) {
    window._vainkoActiveStep = nextIndex;
    window._vainkoCurrentPhase = 1;
    if (!window._vainkoStepPhases[id]) window._vainkoStepPhases[id] = {};
    window._vainkoStepPhases[id][nextIndex] = 1;
  }

  renderVainkoLesson();
}

function appendVainkoMessage(role, content) {
  const container = document.getElementById('vainko-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'v-msg ' + role;
  const processed = content.replace(/\[CMD:\s*(.*?)\]/g, function(_, cmd) {
    const trimmed = cmd.trim();
    const escaped = trimmed.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return '<span class="v-cmd-chip" onclick="copyVainkoCmd(\'' + escaped + '\')" title="Click to copy">' + trimmed + '</span>';
  });
  div.innerHTML = processed;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function copyVainkoCmd(cmd) {
  navigator.clipboard.writeText(cmd).catch(() => {});
}

async function sendVainkoMessage() {
  const input = document.getElementById('vainko-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  appendVainkoMessage('user', message);
  sendVainkoToApi(message);
}

async function sendVainkoToApi(message) {
  const container = document.getElementById('vainko-messages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'v-typing-indicator';
  typingDiv.id = 'vainko-typing';
  typingDiv.innerHTML = '<div class="v-typing-dot"></div><div class="v-typing-dot"></div><div class="v-typing-dot"></div>';
  if (container) { container.appendChild(typingDiv); container.scrollTop = container.scrollHeight; }

  try {
    const res = await fetch('/api/vainko', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65000),
      body: JSON.stringify({ message, os: currentOS || 'linux', skill: skillLevel || 'beginner' }),
    });
    const data = await res.json();
    document.getElementById('vainko-typing')?.remove();
    appendVainkoMessage('assistant', data.reply || data.error || 'No response.');
  } catch (err) {
    document.getElementById('vainko-typing')?.remove();
    appendVainkoMessage('assistant', err.name === 'TimeoutError' ? 'Vainko took too long. Try a shorter question.' : 'Error contacting Vainko. Please try again.');
  }
}

async function sendVainkoToApiSilent(message) {
  const container = document.getElementById('vainko-messages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'v-typing-indicator';
  typingDiv.id = 'vainko-typing';
  typingDiv.innerHTML = '<div class="v-typing-dot"></div><div class="v-typing-dot"></div><div class="v-typing-dot"></div>';
  if (container) { container.appendChild(typingDiv); container.scrollTop = container.scrollHeight; }

  try {
    const res = await fetch('/api/vainko', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65000),
      body: JSON.stringify({ message, os: currentOS || 'linux', skill: skillLevel || 'beginner' }),
    });
    const data = await res.json();
    document.getElementById('vainko-typing')?.remove();
    appendVainkoMessage('assistant', data.reply || data.error || 'No response.');
  } catch (err) {
    document.getElementById('vainko-typing')?.remove();
    appendVainkoMessage('assistant', err.name === 'TimeoutError' ? 'Vainko took too long.' : 'Error contacting Vainko.');
  }
}

// Legacy function stubs for backward compatibility
function renderVainkoSteps() { renderVainkoLesson(); }
function clickVainkoStep(index) { goToVainkoStep(index); }
function askVainkoAboutStep() { /* removed */ }

// ─── Ghost Hints ──────────────────────────────────────────────────────────────

function toggleVainkoHints() {
  vainkoHintsEnabled = !vainkoHintsEnabled;
  localStorage.setItem('sheller_vainko_hints', vainkoHintsEnabled);
  updateHintToggleUI();
  if (!vainkoHintsEnabled) {
    dismissGhostHint();
    inputBuffer = '';
  }
}

function updateHintToggleUI() {
  const btn = document.getElementById('vainko-hint-toggle');
  if (btn) btn.classList.toggle('active', vainkoHintsEnabled);
}

function handleTerminalInput(data) {
  if (data === '\r' || data === '\n') {
    inputBuffer = '';
    dismissGhostHint();
    return;
  }
  if (data === '\x7f' || data === '\b') {
    inputBuffer = inputBuffer.slice(0, -1);
    dismissGhostHint();
    tryLocalHintOrDebounce();
    return;
  }
  if (data.charCodeAt(0) < 32 && data !== '\t') return;
  inputBuffer += data;
  dismissGhostHint();
  tryLocalHintOrDebounce();
}

function tryLocalHintOrDebounce() {
  if (hintDebounceTimer) clearTimeout(hintDebounceTimer);
  if (inputBuffer.trim().length < 2) return;

  // Try local dictionary match INSTANTLY
  const localMatch = localPrefixMatch(inputBuffer.trimStart());
  if (localMatch) {
    showGhostHint(localMatch);
    return;
  }

  // No local match → debounce Ollama (600ms)
  hintDebounceTimer = setTimeout(() => fetchOllamaHint(), 600);
}

// Common terminal commands for instant local prefix matching
const COMMON_CMDS = [
  'apt', 'apt-get', 'awk', 'base64', 'bash', 'bg', 'bunzip2', 'bzip2',
  'cat', 'cd', 'chattr', 'chgrp', 'chmod', 'chown', 'chroot', 'clear',
  'cmp', 'comm', 'cp', 'cpio', 'crontab', 'curl', 'cut',
  'date', 'dd', 'df', 'diff', 'dig', 'dir', 'dirname', 'dmesg',
  'docker', 'dpkg', 'du',
  'echo', 'egrep', 'env', 'eval', 'exec', 'exit', 'export',
  'fg', 'fgrep', 'file', 'find', 'finger', 'free', 'ftp',
  'gcc', 'gdb', 'git', 'grep', 'groups', 'gunzip', 'gzip',
  'head', 'history', 'hostname', 'htop',
  'id', 'ifconfig', 'install', 'ip', 'iptables',
  'jobs', 'join',
  'kill', 'killall',
  'last', 'less', 'ln', 'locate', 'login', 'logout', 'ls', 'lsblk', 'lsof',
  'make', 'man', 'mkdir', 'mkfifo', 'more', 'mount', 'mv', 'mysql',
  'nano', 'nc', 'netcat', 'netstat', 'nice', 'nmap', 'nohup', 'npm', 'node',
  'openssl',
  'passwd', 'paste', 'patch', 'ping', 'pip', 'pkill', 'ps', 'pwd', 'python', 'python3',
  'reboot', 'rename', 'rm', 'rmdir', 'rsync',
  'scp', 'screen', 'sed', 'service', 'sftp', 'sh', 'shutdown', 'sleep',
  'sort', 'source', 'split', 'ss', 'ssh', 'stat', 'strings', 'strace',
  'su', 'sudo', 'systemctl',
  'tail', 'tar', 'tee', 'telnet', 'test', 'time', 'timeout', 'tmux',
  'top', 'touch', 'tr', 'traceroute', 'tree',
  'ufw', 'umask', 'umount', 'uname', 'uniq', 'unzip', 'uptime', 'useradd', 'usermod',
  'vi', 'vim', 'visudo',
  'watch', 'wc', 'wget', 'which', 'who', 'whoami', 'whois',
  'xargs',
  'yum',
  'zcat', 'zip', 'zsh',
  // common compound commands
  'sudo apt', 'sudo apt-get', 'sudo apt install', 'sudo apt update', 'sudo apt upgrade',
  'sudo rm', 'sudo chmod', 'sudo chown', 'sudo systemctl', 'sudo service',
  'git clone', 'git commit', 'git push', 'git pull', 'git status', 'git log', 'git branch', 'git checkout', 'git merge', 'git diff', 'git add', 'git init', 'git stash',
  'docker run', 'docker ps', 'docker images', 'docker build', 'docker exec', 'docker stop', 'docker rm',
  'npm install', 'npm start', 'npm run', 'npm init', 'npm test',
  'pip install', 'pip list', 'pip freeze',
  'python3 -m', 'python -m',
  'ls -la', 'ls -lah', 'ls -al', 'ls -l',
  'cat /etc/passwd', 'cat /etc/hosts',
  'ping google.com', 'ping localhost', 'ping 8.8.8.8',
  'cd ..', 'cd ~', 'cd /',
  'chmod +x', 'chmod 755', 'chmod 644',
  'curl -X', 'curl -o', 'curl -s',
  'wget -O', 'wget -q',
  'find . -name', 'find / -name',
  'grep -r', 'grep -i', 'grep -rn',
  'tar -xzf', 'tar -czf', 'tar -xvf',
  'ssh -i', 'ssh -p',
  'nmap -sV', 'nmap -sS', 'nmap -A', 'nmap -p',
  'ip addr', 'ip route', 'ip link',
  'systemctl start', 'systemctl stop', 'systemctl status', 'systemctl restart', 'systemctl enable',
  'uname -a', 'uname -r',
];

function localPrefixMatch(typed) {
  const t = typed.toLowerCase();
  // Find the best (shortest) match that starts with what was typed
  let best = null;
  for (const cmd of COMMON_CMDS) {
    if (cmd.startsWith(t) && cmd.length > t.length) {
      if (!best || cmd.length < best.length) best = cmd;
    }
  }
  return best ? best.slice(typed.length) : null;
}

async function fetchOllamaHint() {
  if (!inputBuffer.trim()) return;
  const typed = inputBuffer;
  try {
    const params = new URLSearchParams({ cmd: typed, os: currentOS || 'linux', skill: skillLevel || 'beginner' });
    const res = await fetch('/api/vainko-hint?' + params);
    const data = await res.json();
    if (data.hint && data.hint.trim()) {
      let hint = data.hint.trim();
      hint = hint.replace(/^[`'"]+|[`'"]+$/g, '');
      // Only show hint if it starts with what user already typed
      if (!hint.toLowerCase().startsWith(typed.trimStart().toLowerCase())) return;
      hint = stripTypedPrefix(typed, hint);
      if (hint && hint.length > 0) showGhostHint(hint);
    }
  } catch (_) {}
}

/** Strip already-typed text so only the untyped remainder is shown */
function stripTypedPrefix(typed, hint) {
  const t = typed.toLowerCase();
  const h = hint.toLowerCase();
  // Case 1: hint echoes the full input ("ping google.com" when typed "ping goo" → "gle.com")
  if (h.startsWith(t)) return hint.slice(typed.length);
  // Case 2: hint echoes just the last word ("google.com" when typed "ping goo" → "gle.com")
  const lastWord = typed.split(/\s+/).pop() || '';
  if (lastWord && h.startsWith(lastWord.toLowerCase())) return hint.slice(lastWord.length);
  // Case 3: hint is already just the suffix — return as-is
  return hint;
}

function showGhostHint(hint) {
  currentGhostHint = hint;
  ghostHintActive = true;
  if (term) {
    term.write('\x1b[90m' + hint + '\x1b[0m');
    term.write('\x1b[' + hint.length + 'D');
  }
}

function acceptGhostHint() {
  if (!currentGhostHint || !ghostHintActive) return;
  if (term) term.write('\x1b[0K');
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: btoa(currentGhostHint) }));
  }
  inputBuffer += currentGhostHint;
  currentGhostHint = '';
  ghostHintActive = false;
}

function dismissGhostHint() {
  if (ghostHintActive && currentGhostHint && term) {
    term.write('\x1b[0K');
  }
  currentGhostHint = '';
  ghostHintActive = false;
}

// ─── Ask Vainko Popup (Chat-style) ───────────────────────────────────────────

let vainkoConversation = []; // stores { role: 'user'|'assistant', text: string }

function openAskVainko() {
  const popup = document.getElementById('ask-vainko-popup');
  popup.classList.remove('hidden');
  const input = document.getElementById('ask-vainko-input');
  input.value = '';
  input.focus();
  scrollVainkoMessages();
}

function closeAskVainko() {
  document.getElementById('ask-vainko-popup').classList.add('hidden');
}

function scrollVainkoMessages() {
  const container = document.getElementById('ask-vainko-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function renderVainkoMessages() {
  const container = document.getElementById('ask-vainko-messages');
  container.innerHTML = vainkoConversation.map((msg, i) => {
    if (msg.role === 'user') {
      return `<div class="avk-msg avk-msg-user"><div class="avk-bubble avk-bubble-user">${escapeHTML(msg.text)}</div></div>`;
    } else if (msg.role === 'thinking') {
      return `<div class="avk-msg avk-msg-assistant"><div class="avk-bubble avk-bubble-assistant"><span class="avk-thinking"><span>.</span><span>.</span><span>.</span></span></div></div>`;
    } else {
      return `<div class="avk-msg avk-msg-assistant"><div class="avk-bubble avk-bubble-assistant">${formatVainkoResponse(msg.text)}</div></div>`;
    }
  }).join('');
  scrollVainkoMessages();
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatVainkoResponse(text) {
  // Escape HTML first
  let html = escapeHTML(text);
  // Replace [CMD: command] with clickable green chips
  html = html.replace(/\[CMD:\s*(.+?)\]/g, (_, cmd) => {
    const escapedCmd = cmd.trim().replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `<span class="avk-cmd-chip" onclick="insertVainkoCmd('${escapedCmd}')" title="Click to insert into terminal"><code>${cmd.trim()}</code><span class="avk-cmd-insert" title="Insert into terminal">💡</span></span>`;
  });
  // Convert newlines to <br>
  html = html.replace(/\n/g, '<br>');
  return html;
}

function insertVainkoCmd(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    ws.send(JSON.stringify({ type: 'input', sessionId, data: btoa(cmd) }));
  }
  // Brief flash feedback on the chip
  if (term) term.focus();
}

async function submitAskVainko() {
  const input = document.getElementById('ask-vainko-input');
  const prompt = input.value.trim();
  if (!prompt) return;

  // Reject too-short input
  if (prompt.replace(/[^a-zA-Z0-9]/g, '').length < 4) {
    vainkoConversation.push({ role: 'assistant', text: 'Please describe what you want to do, e.g. "list all files" or "create a folder called projects".' });
    renderVainkoMessages();
    return;
  }

  // Add user message & clear input
  vainkoConversation.push({ role: 'user', text: prompt });
  input.value = '';

  // Add thinking indicator
  vainkoConversation.push({ role: 'thinking', text: '' });
  renderVainkoMessages();

  try {
    const res = await fetch('/api/vainko', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65000),
      body: JSON.stringify({ message: prompt, os: currentOS || 'linux', skill: skillLevel || 'beginner' }),
    });
    const data = await res.json();
    // Remove thinking indicator
    vainkoConversation = vainkoConversation.filter(m => m.role !== 'thinking');
    const reply = data.reply || data.text || 'Sorry, I could not generate a response.';
    vainkoConversation.push({ role: 'assistant', text: reply });
    renderVainkoMessages();
  } catch (err) {
    vainkoConversation = vainkoConversation.filter(m => m.role !== 'thinking');
    vainkoConversation.push({ role: 'assistant', text: err.name === 'TimeoutError' ? 'Vainko took too long. Try a shorter question.' : 'Error connecting to Vainko. Is the server running?' });
    renderVainkoMessages();
  }
}

function insertGeneratedCmd(cmd) {
  insertVainkoCmd(cmd);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function endSession() {
  if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
    ws.send(JSON.stringify({ type: 'terminate', sessionId }));
  }
  if (ws) { ws.close(); ws = null; }
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(OS_KEY);
  sessionId = null; currentOS = null;
  if (term) { term.dispose(); term = null; fitAddon = null; }
  inputBuffer = ''; currentGhostHint = ''; ghostHintActive = false;
  closeAskVainko();
  hideOverlay();
  showScreen('picker');
}

// Keep aliases for backward compat
function newSession() { endSession(); }
function terminateSession() { endSession(); }

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}
