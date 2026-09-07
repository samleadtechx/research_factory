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

1. Set `DATABASE_URL` in the environment.
2. Configure Redis, Qwen, storage, capacity, browser, debug browser, and provider limits in the dashboard Settings panel or with MCP.
3. Upload HTTP/SOCKS5 proxies in the dashboard settings or with the MCP `upload_proxies` tool.
4. Have Codex use the `lead-research-factory` MCP server.
5. Codex creates campaigns with `create_campaign` from any ICP prompt.
6. If a source needs custom handling, Codex starts a Camoufox debug browser, opens the real source, inspects links/forms/selectors, and saves the reusable recipe with `create_source_recipe`.
7. If an HTTP API can enrich company or contact data, Codex saves it with `create_enrichment_provider`.
8. If an HTTP API can verify discovered public emails, Codex saves it with `create_email_verification_provider` and maps valid/risky/invalid response values.
9. Browser workers run active source recipes plus web search, then research public company/profile pages.
10. Analysis workers run active enrichment providers, ask Qwen to analyze saved source text into strict claims, verify public emails, and update scores.
11. The deterministic scorer ranks leads with evidence.
12. Monitor campaigns, data providers, and export CSV from the dashboard or MCP.
13. Export ranked public-email leads to Sendread campaigns or AB test lists after a dry run.

## MCP

Copy the MCP config and Codex instructions from the dashboard Settings section.
For Codex CLI, desktop, and IDE extension, use the remote Streamable HTTP MCP URL
directly. Codex does not need this repo cloned on the same machine:

```toml
[mcp_servers.lead-research-factory]
url = "https://factory.leadtechx.com/api/mcp"
bearer_token_env_var = "LEADFACTORY_MCP_TOKEN"
```

Or add it with the CLI:

```bash
export LEADFACTORY_MCP_TOKEN='paste-your-token-here'
codex mcp add lead-research-factory --url 'https://factory.leadtechx.com/api/mcp' --bearer-token-env-var LEADFACTORY_MCP_TOKEN
```

For clients that expect a stdio command inside a JSON MCP config, use
`mcp-remote`:

```json
{
  "mcpServers": {
    "lead-research-factory": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://factory.leadtechx.com/api/mcp",
        "--header",
        "Authorization:Bearer ${LEADFACTORY_MCP_TOKEN}"
      ],
      "env": {
        "LEADFACTORY_MCP_TOKEN": "paste-your-token-here"
      }
    }
  }
}
```

Set `MCP Token` in the dashboard Runtime Settings panel to require that bearer
token on the remote MCP endpoint. Leave it blank only for private/local testing.

Main tools:

- `get_runtime_settings`
- `update_runtime_settings`
- `create_campaign`
- `import_campaign_csv`
- `list_sendread_campaigns`
- `list_sendread_ab_test_lists`
- `list_sendread_ab_test_list_leads`
- `export_campaign_to_sendread`
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

`DATABASE_URL` is the only required environment variable. Runtime settings are
stored in Postgres and can be edited from the dashboard Settings panel or MCP.
Postgres and Redis run in Docker for local development. The production Dockerfile
defaults to standalone mode, which runs Redis, API, dashboard, and workers in one
container. Browser research uses Playwright first.
Source, enrichment, and email verification providers are stored in Postgres and
can be reused by future campaigns. Provider execution history is stored as
provider runs, so bad providers can be disabled without deleting their history.
Camoufox is available for Codex-driven debug browser sessions and defaults to a
virtual Linux display in Docker.

Stored campaign documents live under `data/documents`.

## Sendread

Set `Sendread URL` and `Sendread API Key` in Runtime Settings. The default URL is
`https://app.sendread.co`. Use the Sendread Export panel or MCP tools to list
destinations, dry-run a campaign export, then push ranked leads with public
emails into a Sendread campaign or AB test list.

Manual Camoufox inspector:

```bash
bash scripts/debug-camoufox.sh https://example.com
```
