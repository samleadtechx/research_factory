# Coolify Deployment

This project is ready to deploy as a Docker Compose application in Coolify.

## Recommended Coolify Setup

Use `docker-compose.coolify.yml` as the Compose file.

Expose only the dashboard service unless you want the API public:

- `dashboard` port `3000`
- `api` port `4000` can stay internal because the dashboard proxies `/api/*`

Set these environment variables in Coolify:

```env
POSTGRES_PASSWORD=change-this-password
LOCAL_LLM_BASE_URL=http://73.72.215.253:11434/v1
LOCAL_LLM_MODEL=qwen2.5:14b
LOCAL_LLM_API_KEY=local
SERVER_USAGE_PERCENT=60
MAX_BROWSERS_HARD_CAP=40
MAX_QWEN_CONCURRENCY=4
MAX_PAGES_PER_LEAD=25
PROXY_RETRY_COUNT=2
```

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

Start with `SERVER_USAGE_PERCENT=40` to `60`, then raise it after watching CPU,
RAM, proxy failure rate, and Qwen latency in the dashboard health section.
