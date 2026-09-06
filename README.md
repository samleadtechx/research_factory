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
4. If a source needs custom handling, Codex starts a Camoufox debug browser, opens the real source, inspects links/forms/selectors, and saves the reusable recipe with `create_source_recipe`.
5. If an HTTP API can enrich company or contact data, Codex saves it with `create_enrichment_provider`; API keys stay in environment variables and provider templates reference them as `{env:VAR_NAME}`.
6. If an HTTP API can verify discovered public emails, Codex saves it with `create_email_verification_provider` and maps valid/risky/invalid response values.
7. Browser workers run active source recipes plus web search, then research public company/profile pages.
8. Analysis workers run active enrichment providers, ask Qwen to analyze saved source text into strict claims, verify public emails, and update scores.
9. The deterministic scorer ranks leads with evidence.
10. Monitor campaigns, data providers, and export CSV from the dashboard or MCP.

## MCP

Copy the MCP config and Codex instructions from the dashboard Settings section.

Main tools:

- `create_campaign`
- `create_source_recipe`
- `list_source_recipes`
- `get_source_recipe`
- `activate_source_recipe`
- `disable_source_recipe`
- `create_enrichment_provider`
- `list_enrichment_providers`
- `get_enrichment_provider`
- `activate_enrichment_provider`
- `disable_enrichment_provider`
- `create_email_verification_provider`
- `list_email_verification_providers`
- `get_email_verification_provider`
- `activate_email_verification_provider`
- `disable_email_verification_provider`
- `start_debug_browser`
- `list_debug_browsers`
- `debug_browser_snapshot`
- `debug_browser_open`
- `debug_browser_click`
- `debug_browser_type`
- `debug_browser_extract`
- `debug_browser_screenshot`
- `debug_browser_recipe_draft`
- `close_debug_browser`
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

Postgres and Redis run in Docker. Browser research uses Playwright first.
Source, enrichment, and email verification providers are stored in Postgres and
can be reused by future campaigns. Provider execution history is stored as
provider runs, so bad providers can be disabled without deleting their history.
Camoufox is available for Codex-driven debug browser sessions and can run with
`DEBUG_BROWSER_HEADLESS=virtual` on Linux servers with Xvfb.

Stored campaign documents live under `data/documents`.

Manual Camoufox inspector:

```bash
bash scripts/debug-camoufox.sh https://example.com
```
