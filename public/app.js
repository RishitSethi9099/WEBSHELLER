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

// ─── Vainko Chat Overlay ──────────────────────────────────────────────────────

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

  const LESSONS = {
    navigation: {
      title: 'Navigation', desc: 'Move around the filesystem with confidence',
      difficulty: 'beginner', time: '~8 min',
      steps: [
        { title: 'Understanding the filesystem structure', desc: 'The Linux directory tree and how it is organized' },
        { title: 'Moving between directories with cd', desc: 'Change your current working directory' },
        { title: 'Listing contents with ls and flags', desc: 'View files and directories with useful options' },
        { title: 'Understanding absolute vs relative paths', desc: 'Two ways to reference any location on disk' },
        { title: 'Using pwd and tab completion', desc: 'Know where you are and type less' },
      ]
    },
    permissions: {
      title: 'Permissions', desc: 'Control who can read, write, and execute files',
      difficulty: 'beginner', time: '~10 min',
      steps: [
        { title: 'Understanding rwx notation', desc: 'The three permission types and what they mean' },
        { title: 'Reading permission strings', desc: 'Decode the output of ls -l' },
        { title: 'Using chmod with numbers', desc: 'Set permissions using octal notation' },
        { title: 'Using chmod with symbols', desc: 'Add or remove permissions with u/g/o and +/-' },
        { title: 'Changing ownership with chown', desc: 'Transfer file ownership between users and groups' },
      ]
    },
    networking: {
      title: 'Networking', desc: 'Inspect and troubleshoot network connections',
      difficulty: 'intermediate', time: '~12 min',
      steps: [
        { title: 'Checking your IP with ip addr', desc: 'View your network interfaces and addresses' },
        { title: 'Testing connectivity with ping', desc: 'Verify if a host is reachable' },
        { title: 'Scanning with nmap basics', desc: 'Discover open ports on a target' },
        { title: 'Checking open ports with netstat', desc: 'See which services are listening locally' },
        { title: 'Transferring files with curl and wget', desc: 'Download files and make HTTP requests' },
      ]
    },
    'kali-tools': {
      title: 'Kali Tools', desc: 'Essential security tools in Kali Linux',
      difficulty: 'intermediate', time: '~15 min',
      steps: [
        { title: 'Nmap port scanning', desc: 'Scan targets for open ports and services' },
        { title: 'Nikto web scanner', desc: 'Check web servers for common vulnerabilities' },
        { title: 'John the Ripper basics', desc: 'Crack password hashes offline' },
        { title: 'Hydra brute force', desc: 'Test login credentials against services' },
        { title: 'Dirb directory enumeration', desc: 'Discover hidden directories on web servers' },
      ]
    },
    scripting: {
      title: 'Scripting', desc: 'Automate tasks with bash scripts',
      difficulty: 'intermediate', time: '~12 min',
      steps: [
        { title: 'Writing your first bash script', desc: 'Create and run a .sh file from scratch' },
        { title: 'Variables and input', desc: 'Store values and read user input' },
        { title: 'Conditionals with if/else', desc: 'Make decisions in your scripts' },
        { title: 'Loops with for and while', desc: 'Repeat actions over lists or conditions' },
        { title: 'Making scripts executable', desc: 'Use chmod and shebangs correctly' },
      ]
    },
    packages: {
      title: 'Package Management', desc: 'Install, update, and remove software',
      difficulty: 'beginner', time: '~8 min',
      steps: [
        { title: 'Understanding apt', desc: 'The default package manager on Debian-based systems' },
        { title: 'Updating package lists', desc: 'Keep your package index current' },
        { title: 'Installing and removing packages', desc: 'Add and remove software from the system' },
        { title: 'Searching for packages', desc: 'Find packages by name or description' },
        { title: 'Understanding dpkg', desc: 'Work with .deb packages directly' },
      ]
    }
  };

  // Store on window for access by helper functions
  window._vainkoLessons = LESSONS;
  window._vainkoActiveLesson = null;
  window._vainkoActiveStep = 0;
  window._vainkoCompleted = {};

  // Build lesson cards HTML
  let lessonCardsHtml = '';
  for (const [id, lesson] of Object.entries(LESSONS)) {
    const diffLabel = lesson.difficulty === 'beginner' ? 'Beginner' : 'Intermediate';
    lessonCardsHtml += '<div class="v-lesson-card" data-lesson-id="' + id + '" onclick="selectVainkoLesson(\'' + id + '\')">' +
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
    '<section class="v-steps-panel" id="v-steps-panel">' +
      '<div class="v-steps-header">' +
        '<div class="v-steps-title" id="v-steps-title"></div>' +
        '<div class="v-steps-progress"><div class="v-steps-progress-fill" id="v-steps-progress-fill"></div></div>' +
        '<div class="v-steps-progress-label" id="v-steps-progress-label">0 / 0 steps</div>' +
      '</div>' +
      '<div class="v-steps-list" id="v-steps-list"></div>' +
      '<div class="v-lesson-complete" id="v-lesson-complete">' +
        '<div class="v-lesson-complete-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" fill="none" stroke="#7c3aed" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline></svg></div>' +
        '<div class="v-lesson-complete-text">Lesson Complete</div>' +
        '<div class="v-lesson-complete-sub">All steps finished. Pick another lesson or keep exploring.</div>' +
      '</div>' +
      '<div class="v-steps-footer" id="v-steps-footer">' +
        '<button class="v-ask-step-btn" onclick="askVainkoAboutStep()">Ask Vainko about this step</button>' +
      '</div>' +
    '</section>' +
    '<main class="v-chat-column">' +
      '<div class="v-chat-topbar">' +
        '<div class="v-chat-topbar-left">' +
          '<button class="v-back-link" onclick="closeVainkoChat()">&larr; Back</button>' +
          '<span class="v-chat-wordmark">Vainko</span>' +
        '</div>' +
        '<span class="v-skill-pill ' + skill + '">' + skillLabel + '</span>' +
      '</div>' +
      '<div class="v-chat-messages" id="vainko-messages"></div>' +
      '<div class="v-chat-inputbar">' +
        '<input type="text" id="vainko-input" placeholder="Ask Vainko..." onkeydown="if(event.key===\'Enter\')sendVainkoMessage()" />' +
        '<button onclick="sendVainkoMessage()">Send</button>' +
      '</div>' +
    '</main>';

  appendVainkoMessage('assistant', 'Select a lesson from the sidebar, or ask a question directly.');
}

function selectVainkoLesson(id) {
  const LESSONS = window._vainkoLessons;
  if (!LESSONS || !LESSONS[id]) return;
  window._vainkoActiveLesson = id;
  window._vainkoActiveStep = 0;
  if (!window._vainkoCompleted[id]) window._vainkoCompleted[id] = new Set();

  document.querySelectorAll('.v-lesson-card').forEach(function(c) { c.classList.remove('active'); });
  var card = document.querySelector('.v-lesson-card[data-lesson-id="' + id + '"]');
  if (card) card.classList.add('active');

  document.getElementById('v-steps-panel').classList.add('visible');
  renderVainkoSteps();
}

function renderVainkoSteps() {
  var LESSONS = window._vainkoLessons;
  var id = window._vainkoActiveLesson;
  if (!LESSONS || !id) return;
  var lesson = LESSONS[id];
  var done = window._vainkoCompleted[id] || new Set();
  var total = lesson.steps.length;
  var doneCount = done.size;

  document.getElementById('v-steps-title').textContent = lesson.title;
  document.getElementById('v-steps-progress-fill').style.width = ((doneCount / total) * 100) + '%';
  document.getElementById('v-steps-progress-label').textContent = doneCount + ' / ' + total + ' steps';

  var completeEl = document.getElementById('v-lesson-complete');
  var listEl = document.getElementById('v-steps-list');
  var footerEl = document.getElementById('v-steps-footer');

  if (doneCount === total) {
    completeEl.classList.add('visible');
    listEl.style.display = 'none';
    footerEl.style.display = 'none';
    return;
  } else {
    completeEl.classList.remove('visible');
    listEl.style.display = 'flex';
    footerEl.style.display = 'block';
  }

  listEl.innerHTML = '';
  lesson.steps.forEach(function(step, i) {
    var item = document.createElement('div');
    var isDone = done.has(i);
    var isActive = i === window._vainkoActiveStep && !isDone;
    item.className = 'v-step-item' + (isDone ? ' done' : '') + (isActive ? ' active' : '');
    item.onclick = function() { clickVainkoStep(i); };
    item.innerHTML = '<div class="v-step-checkbox"></div>' +
      '<div class="v-step-content">' +
        '<div class="v-step-title">' + (i + 1) + '. ' + step.title + '</div>' +
        '<div class="v-step-desc">' + step.desc + '</div>' +
      '</div>';
    listEl.appendChild(item);
  });
}

function clickVainkoStep(index) {
  var LESSONS = window._vainkoLessons;
  var id = window._vainkoActiveLesson;
  if (!LESSONS || !id) return;
  window._vainkoActiveStep = index;
  var lesson = LESSONS[id];
  var step = lesson.steps[index];

  if (!window._vainkoCompleted[id]) window._vainkoCompleted[id] = new Set();
  window._vainkoCompleted[id].add(index);
  renderVainkoSteps();

  var msg = "I'm on step " + (index + 1) + " of " + lesson.title + ": " + step.title + ". Teach me this.";
  appendVainkoMessage('user', msg);
  sendVainkoToApi(msg);
}

function askVainkoAboutStep() {
  if (!window._vainkoActiveLesson) return;
  clickVainkoStep(window._vainkoActiveStep);
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

// startVainkoLesson is replaced by selectVainkoLesson above

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
