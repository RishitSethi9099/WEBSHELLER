/**
 * Sheller — Cloud Terminal Platform
 *
 * Features:
 * - OS picker (Kali Linux, Ubuntu, PowerShell)
 * - Isolated Docker containers per user session
 * - Real-time terminal via WebSockets
 * - Full root access inside containers
 * - Persistent Docker volumes per session
 * - Auto-cleanup after 15 min inactivity
 * - Resource limits: 512 MB RAM, 1 CPU per container
 */

require('dotenv').config();

const express = require("express");
const http    = require("http");
const WebSocket = require("ws");
const Docker  = require("dockerode");
const path    = require("path");
const { Readable } = require("stream");
const { v4: uuidv4 } = require("uuid");

// ─── Constants ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// --- Custom image definitions ------------------------------------------------
// We build lean custom images once at startup so every container launch is
// instant � no apt-get at runtime ever.

const CUSTOM_IMAGES = {
  "sheller-kali": {
    baseImage: "kalilinux/kali-rolling",
    dockerfile: `FROM kalilinux/kali-rolling
ENV DEBIAN_FRONTEND=noninteractive TERM=xterm-256color HOME=/root
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
    bash coreutils procps iproute2 iputils-ping net-tools \\
    curl wget dnsutils sudo python3 vim nano whois \\
    nmap netcat-openbsd less file unzip git openssh-client
# Keep apt lists so apt install works instantly — refresh in background on startup
RUN printf '#!/bin/bash\\napt-get update -qq &>/dev/null &\\nexec "$@"\\n' > /usr/local/bin/entrypoint.sh \\
    && chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
WORKDIR /root
CMD ["/bin/bash", "-i"]
`,
  },
  "sheller-ubuntu": {
    baseImage: "ubuntu:latest",
    dockerfile: `FROM ubuntu:latest
ENV DEBIAN_FRONTEND=noninteractive TERM=xterm-256color HOME=/root
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
    bash coreutils procps iproute2 iputils-ping net-tools \\
    curl wget dnsutils sudo python3 vim nano \\
    less file unzip git openssh-client
RUN printf '#!/bin/bash\\napt-get update -qq &>/dev/null &\\nexec "$@"\\n' > /usr/local/bin/entrypoint.sh \\
    && chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
WORKDIR /root
CMD ["/bin/bash", "-i"]
`,
  },
  "sheller-powershell": {
    baseImage: "mcr.microsoft.com/powershell",
    dockerfile: `FROM mcr.microsoft.com/powershell
ENV DEBIAN_FRONTEND=noninteractive TERM=xterm-256color HOME=/root POWERSHELL_TELEMETRY_OPTOUT=1
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
    coreutils procps iproute2 iputils-ping net-tools \\
    curl wget dnsutils traceroute sudo python3 vim nano \\
    nmap netcat-openbsd less file unzip git openssh-client whois
# Windows command aliases so familiar commands just work
RUN ln -s /usr/bin/traceroute /usr/local/bin/tracert \\
    && ln -s /usr/bin/python3 /usr/local/bin/python \\
    && printf '#!/bin/sh\\nip addr show\\n' > /usr/local/bin/ipconfig && chmod +x /usr/local/bin/ipconfig \\
    && printf '#!/bin/sh\\ncat /etc/resolv.conf\\n' > /usr/local/bin/systeminfo && chmod +x /usr/local/bin/systeminfo
# PowerShell profile with extra aliases
RUN mkdir -p /root/.config/powershell \\
    && printf 'Set-Alias -Name tracert -Value traceroute -Option AllScope\\nSet-Alias -Name ifconfig -Value ip -Option AllScope\\n' > /root/.config/powershell/Microsoft.PowerShell_profile.ps1
WORKDIR /root
CMD ["pwsh", "-NoLogo", "-NoProfile"]
`,
  },
};

const OS_CONFIG = {
  kali: {
    image:   "sheller-kali",
    shell:   ["/bin/bash", "-i"],
    name:    "Kali Linux",
    workdir: "/root",
  },
  ubuntu: {
    image:   "sheller-ubuntu",
    shell:   ["/bin/bash", "-i"],
    name:    "Ubuntu",
    workdir: "/root",
  },
  powershell: {
    image:   "sheller-powershell",
    shell:   ["/bin/sh", "-c", "stty -echo 2>/dev/null; exec pwsh -NoLogo"],
    name:    "PowerShell",
    workdir: "/root",
    env:     ["TERM=xterm-256color", "HOME=/root", "POWERSHELL_TELEMETRY_OPTOUT=1"],
  },
};

const INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes

// ─── App + WebSocket setup ───────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });
const docker = new Docker();

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- Auth routes (local SQLite) -----------------------------------------------
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// --- Config endpoint ---------------------------------------------------------
// Tells the frontend which auth mode is active.
app.get("/api/config", (_req, res) => {
  res.json({ authMode: "local" });
});


// ─── Session store ───────────────────────────────────────────────────────────
// sessionId → { container, stream, ws, os, timer, lastActivity }
const sessions = new Map();

// --- Image builder ------------------------------------------------------------
// Builds sheller-kali / sheller-ubuntu once at startup with all tools baked in.
// Uses tar-stream to pack an inline Dockerfile into the build context.

async function buildImage(tag, dockerfileContent) {
  const tarStream = require("tar-stream");
  const pack = tarStream.pack();
  pack.entry({ name: "Dockerfile" }, dockerfileContent);
  pack.finalize();
  return new Promise((resolve, reject) => {
    docker.buildImage(pack, { t: tag, forcerm: true }, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream,
        (err2, output) => {
          if (err2) return reject(err2);
          const errLine = output && output.find(o => o.error);
          if (errLine) return reject(new Error(errLine.error));
          resolve();
        },
        (event) => { if (event.stream) process.stdout.write(`[build:${tag}] ${event.stream}`); }
      );
    });
  });
}

async function ensureCustomImages() {
  for (const [tag, cfg] of Object.entries(CUSTOM_IMAGES)) {
    try {
      await docker.getImage(tag).inspect();
      console.log(`[image] ${tag} � already built`);
    } catch (_) {
      console.log(`[image] building ${tag} (this takes ~1�2 min, once ever)�`);
      try {
        await buildImage(tag, cfg.dockerfile);
        console.log(`[image] ${tag} ready`);
      } catch (e) {
        console.error(`[image] FAILED to build ${tag}: ${e.message}`);
      }
    }
  }
}

// ─── Session helpers ─────────────────────────────────────────────────────────

async function destroySession(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  clearTimeout(sess.timer);
  sessions.delete(sessionId);
  try { sess.stream.destroy(); } catch (_) {}
  try { await sess.container.stop({ t: 3 }); } catch (_) {}
  try { await sess.container.remove({ force: true }); } catch (_) {}
  console.log(`[session] destroyed: ${sessionId}`);
}

function resetInactivityTimer(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  clearTimeout(sess.timer);
  sess.lastActivity = Date.now();
  sess.timer = setTimeout(async () => {
    console.log(`[session] inactivity timeout: ${sessionId}`);
    const s = sessions.get(sessionId);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      wsSend(s.ws, { type: "timeout", message: "Session expired (1 hour inactivity). Refresh to start a new one." });
    }
    await destroySession(sessionId);
  }, INACTIVITY_MS);
}

function wsSend(ws, obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Strip Docker attach stream 8-byte header: [stream_type, 0, 0, 0, size_bytes x4]
function stripDockerHeader(data) {
  if (data.length > 8 && (data[0] === 1 || data[0] === 2)) {
    return data.slice(8);
  }
  return data;
}

// Pull image if not already present locally
function pullImage(image, onProgress) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream,
        (err2) => err2 ? reject(err2) : resolve(),
        (event) => { if (onProgress && event.status) onProgress(event.status); }
      );
    });
  });
}

// Check if image exists locally
async function imageExists(image) {
  try { await docker.getImage(image).inspect(); return true; }
  catch (_) { return false; }
}

// Run an exec inside a container and await its completion
function runExec(container, cmd) {
  return new Promise(async (resolve, reject) => {
    try {
      const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      // drain stream so the exec actually runs to completion
      stream.resume();
      stream.on("end",   resolve);
      stream.on("error", reject);
    } catch (e) { reject(e); }
  });
}

// ─── WebSocket server ────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  let boundSessionId = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── init: create or resume a container session ─────────────────────────
      case "init": {
        const { sessionId, os, token } = msg;
        if (!sessionId || !OS_CONFIG[os]) {
          wsSend(ws, { type: "error", message: "Invalid session ID or OS selection." });
          return;
        }
        boundSessionId = sessionId;
        const cfg = OS_CONFIG[os];

        // -- Resolve userId from JWT (volume is keyed to user+OS) ----
        let userId = sessionId; // fallback: old per-session behaviour
        if (token) {
          try {
            const decoded = authRoutes.verifyToken(token);
            if (decoded && decoded.id) userId = String(decoded.id);
          } catch (_) { /* keep sessionId fallback */ }
        }

        // ── Reconnect to existing session ──────────────────────────────────
        if (sessions.has(sessionId)) {
          const existing = sessions.get(sessionId);
          existing.ws = ws;
          existing.stream.removeAllListeners("data");
          existing.stream.on("data", (chunk) => {
            wsSend(existing.ws, { type: "output", data: Buffer.from(chunk).toString("base64") });
          });
          resetInactivityTimer(sessionId);
          wsSend(ws, {
            type: "ready", sessionId, os, osName: cfg.name,
          });
          console.log(`[session] reconnected: ${sessionId} (${cfg.name})`);
          return;
        }

        // ── Spin up a new container ────────────────────────────────────────
        wsSend(ws, { type: "status", message: `Starting ${cfg.name} container�` });

        try {
          // Quick Docker health check — fail fast if daemon is not reachable
          try { await docker.ping(); } catch {
            wsSend(ws, { type: 'error', message: 'Docker is not running. Please start Docker Desktop.' });
            return;
          }

          // Build or pull image if missing
          if (!(await imageExists(cfg.image))) {
            if (CUSTOM_IMAGES[cfg.image]) {
              // Custom image — build it inline (not on Docker Hub)
              wsSend(ws, { type: "status", message: `Building ${cfg.image} image — this takes 1–2 min (first time only)…` });
              try {
                await buildImage(cfg.image, CUSTOM_IMAGES[cfg.image].dockerfile);
                wsSend(ws, { type: "status", message: `Image ready. Starting container…` });
              } catch (buildErr) {
                wsSend(ws, { type: "error", message: `Failed to build ${cfg.image}: ${buildErr.message}` });
                return;
              }
            } else {
              // Third-party image — pull from registry
              wsSend(ws, { type: "status", message: `Pulling ${cfg.image} — this may take a minute…` });
              await pullImage(cfg.image, (status) => {
                wsSend(ws, { type: "status", message: status });
              });
              wsSend(ws, { type: "status", message: `Image ready. Starting container…` });
            }
          }

          // Ensure persistent volume exists
          // Volume named after user+OS so installed tools survive across sessions
          const volName = `sheller_${userId}_${os}`;
          try { await docker.getVolume(volName).inspect(); }
          catch (_) { await docker.createVolume({ Name: volName }); }

          // ── Capacity check ──────────────────────────────────────────────
          if (sessions.size >= 10) {
            wsSend(ws, { type: 'error', message: 'Server is at capacity. Please try again in a few minutes.' });
            return;
          }

          const container = await docker.createContainer({
            Image: cfg.image,
            Cmd:   cfg.shell,
            Tty:         true,
            OpenStdin:   true,
            StdinOnce:   false,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Labels:      { 'sheller': 'true', 'session': sessionId },
            Env:        cfg.env || ["TERM=xterm-256color", "HOME=/root", "DEBIAN_FRONTEND=noninteractive"],
            WorkingDir: cfg.workdir,
            HostConfig: {
              Memory:    512 * 1024 * 1024,
              CpuPeriod: 100000,
              CpuQuota:  100000,
              Binds:     [`${volName}:/root/workspace`],
              NetworkMode: "bridge",
            },
          });

          // IMPORTANT: attach BEFORE start so bash never sees EOF on stdin
          const stream = await container.attach({
            stream:      true,
            stdin:       true,
            stdout:      true,
            stderr:      true,
            hijack:      true,
          });

          await container.start();
          if (os === 'powershell') await container.resize({ h: 50, w: 220 });

          console.log(`[session] container started: ${sessionId} (${cfg.name})`);

          const sessData = { container, stream, ws, os, lastActivity: Date.now(), timer: null, stripCount: 0 };
          sessions.set(sessionId, sessData);
          resetInactivityTimer(sessionId);

          // Stream Docker output → browser
          stream.on("data", (chunk) => {
            const s = sessions.get(sessionId);
            if (!s) return;

            // Strip Docker attach 8-byte stream header
            let data = Buffer.from(chunk);
            data = stripDockerHeader(data);
            if (data.length === 0) return;

            // Check first 5 chunks for the handshake JSON blob
            if (s.stripCount < 5) {
              s.stripCount++;
              let text = data.toString("utf8");
              if (text.includes('"hijack"') && text.includes('"stream"')) {
                const idx = text.indexOf('{"stream"');
                const endIdx = text.indexOf('}', idx);
                if (idx !== -1 && endIdx !== -1) {
                  text = text.substring(0, idx) + text.substring(endIdx + 1);
                  text = text.replace(/[\x00-\x08\x0E-\x1A]/g, "").trim();
                }
                if (text.length === 0) return;
                wsSend(s.ws, { type: "output", data: Buffer.from(text).toString("base64") });
                return;
              }
            }

            wsSend(s.ws, { type: "output", data: data.toString("base64") });
          });

          stream.on("error", (err) => {
            console.error(`[stream error] ${sessionId}:`, err.message);
          });

          stream.on("close", async () => {
            console.log(`[stream close] ${sessionId}`);
            const s = sessions.get(sessionId);
            if (s) wsSend(s.ws, { type: "closed", message: "Container shell exited." });
            await destroySession(sessionId);
          });

          wsSend(ws, {
            type: "ready", sessionId, os, osName: cfg.name,
          });

        } catch (err) {
          console.error(`[init error] ${sessionId}:`, err.message);
          wsSend(ws, { type: "error", message: `Failed to start container: ${err.message}` });
        }
        break;
      }

      // ── input: browser → container ─────────────────────────────────────────
      case "input": {
        const sess = sessions.get(msg.sessionId);
        if (!sess) return;
        resetInactivityTimer(msg.sessionId);
        try { sess.stream.write(Buffer.from(msg.data, "base64")); } catch (_) {}
        break;
      }

      // ── resize: terminal resize event ──────────────────────────────────────
      case "resize": {
        const sess = sessions.get(msg.sessionId);
        if (!sess) return;
        try { await sess.container.resize({ h: msg.rows || 24, w: msg.cols || 80 }); } catch (_) {}
        break;
      }

      // ── terminate: user explicitly kills session ────────────────────────────
      case "terminate": {
        await destroySession(msg.sessionId);
        break;
      }
    }
  });

  ws.on("close", () => {
    // Container keeps running; inactivity timer will clean it up.
    console.log(`[ws] disconnected${boundSessionId ? ` (${boundSessionId})` : ""}`);
  });

  ws.on("error", (err) => console.error("[ws error]", err.message));
});

// ─── REST helpers ─────────────────────────────────────────────────────────────

// Check whether a session is still alive (used by frontend on reconnect)
app.get("/api/session/:id", (req, res) => {
  const sess = sessions.get(req.params.id);
  if (sess) {
    const cfg = OS_CONFIG[sess.os] || {};
    res.json({
      active: true, os: sess.os, osName: cfg.name, lastActivity: sess.lastActivity,
    });
  } else {
    res.json({ active: false });
  }
});

// ─── Vainko — Ollama-powered AI trainer (local, free, no API key) ─────────────
const OLLAMA_MODEL = 'llama3.2:1b';   // change to 'llama3.2' (3B) for better quality
const OLLAMA_TIMEOUT = 60_000; // 60 seconds max for any Ollama request

// Chat endpoint — accepts { message, os, skill } or raw { contents, system_instruction }
app.post("/api/vainko", async (req, res) => {
  try {
    let systemPrompt, userMessage;

    if (req.body.message) {
      const { message, os = 'Linux', skill = 'beginner' } = req.body;
      systemPrompt = `You are VAINKO, a chill terminal coach. Rules:
- MAX 2-3 short sentences
- Always explain what the user's command does (even if wrong for this task)
- Then explain the correct command briefly
- Wrap commands in [CMD: command] format
- Be casual, not textbook-y
- Example: "ls lists files, but you need [CMD: pwd] to see your current directory."
OS: ${os}, skill: ${skill}`;
      userMessage = message;
    } else {
      // Raw format from vainko.html
      systemPrompt = req.body.system_instruction?.parts?.[0]?.text || '';
      userMessage = req.body.contents?.slice(-1)?.[0]?.parts?.[0]?.text || '';
    }

    const ollamaRes = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { num_predict: 100, temperature: 0.4 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!ollamaRes.ok) {
      const err = await ollamaRes.text();
      return res.status(500).json({ error: `Ollama error: ${err}`, reply: 'Ollama is not running. Start it with: ollama serve' });
    }

    const data = await ollamaRes.json();
    const reply = data.message?.content || 'No response from Ollama.';
    res.json({ reply });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'Vainko took too long to respond. Try a shorter question.'
              : 'Could not connect to Ollama. Make sure it is running: ollama serve';
    res.status(500).json({
      error: err.message,
      reply: msg
    });
  }
});

// Ghost hint — fast, short command completion
app.get('/api/vainko-hint', async (req, res) => {
  const { cmd, os, skill } = req.query;
  if (!cmd || cmd.length < 2) return res.json({ hint: '' });
  try {
    const ollamaRes = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { num_predict: 30, temperature: 0.1 },
        messages: [
          { role: 'system', content: `You are a ${os || 'Linux'} terminal autocomplete engine. Return ONLY one single complete command. No explanation, no markdown, no punctuation, nothing extra. Just the raw command string that completes what the user started typing. If the input is ambiguous or you are unsure, return an empty string.` },
          { role: 'user', content: cmd }
        ]
      })
    });
    const data = await ollamaRes.json();
    const hint = data.message?.content?.trim().split('\n')[0] || '';
    res.json({ hint });
  } catch {
    res.json({ hint: '' });
  }
});

// Natural language → command generator
app.post('/api/vainko-generate', async (req, res) => {
  const { prompt, os, skill } = req.body;
  if (!prompt) return res.json({ command: '', explanation: '' });

  // Reject too-short or meaningless input
  const cleaned = prompt.replace(/[^a-zA-Z0-9]/g, '');
  if (cleaned.length < 4) return res.json({ command: '', explanation: 'Please describe what you want to do in more detail.' });

  try {
    const ollamaRes = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { num_predict: 150, temperature: 0.2 },
        messages: [
          { role: 'system', content: `You are a terminal command helper for ${os || 'Linux'} (skill: ${skill || 'beginner'}). Given a natural language description of what the user wants to do, reply with the exact terminal command and a short explanation. If the user's input is not a meaningful request for a terminal command (e.g. gibberish, greetings, single words like "ok" or "yes"), reply with:
COMMAND: NONE
EXPLANATION: NONE

Otherwise format exactly like:
COMMAND: <the command>
EXPLANATION: <one sentence explanation>` },
          { role: 'user', content: prompt }
        ]
      })
    });
    const data = await ollamaRes.json();
    const raw = data.message?.content?.trim() || '';

    // Try to extract COMMAND: / EXPLANATION: format
    let command = '', explanation = '';
    const cmdMatch = raw.match(/COMMAND:\s*`?(.+?)`?\s*(?:\n|$)/i);
    const expMatch = raw.match(/EXPLANATION:\s*(.+)/i);
    if (cmdMatch) command = cmdMatch[1].trim();
    if (expMatch) explanation = expMatch[1].trim();

    // If model replied NONE, treat as empty
    if (command.toUpperCase() === 'NONE' || command === '') command = '';
    if (explanation.toUpperCase() === 'NONE') explanation = '';

    // Fallback: try JSON parse
    if (!command) {
      try {
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        command = parsed.command || '';
        explanation = parsed.explanation || '';
      } catch (_) {}
    }

    // Fallback: first line that looks like a command (starts with common command word)
    if (!command) {
      const lines = raw.split('\n').map(l => l.replace(/^[`\s*-]+|`+$/g, '').trim()).filter(Boolean);
      const cmdLine = lines.find(l => /^[a-z]/.test(l) && !l.includes('EXPLANATION') && l.length < 200);
      if (cmdLine) {
        command = cmdLine;
        explanation = lines.find(l => l !== cmdLine && l.length > 10) || '';
      }
    }

    res.json({ command, explanation });
  } catch {
    res.json({ command: '', explanation: 'Could not generate command.' });
  }
});

// ─── Startup cleanup ─────────────────────────────────────────────────────────
// Remove any leftover sheller containers from previous runs.
async function cleanupOldContainers() {
  const containers = await docker.listContainers({ all: true });
  for (const c of containers) {
    const name = c.Names?.[0] || '';
    if (c.Labels?.['sheller'] === 'true') {
      const container = docker.getContainer(c.Id);
      try { await container.stop({ t: 1 }); } catch (_) {}
      try { await container.remove({ force: true }); } catch (_) {}
    }
  }
  console.log('[startup] cleaned up old containers');
}

async function checkDocker() {
  try {
    await docker.ping();
    console.log('[docker] connected successfully');
    return true;
  } catch (err) {
    console.error('[docker] WARNING: Docker is not running!');
    console.error('[docker] Terminal sessions will fail until Docker Desktop is started.');
    return false;
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Build custom images first, then start listening.
// No timeout — let builds finish. Server starts even if Docker is down.
ensureCustomImages()
  .then(() => cleanupOldContainers())
  .catch((err) => console.log('[startup] image build skipped:', err.message))
  .then(async () => {
  const dockerOk = await checkDocker();
  server.listen(PORT, () => {
    console.log(`\n  Sheller  ▸  http://localhost:${PORT}${dockerOk ? '' : '  (Docker not running — terminal sessions unavailable)'}\n`);
  });
});

process.on("SIGINT", async () => {
  console.log("\n[shutdown] cleaning up containers...");
  for (const id of sessions.keys()) await destroySession(id);
  process.exit(0);
});
