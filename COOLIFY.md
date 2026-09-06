# Coolify Deployment

This project is ready to deploy as a Docker Compose application in Coolify.

## Recommended Coolify Setup

Use `docker-compose.coolify.yml` as the Compose file.

Expose only the dashboard service unless you want the API public:

- `dashboard` port `3000`
- `api` port `4000` can stay internal because the dashboard proxies `/api/*`

Create or attach a Postgres database in Coolify, then set this environment
variable on the application:

```env
DATABASE_URL=postgresql://...
```

Runtime values such as Redis URL, local LLM endpoint/model, storage path, server
usage percent, browser cap, Qwen concurrency, campaign timeouts, page limits, and
retry counts are managed from the dashboard Settings panel or through the MCP
tools.

The API container runs Prisma migrations automatically on boot:

```env
APP_ROLE=api
RUN_MIGRATIONS=auto
```

Workers and dashboard set `RUN_MIGRATIONS=0`, so they do not race the API
container for schema migration locks.

## Roles

The single Docker image supports these roles with `APP_ROLE`:

- `api`
- `dashboard`
- `worker-browser`
- `worker-analysis`
- `mcp`
- `migrate`

For Coolify Compose, the included services already set the correct role.

## Camoufox

Camoufox is installed into the image with:

```bash
pip install -r requirements-browser.txt
python -m camoufox fetch
```

The image also runs:

```bash
playwright install-deps chromium firefox
```

That installs the Linux libraries needed by Playwright Chromium and
Firefox-style browser runtimes. Browser binaries are fetched at image build time,
not at campaign runtime.

The current worker uses Playwright Chromium for active scraping. Camoufox is
installed and health-checked so we can switch the browser engine or add a
Camoufox-specific worker path later without rebuilding the deployment model.

For browser stability at scale, keep this on the browser worker service:

```yaml
shm_size: "2gb"
ulimits:
  nofile:
    soft: 65535
    hard: 65535
```

Start with server usage at `40` to `60` percent in the dashboard Settings panel,
then raise it after watching CPU, RAM, proxy failure rate, and Qwen latency in
the dashboard health section.
