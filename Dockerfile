# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV XDG_CACHE_HOME=/app/.cache
ENV HOME=/app
ENV PATH=/app/.venv/bin:/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://leadfactory:leadfactory@localhost:5432/leadfactory

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    dumb-init \
    openssl \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile --prod=false

# Playwright installs the Debian runtime libraries needed by Chromium/Firefox-style browsers.
RUN pnpm --filter @leadfactory/worker-browser exec playwright install-deps chromium firefox
RUN pnpm --filter @leadfactory/worker-browser exec playwright install chromium

RUN python3 -m venv .venv \
  && .venv/bin/pip install --upgrade pip setuptools wheel \
  && .venv/bin/pip install -r requirements-browser.txt \
  && .venv/bin/python -m camoufox fetch

RUN pnpm db:generate && pnpm build

ENV NODE_ENV=production

RUN chmod +x scripts/docker-entrypoint.sh \
  && mkdir -p data/documents data/screenshots data/exports .leadfactory/logs /ms-playwright /app/.cache \
  && groupadd --system --gid 1001 leadfactory \
  && useradd --system --uid 1001 --gid leadfactory --home-dir /app --shell /usr/sbin/nologin leadfactory \
  && chown -R leadfactory:leadfactory /app /ms-playwright

USER leadfactory

EXPOSE 3000 4000

ENTRYPOINT ["dumb-init", "--", "/app/scripts/docker-entrypoint.sh"]
