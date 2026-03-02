const express = require("express");
const cors = require("cors");
const path = require("path");
const { Client } = require("ssh2");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// VM Connection details from .env
const VM_CONFIG = {
  host: process.env.VM_HOST,
  port: parseInt(process.env.VM_PORT) || 22,
  username: process.env.VM_USER,
  password: process.env.VM_PASSWORD,
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Command execution endpoint
app.post("/api/execute", async (req, res) => {
  const { command, cwd } = req.body;

  if (!command) {
    return res.status(400).json({ error: "No command provided" });
  }

  // Check if command is restricted
  const [cmd, ...args] = command.trim().split(/\s+/);
  if (!isCommandAllowed(cmd)) {
    return res.status(403).json({
      error: true,
      output: `⛔ Access Denied: Command '${cmd}' is restricted\nType 'help' to see allowed commands.`,
    });
  }

  // Handle local commands (help, clear)
  if (cmd.toLowerCase() === "help") {
    return res.json({
      output: `🔒 RESTRICTED WEBSHELL - Limited Commands Only
════════════════════════════════════════
help              - Show this help message
ls [path]         - List directory contents
nc [host] [port]  - Netcat command
whoami            - Display current user
python3 [args]    - Run Python 3
cd [directory]    - Change directory
pwd               - Print working directory
clear             - Clear terminal screen
════════════════════════════════════════
⚠️  All other commands are RESTRICTED
🔗 Connected to VM: ${VM_CONFIG.host}`,
      className: "info-output",
    });
  }

  if (cmd.toLowerCase() === "clear") {
    return res.json({ output: "", clear: true, html: true });
  }

  // Handle cd command specially - validate and return new path
  if (cmd.toLowerCase() === "cd") {
    const targetDir = args.join(" ") || "~";
    try {
      // Resolve the new path on the VM
      const resolveCmd =
        cwd && cwd !== "~"
          ? `cd "${cwd}" && cd ${targetDir} && pwd`
          : `cd ${targetDir} && pwd`;

      const newPath = await executeOnVM(resolveCmd);
      const cleanPath = newPath.trim();

      if (cleanPath) {
        return res.json({
          output: "",
          newCwd: cleanPath,
        });
      } else {
        return res.json({
          error: true,
          output: `cd: ${targetDir}: No such file or directory`,
        });
      }
    } catch (error) {
      return res.json({
        error: true,
        output: `cd: ${targetDir}: No such file or directory`,
      });
    }
  }

  // Execute command on VM via SSH with working directory
  try {
    // Prepend cd to the working directory if set
    let fullCommand = command.trim();
    if (cwd && cwd !== "~") {
      fullCommand = `cd "${cwd}" && ${fullCommand}`;
    }

    const output = await executeOnVM(fullCommand);
    res.json({ output });
  } catch (error) {
    res.status(500).json({
      error: true,
      output: `SSH Connection Error: ${error.message}\n\nVM: ${VM_CONFIG.host}:${VM_CONFIG.port}\nUser: ${VM_CONFIG.username}`,
    });
  }
});

// ── VAINKO OLLAMA PROXY ──
// Proxies Ollama API calls from the browser
app.post("/api/vainko", async (req, res) => {
  try {
    let systemPrompt = req.body.system_instruction?.parts?.[0]?.text || '';
    let userMessage = req.body.contents?.slice(-1)?.[0]?.parts?.[0]?.text || req.body.message || '';

    const ollamaRes = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2',
        stream: false,
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
    res.status(500).json({ error: `Ollama proxy error: ${err.message}`, reply: 'Could not connect to Ollama.' });
  }
});

// Serve index.html for root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     WebShell Server is Running!        ║
╚════════════════════════════════════════╝

🚀 Server started on: http://localhost:${PORT}
📁 Serving files from: ./public
🔧 API endpoint: /api/execute
🔗 SSH Target: ${VM_CONFIG.username}@${VM_CONFIG.host}:${VM_CONFIG.port}

Press Ctrl+C to stop the server
    `);
});

// Check if command is in allowed list
const ALLOWED_COMMANDS = [
  "help",
  "ls",
  "nc",
  "whoami",
  "python3",
  "cd",
  "clear",
  "pwd",
];

function isCommandAllowed(cmd) {
  if (!cmd || cmd === "") return true;
  return ALLOWED_COMMANDS.includes(cmd.toLowerCase());
}

// Execute command on VM via SSH
function executeOnVM(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let errorOutput = "";

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          stream
            .on("close", (code, signal) => {
              conn.end();
              const result =
                output ||
                errorOutput ||
                `Command executed (exit code: ${code})`;
              resolve(result);
            })
            .on("data", (data) => {
              output += data.toString();
            })
            .stderr.on("data", (data) => {
              errorOutput += data.toString();
            });
        });
      })
      .on("error", (err) => {
        reject(new Error(`SSH Error: ${err.message}`));
      })
      .connect(VM_CONFIG);

    // Timeout after 30 seconds
    setTimeout(() => {
      conn.end();
      if (!output && !errorOutput) {
        reject(new Error("Command timeout"));
      }
    }, 30000);
  });
}

module.exports = app;
