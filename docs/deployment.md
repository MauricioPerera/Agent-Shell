# VPS Deployment Guide

Deploy Agent Shell as an HTTP MCP server on a VPS. Connect from Claude Desktop (or any MCP client) without SSH.

## Architecture

```
Claude Desktop ──HTTPS──→ Nginx (reverse proxy + TLS) ──HTTP──→ Agent Shell (port 3000)
                                                                  ├── 21 skills
                                                                  ├── Vector search
                                                                  ├── Agent profiles
                                                                  └── Bearer token auth
```

## Quick Start (5 minutes)

```bash
# 1. Install Node.js 18+ on VPS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# 2. Clone and install
git clone https://github.com/MauricioPerera/Agent-Shell.git
cd Agent-Shell
npm install
npm run build

# 3. Configure
cp agent-shell.config.example.json agent-shell.config.json
# Edit: change bearerToken to a strong random value
# Generate a token: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Start
node dist/server/index.js
```

## Configuration

### Environment Variables (recommended for production)

```bash
export AGENT_SHELL_PORT=3000
export AGENT_SHELL_HOST=0.0.0.0
export AGENT_SHELL_TOKEN=your-secret-token-here
export AGENT_SHELL_PROFILE=operator
export AGENT_SHELL_CORS_ORIGIN=*
export AGENT_SHELL_ADAPTER=native  # or "just-bash" for sandboxed
```

### Config File

Create `agent-shell.config.json` in the working directory:

```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "auth": {
    "bearerToken": "your-secret-token"
  },
  "agentProfile": "operator",
  "corsOrigin": "*",
  "skills": {
    "cli": true,
    "shell": true
  },
  "shellAdapter": "native"
}
```

Environment variables override config file values.

### Agent Profiles

| Profile | Use case |
|---------|----------|
| `admin` | Full access, dev/testing |
| `operator` | Production agent: CRUD + shell + http |
| `reader` | Read-only: search, describe, read files |
| `restricted` | Only public commands (no permissions) |

## Nginx + HTTPS (Let's Encrypt)

### Install Nginx and Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Configure Nginx

```nginx
# /etc/nginx/sites-available/agent-shell
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/agent-shell /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Enable HTTPS

```bash
sudo certbot --nginx -d your-domain.com
# Certbot auto-renews via systemd timer
```

## systemd Service (Auto-Start)

```ini
# /etc/systemd/system/agent-shell.service
[Unit]
Description=Agent Shell MCP Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/agent-shell
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
RestartSec=5
Environment=AGENT_SHELL_TOKEN=your-secret-token
Environment=AGENT_SHELL_PROFILE=operator
Environment=AGENT_SHELL_PORT=3000
Environment=AGENT_SHELL_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable agent-shell
sudo systemctl start agent-shell
sudo systemctl status agent-shell
# View logs: sudo journalctl -u agent-shell -f
```

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-vps": {
      "url": "https://your-domain.com/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

With HTTP (no TLS, for testing only):

```json
{
  "mcpServers": {
    "my-vps": {
      "url": "http://your-vps-ip:3000/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

## Firewall

```bash
# Allow only SSH + HTTPS (Nginx handles TLS termination)
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw enable

# Do NOT expose port 3000 directly — Nginx proxies it
```

## Security Checklist

- [ ] Strong Bearer token (32+ hex chars)
- [ ] HTTPS via Nginx + Let's Encrypt
- [ ] Firewall blocking port 3000 from public
- [ ] Agent profile set to `operator` or `reader` (not `admin`)
- [ ] `shellAdapter: "just-bash"` for sandboxed execution (optional)
- [ ] Rotate token periodically
- [ ] Monitor logs: `journalctl -u agent-shell -f`

## Testing

```bash
# Health check (no auth required)
curl http://localhost:3000/health

# RPC with auth
curl -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'

# Test tool call
curl -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"cli_help"}}'

# Verify auth works (should return 401)
curl -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
