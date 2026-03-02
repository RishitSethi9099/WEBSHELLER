# 🖥️ Sheller - Secure Web Terminal

A secure, localhost-only web-based terminal with whitelisted commands.

## 🔒 Security Features

- **Localhost Only**: Binds exclusively to `127.0.0.1` - not accessible from network
- **Command Whitelist**: Only pre-approved commands can be executed
- **Session Authentication**: Password-protected access with session management
- **Rate Limiting**: 30 requests per minute to prevent abuse
- **Input Sanitization**: All input is validated and sanitized
- **No Shell Injection**: Uses array-based command execution
- **Command Logging**: All command attempts are logged

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open: **http://127.0.0.1:3000**

Default password: `sheller123`

## ⚙️ Configuration

Set the `TERMINAL_PASSWORD` environment variable to change the default password:

```bash
# Windows
set TERMINAL_PASSWORD=mysecretpassword
npm start

# Linux/Mac
TERMINAL_PASSWORD=mysecretpassword npm start
```

## 📋 Available Commands

| Command      | Description                   |
| ------------ | ----------------------------- |
| `ls` / `dir` | List directory contents       |
| `pwd`        | Print working directory       |
| `echo`       | Display a message             |
| `date`       | Show current date/time        |
| `whoami`     | Display current user          |
| `hostname`   | Show system hostname          |
| `ping`       | Ping a host (4 packets)       |
| `ps`         | List running processes        |
| `df`         | Display disk usage            |
| `ipconfig`   | Show network configuration    |
| `env`        | Display environment variables |
| `clear`      | Clear terminal screen         |
| `help`       | Show available commands       |
| `history`    | Show command history          |

## 🚫 Blocked Commands

The following commands are blocked for security:

- File operations: `rm`, `del`, `rmdir`, `format`
- Privilege escalation: `sudo`, `su`, `chmod`, `chown`
- Network tools: `curl`, `wget`, `nc`, `ssh`
- Interpreters: `python`, `node`, `bash`, `powershell`
- System control: `shutdown`, `reboot`, `kill`

## 🛡️ Security Notes

1. **Never expose to the internet** - This is designed for localhost use only
2. Change the default password before use
3. Monitor the command logs for suspicious activity
4. The session expires after 30 minutes of inactivity

## 📁 Project Structure

```
sheller/
├── server.js          # Express backend with security features
├── package.json       # Dependencies and scripts
├── README.md          # This file
└── public/
    ├── index.html     # Terminal UI structure
    ├── styles.css     # Cyberpunk terminal styling
    └── app.js         # Frontend logic
```

## 🔧 Customization

### Adding New Commands

Edit the `COMMAND_WHITELIST` object in `server.js`:

```javascript
'mycommand': {
    cmd: 'actual_command',
    args: ['--flag'],
    allowUserArgs: false,
    description: 'My custom command'
}
```

### Changing the Theme

Modify CSS variables in `public/styles.css`:

```css
:root {
  --terminal-green: #3fb950;
  --terminal-cyan: #58a6ff;
  --bg-primary: #0a0e14;
}
```
