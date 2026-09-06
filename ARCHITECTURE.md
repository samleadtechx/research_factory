# AI Lead Research Factory Architecture

## Product Shape

This system is a generic, prompt-driven lead generation research factory.

The user supplies:

- a campaign prompt
- proxy inventory
- desired server usage percentage

The system produces:

- ranked leads
- strict evidence for every important claim
- dashboard progress and exports
- MCP tools so Codex can supervise, pause, resume, audit, and inspect results

The system is not specific to RingPort or restoration companies. Restoration can be a campaign, but the durable primitive is a campaign generated from a user prompt.

## Core Principle

The product contract is:

```text
Prompt in
  -> campaign plan
  -> browser/proxy research
  -> Qwen structured analysis
  -> deterministic scoring
  -> ranked leads with evidence
```

No important factual claim is accepted without stored evidence. Unknown is better than guessed.

## Main Services

```text
apps/api
  Fastify control API. Owns campaign creation, settings, queue orchestration,
  exports, and dashboard APIs.

apps/dashboard
  Next.js dashboard. Used for campaign lists, stats, proxy upload, settings,
  live campaign progress, browser/proxy health, lead tables, CSV export, and
  pause/resume/cancel controls. Campaigns are normally created by Codex through
  MCP, not by a dashboard prompt form.

apps/mcp-server
Codex-facing MCP server with high-level tools. Codex supervises campaigns
through MCP while workers control browsers and queues.

apps/worker-browser
  Browser-first discovery and research worker. Uses proxies, browser profiles,
  per-domain limits, failure recording, and source adapter recipes.

apps/worker-analysis
  Qwen extraction, classification, campaign planning assistance, lead scoring,
  evidence linking, cross-validation, and export preparation.
```

## Shared Packages

```text
packages/database
  Prisma schema and database client.

packages/schemas
  Zod schemas shared across apps, workers, and MCP tools.

packages/queue
  BullMQ queue names, event payload schemas, queue factories, and job options.

packages/proxy-manager
  Proxy parsing, storage models, health scoring, quarantine decisions, and
  proxy selection.

packages/resource-governor
  Detects CPU, RAM, GPU, Qwen availability, proxy health, browser capacity,
  and queue pressure. Converts the user's server usage percentage into
  concurrency limits.

packages/campaign-planner
  Converts a user prompt into a campaign plan: ICP, geography, required fields,
  positive signals, negative filters, source strategy, scoring rubric, research
  depth, and output columns.

packages/source-adapters
  Reusable source adapter interfaces and browser-driven discovery/extraction
  recipes.

packages/document-store
  Local filesystem document storage for raw HTML, rendered text, screenshots,
  and metadata. Designed to later swap to S3-compatible storage.

packages/scoring
  Deterministic scoring engine. Qwen can produce scored inputs and evidence,
  but not the final numeric lead score.

packages/llm
  OpenAI-compatible local LLM provider with strict JSON validation.
```

## Data Flow

```text
User prompt
  -> Campaign planner
  -> Campaign record
  -> Discovery queue
  -> Browser workers
  -> Raw documents
  -> Cleaned evidence snippets
  -> Qwen structured analysis
  -> Claims with confidence and evidence IDs
  -> Cross-validation and contradictions
  -> Deterministic score
  -> Ranked lead table
  -> CSV export and MCP access
```

## Campaign Model

A campaign stores the user's prompt and the generated execution plan.

Campaign plan fields include:

- ICP definition
- target geography
- positive buying signals
- negative filters and disqualification rules
- required evidence fields
- source strategy
- generated or selected source adapters
- contact enrichment requirements
- scoring rubric
- campaign limits
- export columns
- prompt/model versions

Campaign prompts are saved and versioned so the user can rerun, compare, or
audit campaigns later.

## Discovery Strategy

The first version uses browser-first discovery. The system should not rely on
official search APIs or paid source APIs for v1.

Browser workers discover candidate companies and sources through public web
pages, search result pages, directories, business profiles, public review pages,
career pages, and company websites where legally accessible.

Generated source adapters are allowed to run automatically, but they graduate in
stages:

1. exploratory run on a small sample
2. quality check against extraction schemas and failure rates
3. limited campaign usage
4. reusable source recipe if stable

Generated adapters must be represented as declarative recipes or sandboxed code,
stored with versions, and tested before broad reuse.

## Browser And Proxy Policy

Workers use HTTP and SOCKS5 proxies uploaded through the dashboard.

Proxy records track:

- endpoint
- protocol
- auth metadata
- status
- successes
- failures
- average latency
- last used
- cooldown until
- health score

When a page fails in a real browser, the worker may retry with another proxy or
browser profile within campaign limits.

If a source shows CAPTCHA, login requirements, explicit blocking, or access
control, the system records the source as blocked and moves on. The system must
not build CAPTCHA bypassing, login bypassing, ban evasion, or access-control
evasion.

## Resource Governor

The user configures a server usage percentage, not raw concurrency numbers.

The resource governor detects capacity using local system commands and runtime
metrics, especially on Linux servers:

- CPU cores and load
- RAM total/used/available
- GPU utilization and memory through `nvidia-smi` when available
- Qwen latency and request concurrency
- active browser count
- proxy health and usable proxy count
- queue depth and backpressure

It computes:

- max browser workers
- max active browser contexts
- max Qwen concurrency
- max discovery concurrency
- max pages per lead
- retry budget
- campaign-level pace

Current local inspection found this workspace is on macOS with Node, pnpm,
Docker, Docker Compose via `docker-compose`, Postgres CLI, and a reachable
Ollama/OpenAI-compatible LLM endpoint. The production target should be detected
at runtime on the Linux server using the same governor package.

## Local LLM

The configured endpoint responds at:

```env
LOCAL_LLM_BASE_URL=http://73.72.215.253:11434/v1
LOCAL_LLM_MODEL=qwen2.5:14b
LOCAL_LLM_API_KEY=local
```

The provider remains OpenAI-compatible. The code must not couple business logic
to Ollama, vLLM, llama.cpp, or another specific backend.

Every important model output uses strict structured schemas. Invalid JSON,
schema mismatch, timeout, or evidence-free claims become structured failures or
low-confidence records.

## Evidence Model

Every analyzed claim supports:

- field
- value
- confidence
- evidence IDs
- analysis version
- prompt name and version
- model name
- timestamp

Evidence stores:

- source URL
- final URL
- retrieval timestamp
- content hash
- source type
- source adapter
- retrieval method
- raw document path
- cleaned text path or snippet
- quote/snippet
- company/lead association

The system must be able to rerun analysis from stored documents without
revisiting the source.

## Contact Enrichment

V1 collects:

- company website emails
- public business profile emails
- public owner/manager names

It does not collect private personal data. It does not present inferred emails
as verified. Pattern-based inferred email generation is out of scope for v1.

## Scoring

Qwen produces structured observations with evidence. The scoring engine computes
the final numeric score deterministically from the campaign scoring rubric.

Each score component records:

- rule ID
- points
- matched claim IDs
- evidence IDs
- explanation

This keeps rankings explainable and reproducible.

## Dashboard

The dashboard starts local and single-user.

V1 views:

- campaign prompt entry
- campaign list and live status
- campaign progress bar
- generated campaign plan
- settings
- proxy upload and proxy health
- active browser workers
- queue depths
- Qwen throughput and latency
- ranked lead table
- lead detail with evidence
- CSV export
- pause/resume/cancel controls

Authentication is intentionally deferred until remote exposure.

## MCP Server

Codex uses high-level MCP tools:

- create_campaign
- get_campaign
- pause_campaign
- resume_campaign
- cancel_campaign
- get_leads
- get_lead
- get_evidence
- rerun_analysis
- audit_leads
- export_campaign_csv
- system_stats

MCP does not expose click, scroll, browser profile, or proxy rotation mechanics.

## Storage

PostgreSQL stores normalized records and structured state.

Local app storage stores heavy artifacts under:

```text
data/documents
data/screenshots
data/exports
```

The document store package abstracts file layout so S3-compatible storage can be
added later.

## Failure Handling

Failures are first-class records:

- site inaccessible
- browser crash
- proxy failure
- CAPTCHA or blocked
- login required
- Qwen timeout
- malformed model output
- schema validation failure
- source recipe failure
- database timeout
- job duplication

One failed source must not crash a campaign.
