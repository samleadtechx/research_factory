# AI Lead Research Factory

Generic, prompt-driven lead research factory controlled by Codex through MCP.

## Local Start

```bash
bash scripts/install.sh
bash scripts/start.sh
```

Dashboard: `http://localhost:3000`
API: `http://localhost:4000`

Stop or restart:

```bash
bash scripts/stop.sh
bash scripts/restart.sh
bash scripts/status.sh
```

## Workflow

1. Upload HTTP/SOCKS5 proxies in the dashboard settings or with the MCP `upload_proxies` tool.
2. Have Codex use the `lead-research-factory` MCP server.
3. Codex creates campaigns with `create_campaign` from any ICP prompt.
4. Browser workers discover and research public company/profile pages.
5. Qwen analyzes saved source text into strict claims.
6. The deterministic scorer ranks leads with evidence.
7. Monitor campaigns and export CSV from the dashboard or MCP.

## MCP

Copy the MCP config and Codex instructions from the dashboard Settings section.

Main tools:

- `create_campaign`
- `list_campaigns`
- `get_campaign`
- `pause_campaign`
- `resume_campaign`
- `cancel_campaign`
- `get_leads`
- `get_lead_evidence`
- `export_campaign_csv`
- `upload_proxies`
- `list_proxies`
- `system_stats`
- `system_health`

## Runtime

Postgres and Redis run in Docker. Browser research uses Playwright first, with
Camoufox and Scrapy installed and checked in system health for the next browser
engine/source recipe layer.

Stored campaign documents live under `data/documents`.
