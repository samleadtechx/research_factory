# AI Lead Research Factory Implementation Plan

## Current Environment Findings

Workspace:

- repository is greenfield except for `.git`
- working directory: `/Users/bizrate/Documents/ChatGPT/Research_factory`

Local toolchain:

- Node.js `v24.14.0`
- npm `11.9.0`
- pnpm `11.19.0`
- Docker `29.4.1`
- Docker Compose available as `docker compose v5.1.3`
- PostgreSQL CLI `18.1`
- Redis CLI/server not installed locally, so Redis should run in Docker

Machine inspected locally:

- macOS Darwin
- 12 CPU threads
- 32 GiB RAM
- no local `nvidia-smi`

LLM endpoint:

- `http://73.72.215.253:11434/v1/models` is reachable
- default model for v1: `qwen2.5:14b`
- endpoint also lists larger Qwen models, so model is configurable

## Build Strategy

Build a real campaign pipeline immediately. Avoid throwaway mock discovery as a
product path. Tests and fixtures are fine, but the production code path should
use the same abstractions that real campaigns will use.

The first milestone is:

```text
Codex prompt through MCP
  -> API creates campaign
  -> campaign planner generates source/scoring plan
  -> browser-first workers research public sources through proxies
  -> Qwen returns structured claims
  -> deterministic scorer ranks leads
  -> dashboard and MCP retrieve ranked leads with compact evidence
  -> CSV export
```

## Phase 1: Foundation

Deliverables:

- `ARCHITECTURE.md`
- `IMPLEMENTATION_PLAN.md`
- pnpm monorepo
- app/package layout
- TypeScript base config
- Docker Compose for Postgres and Redis
- environment example
- shared Zod schemas
- Prisma data model draft
- queue names and payload schemas
- local document store abstraction
- LLM provider abstraction
- resource governor draft
- proxy parser draft

Acceptance:

- repo has stable structure
- environment assumptions are documented
- package scripts are present
- core domain types compile after dependencies are installed

## Phase 2: Vertical Slice

Deliverables:

- Fastify API
- Next.js campaign/stats/settings dashboard
- campaign creation endpoint
- settings endpoint
- proxy upload endpoint
- campaign/job tables
- document/evidence/claim tables
- browser-worker job payloads
- analysis-worker job payloads
- Qwen structured completion wrapper
- deterministic scoring engine
- CSV export route
- MCP server with campaign and lead tools

Browser-first discovery starts with real generic adapters:

- search-result discovery through browser pages
- company website page discovery
- sitemap discovery when available from public website links
- public business profile page extraction where accessible
- public careers/jobs page discovery from company websites

Acceptance:

- user can create a campaign from a prompt
- Codex can create a campaign from a prompt through MCP
- campaign plan is stored
- browser research jobs are queued
- analysis jobs can produce validated claims
- ranked lead rows appear in dashboard
- compact CSV export works

## Phase 3: Browser And Proxy Scaling

Deliverables:

- Camoufox/Playwright worker implementation decision
- browser profile lifecycle
- proxy assignment and retry policy
- proxy health checks
- unhealthy proxy quarantine
- per-domain concurrency
- browser crash recovery
- active browser dashboard view
- source blocked records
- retry with alternate proxy/profile for ordinary browser failures

Acceptance:

- proxy upload supports plain text and CSV
- HTTP and SOCKS5 proxies parse and persist
- campaign concurrency responds to usable proxy count and server usage percent
- blocked/login/CAPTCHA pages are recorded and skipped
- campaign continues after source failures

## Phase 4: Resource Governor

Deliverables:

- Linux command based system probing
- CPU/RAM/GPU metrics
- Qwen latency sampling
- queue backpressure
- concurrency calculator
- global settings page

Settings:

- server usage percent
- max browsers hard cap
- max Qwen concurrency
- max campaign runtime
- max pages per lead
- proxy retry count

Acceptance:

- user sets server usage percent
- system computes safe concurrency
- worker limits change without code edits
- dashboard shows capacity and active limits

## Phase 5: Dynamic Source Recipes

Deliverables:

- source recipe schema
- generated recipe storage
- adapter versioning
- small-sample trial mode
- success/failure scoring
- automatic graduation to reusable adapter
- dashboard view for recipe health

Acceptance:

- Codex/Qwen can create a source recipe from a campaign need
- recipe runs on a small sample
- stable recipe can be reused during the same campaign
- failed recipe is disabled with structured errors

## Phase 6: Audit, Evals, And Quality

Deliverables:

- auto-audit percentage
- validation queue
- Codex audit MCP tools
- eval candidate creation
- eval runner
- prompt versioning
- field-level precision/recall metrics
- contradiction records

Acceptance:

- accepted high-confidence leads can be sampled for audit
- Codex corrections are stored
- corrections can become eval candidates
- prompt/model versions are visible per claim

## Initial Repo Layout

```text
apps/
  api/
  dashboard/
  mcp-server/
  worker-browser/
  worker-analysis/

packages/
  campaign-planner/
  database/
  document-store/
  llm/
  proxy-manager/
  queue/
  resource-governor/
  schemas/
  scoring/
  source-adapters/

config/
prompts/
evals/
data/
docker/
scripts/
tests/
```

## Defaults

```env
LOCAL_LLM_BASE_URL=http://73.72.215.253:11434/v1
LOCAL_LLM_MODEL=qwen2.5:14b
LOCAL_LLM_API_KEY=local
DATABASE_URL=postgresql://leadfactory:leadfactory@localhost:5432/leadfactory
REDIS_URL=redis://localhost:6379
APP_STORAGE_DIR=./data
BROWSER_FIRST=true
SERVER_USAGE_PERCENT=60
MAX_BROWSERS_HARD_CAP=40
```

## Design Risks

Browser-first research is expensive. The resource governor and proxy health
system are therefore core infrastructure, not optional polish.

Generated source adapters are powerful but risky. They must be stored, versioned,
sandboxed or declarative, measured on small samples, and disabled automatically
when quality is poor.

Strict evidence requirements may reduce lead volume. This is intentional for v1:
ranked leads should be trusted more than they are numerous.

## Next Build Step

After Phase 1 scaffolding, implement the API, dashboard shell, Prisma schema,
and queue wiring for campaign creation and status tracking.
