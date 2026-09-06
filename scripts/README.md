# Operator Scripts

These scripts work on Linux and macOS.
Only `DATABASE_URL` is required in `.env`; the rest of the runtime settings are
managed in the dashboard Settings panel.

```bash
scripts/install.sh
scripts/start.sh
scripts/status.sh
scripts/restart.sh
scripts/stop.sh
```

The app runs as local background processes. PID files and logs are written to:

```text
.leadfactory/run
.leadfactory/logs
```

Default local URLs:

- dashboard: `http://localhost:3000`
- API: `http://localhost:4000`

Useful options:

```bash
SKIP_DB_PUSH=1 scripts/install.sh
AUTO_DB_PUSH_ON_START=1 scripts/start.sh
STOP_INFRA=1 scripts/stop.sh
```

The MCP server is normally started by Codex over stdio. For manual debugging:

```bash
scripts/start-mcp.sh
```

Open a manual Camoufox inspector window for source/provider debugging:

```bash
scripts/debug-camoufox.sh https://example.com
```
