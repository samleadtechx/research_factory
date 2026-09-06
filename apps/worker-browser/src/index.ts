import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@leadfactory/database";
import { LocalDocumentStore } from "@leadfactory/document-store";
import {
  createQueue,
  createRedisConnection,
  queueNames,
  type AnalysisPayload,
  type BrowserResearchPayload
} from "@leadfactory/queue";
import { calculateWorkerLimits, probeSystemCapacity } from "@leadfactory/resource-governor";
import { CampaignPlanSchema, ServerSettingsSchema, type CampaignPlan } from "@leadfactory/schemas";
import { Job, Worker } from "bullmq";
import "dotenv/config";
import { chromium, type BrowserContextOptions, type Page } from "playwright";

type ProxyRecord = {
  id: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string;
  passwordEncrypted: string | null;
};

type SearchResult = {
  url: string;
  title: string;
  snippet?: string;
};

type PageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  statusCode?: number;
  title: string;
  html: string;
  text: string;
  links: string[];
};

type SavedPage = {
  documentId: string;
  emails: string[];
  phones: string[];
  people: Array<{ name: string; role: string }>;
};

class PageBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const appStorageDir = resolveStorageDir(process.env.APP_STORAGE_DIR ?? "data");
const redisUrl = requiredEnv("REDIS_URL");
const documentStore = new LocalDocumentStore(appStorageDir);
const browserFetchQueue = createQueue<BrowserResearchPayload>(queueNames.browserFetch, redisUrl);
const analysisQueue = createQueue<AnalysisPayload>(queueNames.qwenAnalysis, redisUrl);

const profileUserAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];

const searchEngineDomains = new Set([
  "duckduckgo.com",
  "google.com",
  "bing.com",
  "yahoo.com",
  "search.brave.com"
]);

const businessProfileDomains = [
  "bbb.org",
  "chamberofcommerce.com",
  "facebook.com",
  "linkedin.com",
  "manta.com",
  "mapquest.com",
  "nextdoor.com",
  "yellowpages.com",
  "yelp.com"
];

export async function main() {
  const limits = await resolveWorkerLimits();
  const discoveryWorker = new Worker<BrowserResearchPayload>(
    queueNames.discovery,
    processBrowserJob,
    {
      connection: createRedisConnection(redisUrl),
      concurrency: limits.maxDiscoveryConcurrency
    }
  );
  const fetchWorker = new Worker<BrowserResearchPayload>(queueNames.browserFetch, processBrowserJob, {
    connection: createRedisConnection(redisUrl),
    concurrency: limits.maxBrowsers
  });

  for (const worker of [discoveryWorker, fetchWorker]) {
    worker.on("completed", (job) => {
      console.log(JSON.stringify({ service: "worker-browser", jobId: job.id, status: "completed" }));
    });
    worker.on("failed", (job, error) => {
      console.error(
        JSON.stringify({
          service: "worker-browser",
          jobId: job?.id,
          status: "failed",
          error: error.message
        })
      );
    });
  }

  console.log(
    JSON.stringify({
      service: "worker-browser",
      status: "running",
      queues: [queueNames.discovery, queueNames.browserFetch],
      limits
    })
  );

  await waitForShutdown(async () => {
    await Promise.all([
      discoveryWorker.close(),
      fetchWorker.close(),
      browserFetchQueue.close(),
      analysisQueue.close(),
      prisma.$disconnect()
    ]);
  });
}

async function processBrowserJob(job: Job<BrowserResearchPayload>) {
  const campaign = await activateCampaign(job.data.campaignId);
  if (!campaign) {
    await markResearchJob(job.data.researchJobId, "completed", {
      skipped: "campaign_not_active"
    });
    return { skipped: "campaign_not_active" };
  }

  await markResearchJob(job.data.researchJobId, "running");

  try {
    if (job.data.task === "discover_candidates") {
      const result = await discoverCandidates(job);
      await markResearchJob(job.data.researchJobId, "completed", result);
      return result;
    }

    if (job.data.task === "research_company") {
      const result = await researchCompany(job);
      await markResearchJob(job.data.researchJobId, "completed", result);
      return result;
    }

    await markResearchJob(job.data.researchJobId, "completed", {
      skipped: `task_${job.data.task}_not_implemented`
    });
    return { skipped: `task_${job.data.task}_not_implemented` };
  } catch (error) {
    await markResearchJob(job.data.researchJobId, "failed", {
      message: error instanceof Error ? error.message : "Unknown worker error"
    });
    throw error;
  } finally {
    await updateCampaignProgress(job.data.campaignId);
  }
}

async function discoverCandidates(job: Job<BrowserResearchPayload>) {
  const campaign = await prisma.campaign.findUnique({ where: { id: job.data.campaignId } });
  if (!campaign) return { discovered: 0 };

  const plan = parseCampaignPlan(campaign.plan, campaign.prompt, campaign.name);
  const query = job.data.query ?? buildDiscoveryQuery(plan);
  const target = Math.min(campaign.targetLeadCount ?? 50, Number(process.env.MAX_DISCOVERY_RESULTS ?? 80));
  const searchResults = await fetchSearchResults({
    campaignId: campaign.id,
    query,
    limit: Math.max(target * 2, 25),
    proxyStrategy: job.data.proxyStrategy
  });

  let discovered = 0;
  for (const result of searchResults.slice(0, target * 2)) {
    if (discovered >= target) break;

    const candidate = await upsertCandidateFromSearch(campaign.id, result);
    if (!candidate) continue;

    if (candidate.createdLead) discovered += 1;
    const researchJob = await prisma.researchJob.create({
      data: {
        campaignId: campaign.id,
        type: "browser_fetch",
        status: "queued",
        priority: 0,
        parameters: {
          leadId: candidate.leadId,
          companyId: candidate.companyId,
          url: candidate.url,
          discoveryTitle: result.title
        }
      }
    });

    await browserFetchQueue.add(
      "research_company",
      {
        campaignId: campaign.id,
        researchJobId: researchJob.id,
        leadId: candidate.leadId,
        companyId: candidate.companyId,
        url: candidate.url,
        task: "research_company",
        proxyStrategy: "auto"
      },
      {
        jobId: `campaign_${campaign.id}_lead_${candidate.leadId}_research`
      }
    );
  }

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "discovery_completed",
      message: `Discovery found ${discovered} new candidate leads.`,
      metadata: { query, totalSearchResults: searchResults.length }
    }
  });

  return { discovered, totalSearchResults: searchResults.length, query };
}

async function researchCompany(job: Job<BrowserResearchPayload>) {
  const lead = job.data.leadId
    ? await prisma.lead.findUnique({
        where: { id: job.data.leadId },
        include: { company: true, campaign: true }
      })
    : null;

  if (!lead?.company) {
    return { researched: false, reason: "lead_or_company_missing" };
  }

  const campaign = lead.campaign;
  const settings = ServerSettingsSchema.parse({
    ...readSettingsFromEnv(),
    ...(campaign.settings && typeof campaign.settings === "object" ? campaign.settings : {})
  });
  const startUrl = normalizeInputUrl(job.data.url ?? lead.company.website ?? "");
  if (!startUrl) return { researched: false, reason: "company_url_missing" };

  const pageResult = await withBrowserPage(
    {
      campaignId: campaign.id,
      leadId: lead.id,
      companyId: lead.company.id,
      url: startUrl,
      sourceName: "company_research",
      proxyStrategy: job.data.proxyStrategy,
      proxyId: job.data.proxyId,
      maxAttempts: Math.max(1, settings.proxyRetryCount + 1)
    },
    async (page, proxy) => {
      const documentIds: string[] = [];
      const allEmails = new Set<string>();
      const allPhones = new Set<string>();
      const allPeople = new Map<string, { name: string; role: string }>();
      const rootSnapshot = await navigateAndSnapshot(page, startUrl);
      const savedRoot = await saveSnapshot({
        campaignId: campaign.id,
        companyId: lead.company!.id,
        leadId: lead.id,
        snapshot: rootSnapshot,
        sourceType: inferSourceType(rootSnapshot.finalUrl),
        proxyId: proxy?.id
      });
      collectSavedSignals(savedRoot, allEmails, allPhones, allPeople);
      documentIds.push(savedRoot.documentId);

      const urls = selectCompanyResearchUrls(rootSnapshot.links, rootSnapshot.finalUrl).slice(
        0,
        Math.max(0, settings.maxPagesPerLead - 1)
      );

      for (const url of urls) {
        try {
          const snapshot = await navigateAndSnapshot(page, url);
          const saved = await saveSnapshot({
            campaignId: campaign.id,
            companyId: lead.company!.id,
            leadId: lead.id,
            snapshot,
            sourceType: inferSourceType(snapshot.finalUrl),
            proxyId: proxy?.id
          });
          collectSavedSignals(saved, allEmails, allPhones, allPeople);
          documentIds.push(saved.documentId);
        } catch (error) {
          await recordSourceFailure({
            campaignId: campaign.id,
            companyId: lead.company!.id,
            leadId: lead.id,
            url,
            sourceName: "company_subpage",
            blocked: error instanceof PageBlockedError,
            error
          });
        }
      }

      const emails = [...allEmails];
      const phones = [...allPhones];
      const people = [...allPeople.values()];
      await updateCompanySignals(lead.company!.id, {
        emails,
        phones,
        people
      });

      const strongestSignal =
        emails[0] ?? (people[0] ? `${people[0].name} ${people[0].role}`.trim() : undefined);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: "researched",
          strongestSignal
        }
      });

      const analysisJob = await prisma.researchJob.create({
        data: {
          campaignId: campaign.id,
          type: "qwen_analysis",
          status: "queued",
          priority: 0,
          parameters: {
            leadId: lead.id,
            documentIds,
            promptName: "lead_analysis",
            promptVersion: "v1"
          }
        }
      });

      await analysisQueue.add(
        "analyze_lead",
        {
          campaignId: campaign.id,
          researchJobId: analysisJob.id,
          leadId: lead.id,
          documentIds,
          promptName: "lead_analysis",
          promptVersion: "v1"
        },
        {
          jobId: `campaign_${campaign.id}_lead_${lead.id}_analysis_${Date.now()}`
        }
      );

      return {
        researched: true,
        documentIds,
        emails: emails.length,
        phones: phones.length,
        people: people.length
      };
    }
  );

  if (!pageResult.ok) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: pageResult.blocked ? "blocked" : "research_failed",
        strongestSignal: pageResult.reason
      }
    });
    return {
      researched: false,
      blocked: pageResult.blocked,
      reason: pageResult.reason
    };
  }

  return pageResult.result;
}

async function fetchSearchResults(params: {
  campaignId: string;
  query: string;
  limit: number;
  proxyStrategy: BrowserResearchPayload["proxyStrategy"];
}): Promise<SearchResult[]> {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;
  const result = await withBrowserPage(
    {
      campaignId: params.campaignId,
      url: searchUrl,
      sourceName: "duckduckgo",
      proxyStrategy: params.proxyStrategy,
      maxAttempts: Number(process.env.SEARCH_RETRY_COUNT ?? 2)
    },
    async (page) => {
      await navigateAndSnapshot(page, searchUrl);
      const anchors = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a")).map((anchor) => ({
          href: (anchor as HTMLAnchorElement).href,
          text: anchor.textContent?.trim() ?? ""
        }))
      );

      const deduped = new Map<string, SearchResult>();
      for (const anchor of anchors) {
        const normalized = normalizeSearchHref(anchor.href);
        if (!normalized || !isUsefulPublicUrl(normalized)) continue;
        if (!anchor.text || anchor.text.length < 3) continue;
        const domain = domainFromUrl(normalized);
        if (!domain || searchEngineDomains.has(domain)) continue;
        if (!deduped.has(normalized)) {
          deduped.set(normalized, {
            url: normalized,
            title: cleanSearchTitle(anchor.text)
          });
        }
      }

      return [...deduped.values()].slice(0, params.limit);
    }
  );

  return result.ok ? result.result : [];
}

async function withBrowserPage<T>(
  options: {
    campaignId: string;
    leadId?: string;
    companyId?: string;
    url: string;
    sourceName: string;
    proxyStrategy: BrowserResearchPayload["proxyStrategy"];
    proxyId?: string;
    maxAttempts: number;
  },
  callback: (page: Page, proxy: ProxyRecord | null) => Promise<T>
): Promise<{ ok: true; result: T } | { ok: false; blocked: boolean; reason: string }> {
  const excludedProxyIds = new Set<string>();
  let lastFailure: { blocked: boolean; reason: string } | null = null;
  const maxAttempts = Math.max(1, options.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proxy = await selectProxy(options.proxyStrategy, excludedProxyIds, options.proxyId);
    if (proxy) excludedProxyIds.add(proxy.id);

    const startedAt = Date.now();
    const browser = await chromium.launch({
      headless: process.env.BROWSER_HEADLESS !== "false",
      proxy: proxy
        ? {
            server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
            username: proxy.username || undefined,
            password: proxy.passwordEncrypted ?? undefined
          }
        : undefined
    });

    try {
      const context = await browser.newContext(randomContextOptions());
      const page = await context.newPage();
      page.setDefaultTimeout(Number(process.env.BROWSER_ACTION_TIMEOUT_MS ?? 15000));
      const result = await callback(page, proxy);
      await context.close();
      await markProxySuccess(proxy, Date.now() - startedAt);
      return { ok: true, result };
    } catch (error) {
      const blocked = error instanceof PageBlockedError;
      const reason = error instanceof Error ? error.message : "Unknown browser failure";
      lastFailure = { blocked, reason };
      await markProxyFailure(proxy, blocked);
      await recordSourceFailure({
        campaignId: options.campaignId,
        companyId: options.companyId,
        leadId: options.leadId,
        url: options.url,
        sourceName: options.sourceName,
        blocked,
        error
      });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  return lastFailure ? { ok: false, ...lastFailure } : { ok: false, blocked: false, reason: "Browser task did not run" };
}

async function navigateAndSnapshot(page: Page, url: string): Promise<PageSnapshot> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.BROWSER_NAVIGATION_TIMEOUT_MS ?? 45000)
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);

  const html = await page.content();
  const text = normalizeWhitespace(
    await page
      .locator("body")
      .innerText({ timeout: 6000 })
      .catch(() => stripHtml(html))
  );
  const title = normalizeWhitespace(await page.title().catch(() => ""));
  const statusCode = response?.status();
  const blockReason = detectBlockReason(text, html, statusCode);
  if (blockReason) throw new PageBlockedError(blockReason);

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter(Boolean)
  );

  return {
    requestedUrl: url,
    finalUrl: page.url(),
    statusCode,
    title,
    html,
    text,
    links
  };
}

async function saveSnapshot(params: {
  campaignId: string;
  companyId: string;
  leadId: string;
  snapshot: PageSnapshot;
  sourceType: string;
  proxyId?: string;
}): Promise<SavedPage> {
  const raw = await documentStore.save({
    campaignId: params.campaignId,
    companyId: params.companyId,
    url: params.snapshot.finalUrl,
    kind: "raw_html",
    extension: "html",
    content: params.snapshot.html
  });
  const clean = await documentStore.save({
    campaignId: params.campaignId,
    companyId: params.companyId,
    url: params.snapshot.finalUrl,
    kind: "clean_text",
    extension: "txt",
    content: params.snapshot.text
  });

  const document = await prisma.document.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      sourceType: params.sourceType,
      retrievalMethod: "browser",
      url: params.snapshot.requestedUrl,
      canonicalUrl: canonicalizeUrl(params.snapshot.finalUrl),
      finalUrl: params.snapshot.finalUrl,
      httpStatus: params.snapshot.statusCode,
      title: params.snapshot.title || null,
      contentHash: raw.sha256,
      rawHtmlPath: raw.path,
      cleanTextPath: clean.path,
      metadata: {
        proxyId: params.proxyId,
        rawBytes: raw.bytes,
        cleanBytes: clean.bytes,
        linkCount: params.snapshot.links.length
      }
    }
  });

  const emails = extractEmails(params.snapshot.text);
  const phones = extractPhones(params.snapshot.text);
  const people = extractDecisionMakers(params.snapshot.text);

  for (const email of emails.slice(0, 20)) {
    await createEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      documentId: document.id,
      field: "public_email",
      sourceType: params.sourceType,
      url: params.snapshot.requestedUrl,
      finalUrl: params.snapshot.finalUrl,
      quote: findQuote(params.snapshot.text, email)
    });
  }

  for (const phone of phones.slice(0, 10)) {
    await createEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      documentId: document.id,
      field: "public_phone",
      sourceType: params.sourceType,
      url: params.snapshot.requestedUrl,
      finalUrl: params.snapshot.finalUrl,
      quote: findQuote(params.snapshot.text, phone)
    });
  }

  for (const person of people.slice(0, 10)) {
    await createEvidence({
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      documentId: document.id,
      field: "owner_manager_name",
      sourceType: params.sourceType,
      url: params.snapshot.requestedUrl,
      finalUrl: params.snapshot.finalUrl,
      quote: findQuote(params.snapshot.text, person.name) || `${person.name} - ${person.role}`
    });
  }

  return {
    documentId: document.id,
    emails,
    phones,
    people
  };
}

async function upsertCandidateFromSearch(campaignId: string, result: SearchResult) {
  const domain = domainFromUrl(result.url);
  if (!domain) return null;

  const companyName = inferCompanyName(result.title, domain);
  const existingCompany = await prisma.company.findFirst({
    where: {
      OR: [{ domain }, { website: result.url }]
    }
  });
  const metadata = {
    discovery: {
      source: "duckduckgo",
      title: result.title,
      snippet: result.snippet,
      url: result.url
    }
  };
  const company =
    existingCompany ??
    (await prisma.company.create({
      data: {
        companyName,
        normalizedName: normalizeCompanyName(companyName),
        domain,
        website: result.url,
        metadata
      }
    }));

  if (existingCompany) {
    await prisma.company.update({
      where: { id: existingCompany.id },
      data: {
        companyName: existingCompany.companyName || companyName,
        normalizedName: existingCompany.normalizedName ?? normalizeCompanyName(companyName),
        website: existingCompany.website ?? result.url,
        metadata
      }
    });
  }

  const existingLead = await prisma.lead.findFirst({
    where: {
      campaignId,
      companyId: company.id
    }
  });
  const lead =
    existingLead ??
    (await prisma.lead.create({
      data: {
        campaignId,
        companyId: company.id,
        status: "candidate"
      }
    }));

  await createEvidence({
    campaignId,
    companyId: company.id,
    leadId: lead.id,
    field: "search_result",
    sourceType: "search_result",
    url: result.url,
    finalUrl: result.url,
    quote: result.title
  });

  return {
    leadId: lead.id,
    companyId: company.id,
    url: result.url,
    createdLead: !existingLead
  };
}

async function createEvidence(params: {
  campaignId: string;
  companyId?: string;
  leadId?: string;
  documentId?: string;
  field: string;
  sourceType: string;
  url: string;
  finalUrl?: string;
  quote: string;
}) {
  const quote = normalizeWhitespace(params.quote).slice(0, 1500);
  if (!quote) return null;

  const existing = await prisma.evidence.findFirst({
    where: {
      campaignId: params.campaignId,
      leadId: params.leadId,
      field: params.field,
      url: params.url,
      quote
    }
  });
  if (existing) return existing;

  return prisma.evidence.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      documentId: params.documentId,
      field: params.field,
      sourceType: params.sourceType,
      retrievalMethod: "browser",
      url: params.url,
      finalUrl: params.finalUrl,
      quote,
      contentHash: hashText(quote)
    }
  });
}

async function activateCampaign(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return null;
  if (["paused", "cancelled", "completed", "failed"].includes(campaign.status)) return null;

  if (campaign.status !== "running") {
    return prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: "running",
        startedAt: campaign.startedAt ?? new Date()
      }
    });
  }

  return campaign;
}

async function markResearchJob(
  researchJobId: string | undefined,
  status: "running" | "completed" | "failed",
  payload?: unknown
) {
  if (!researchJobId) return;

  await prisma.researchJob.update({
    where: { id: researchJobId },
    data: {
      status,
      startedAt: status === "running" ? new Date() : undefined,
      completedAt: status === "completed" || status === "failed" ? new Date() : undefined,
      statistics: status === "completed" ? (payload as object) : undefined,
      error: status === "failed" ? (payload as object) : undefined
    }
  });
}

async function updateCampaignProgress(campaignId: string) {
  const [campaign, discovered, researched, ranked, errors] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId } }),
    prisma.lead.count({ where: { campaignId } }),
    prisma.lead.count({ where: { campaignId, status: { in: ["researched", "ranked"] } } }),
    prisma.lead.count({ where: { campaignId, rank: { not: null } } }),
    prisma.sourceFailure.count({ where: { campaignId } })
  ]);
  if (!campaign) return;

  const target = Math.max(1, campaign.targetLeadCount ?? Math.max(discovered, 25));
  const weightedUnits = discovered * 0.2 + researched * 0.35 + ranked * 0.45;
  const percent = Math.min(campaign.status === "completed" ? 100 : 99, Math.round((weightedUnits / target) * 100));

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      progress: {
        percent,
        discovered,
        researched,
        ranked,
        errors
      }
    }
  });
}

async function recordSourceFailure(params: {
  campaignId: string;
  companyId?: string;
  leadId?: string;
  url: string;
  sourceName: string;
  blocked: boolean;
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  await prisma.sourceFailure.create({
    data: {
      campaignId: params.campaignId,
      companyId: params.companyId,
      leadId: params.leadId,
      url: params.url,
      sourceName: params.sourceName,
      reason: params.blocked ? `blocked: ${message}` : `browser_error: ${message}`,
      blocked: params.blocked,
      details: {
        worker: "browser",
        at: new Date().toISOString()
      }
    }
  });
}

async function selectProxy(
  strategy: BrowserResearchPayload["proxyStrategy"],
  excludedIds: Set<string>,
  proxyId?: string
) {
  if (strategy === "direct") return null;

  if (strategy === "specific" && proxyId && !excludedIds.has(proxyId)) {
    const proxy = await prisma.proxy.findUnique({ where: { id: proxyId } });
    if (proxy && proxy.status !== "quarantined") return proxy as ProxyRecord;
  }

  const usableStatuses = ["healthy", "untested", "degraded"] as const;
  for (const status of usableStatuses) {
    const proxy = await prisma.proxy.findFirst({
      where: {
        id: { notIn: [...excludedIds] },
        status,
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: new Date() } }]
      },
      orderBy: [{ healthScore: "desc" }, { lastUsedAt: "asc" }]
    });
    if (proxy) return proxy as ProxyRecord;
  }

  return null;
}

async function markProxySuccess(proxy: ProxyRecord | null, latencyMs: number) {
  if (!proxy) return;

  await prisma.proxy.update({
    where: { id: proxy.id },
    data: {
      successes: { increment: 1 },
      averageLatencyMs: latencyMs,
      lastUsedAt: new Date(),
      status: "healthy",
      healthScore: { increment: 1 }
    }
  });
}

async function markProxyFailure(proxy: ProxyRecord | null, blocked: boolean) {
  if (!proxy) return;

  await prisma.proxy.update({
    where: { id: proxy.id },
    data: {
      failures: { increment: 1 },
      lastUsedAt: new Date(),
      status: blocked ? "cooldown" : "degraded",
      cooldownUntil: blocked ? new Date(Date.now() + 15 * 60 * 1000) : undefined,
      healthScore: { decrement: 1 }
    }
  });
}

async function updateCompanySignals(
  companyId: string,
  signals: {
    emails: string[];
    phones: string[];
    people: Array<{ name: string; role: string }>;
  }
) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return;

  const emails = mergeStringArrays(readJsonStringArray(company.emails), signals.emails);
  const owners = mergePeople(readJsonPeople(company.owners), signals.people.filter(isOwnerLike));
  const managers = mergePeople(readJsonPeople(company.managers), signals.people);

  await prisma.company.update({
    where: { id: companyId },
    data: {
      generalEmail: company.generalEmail ?? emails[0],
      phone: company.phone ?? signals.phones[0],
      emails,
      owners,
      managers,
      lastCheckedAt: new Date()
    }
  });
}

function collectSavedSignals(
  saved: SavedPage,
  emails: Set<string>,
  phones: Set<string>,
  people: Map<string, { name: string; role: string }>
) {
  for (const email of saved.emails) emails.add(email);
  for (const phone of saved.phones) phones.add(phone);
  for (const person of saved.people) people.set(`${person.name.toLowerCase()}|${person.role.toLowerCase()}`, person);
}

async function resolveWorkerLimits() {
  const settings = readSettingsFromEnv();
  const [capacity, usableProxyCount] = await Promise.all([
    probeSystemCapacity(),
    prisma.proxy.count({
      where: {
        status: { in: ["healthy", "untested", "degraded"] }
      }
    })
  ]);

  return calculateWorkerLimits({
    settings,
    capacity,
    healthyProxyCount: usableProxyCount,
    qwenHealthy: true
  });
}

function readSettingsFromEnv() {
  return ServerSettingsSchema.parse({
    serverUsagePercent: Number(process.env.SERVER_USAGE_PERCENT ?? 60),
    maxBrowsersHardCap: Number(process.env.MAX_BROWSERS_HARD_CAP ?? 40),
    maxQwenConcurrency: Number(process.env.MAX_QWEN_CONCURRENCY ?? 4),
    maxCampaignRuntimeMinutes: Number(process.env.MAX_CAMPAIGN_RUNTIME_MINUTES ?? 240),
    maxPagesPerLead: Number(process.env.MAX_PAGES_PER_LEAD ?? 25),
    proxyRetryCount: Number(process.env.PROXY_RETRY_COUNT ?? 2),
    browserFirst: process.env.BROWSER_FIRST !== "false"
  });
}

function parseCampaignPlan(value: unknown, prompt: string, campaignName: string): CampaignPlan {
  const parsed = CampaignPlanSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  return {
    campaignName,
    icpDescription: prompt,
    geography: [],
    positiveSignals: [],
    negativeFilters: [],
    disqualificationRules: [],
    requiredEvidenceFields: ["public_email", "owner_manager_name", "company_website"],
    contactRequirements: ["company website emails", "public business profile emails", "public owner or manager names"],
    sourceStrategy: ["browser_search", "company_website"],
    scoringRules: [],
    maxPagesPerLead: 10,
    outputColumns: ["rank", "company", "website", "score", "email", "decision_maker", "evidence"],
    plannerNotes: "Fallback plan generated by worker because stored plan was unavailable."
  };
}

function buildDiscoveryQuery(plan: CampaignPlan): string {
  const geography = plan.geography.slice(0, 3).join(" ");
  const signals = plan.positiveSignals.slice(0, 2).join(" ");
  return [plan.icpDescription, geography, signals, "company contact owner manager email"]
    .filter(Boolean)
    .join(" ");
}

function selectCompanyResearchUrls(links: string[], finalUrl: string): string[] {
  const root = new URL(finalUrl);
  const rootDomain = root.hostname.replace(/^www\./, "");
  const candidates = new Map<string, { url: string; weight: number }>();

  for (const href of links) {
    const url = normalizeInputUrl(href);
    if (!url || !isUsefulPublicUrl(url)) continue;
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, "");
    const sameSite = domain === rootDomain;
    const profile = businessProfileDomains.some((known) => domain === known || domain.endsWith(`.${known}`));
    if (!sameSite && !profile) continue;

    const pathValue = `${parsed.pathname} ${parsed.search}`.toLowerCase();
    const weight = keywordWeight(pathValue);
    if (weight <= 0) continue;
    const canonical = canonicalizeUrl(url);
    const current = candidates.get(canonical);
    if (!current || current.weight < weight) candidates.set(canonical, { url, weight });
  }

  return [...candidates.values()]
    .sort((left, right) => right.weight - left.weight)
    .map((candidate) => candidate.url);
}

function keywordWeight(value: string): number {
  const keywords = [
    ["contact", 10],
    ["about", 8],
    ["team", 8],
    ["staff", 8],
    ["owner", 7],
    ["management", 7],
    ["leadership", 7],
    ["services", 4],
    ["careers", 3],
    ["jobs", 3],
    ["locations", 3]
  ] as const;

  return keywords.reduce((score, [keyword, points]) => score + (value.includes(keyword) ? points : 0), 0);
}

function inferSourceType(url: string): string {
  const domain = domainFromUrl(url) ?? "";
  if (businessProfileDomains.some((known) => domain === known || domain.endsWith(`.${known}`))) {
    return "business_profile";
  }
  if (/career|jobs|employment/i.test(url)) return "careers_page";
  return "company_website";
}

function detectBlockReason(text: string, html: string, statusCode?: number): string | null {
  if (statusCode && [401, 403, 407, 429, 503].includes(statusCode)) {
    return `HTTP ${statusCode} block or throttling response`;
  }

  const sample = `${text}\n${html.slice(0, 3000)}`.toLowerCase();
  const patterns = [
    "access denied",
    "are you a human",
    "captcha",
    "checking if the site connection is secure",
    "enable cookies",
    "login required",
    "please verify",
    "temporarily blocked",
    "too many requests",
    "unusual traffic",
    "verify you are human"
  ];

  return patterns.find((pattern) => sample.includes(pattern)) ?? null;
}

function extractEmails(text: string): string[] {
  const matches = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  return [...new Set(matches.map((email) => email.toLowerCase()))].filter((email) => {
    if (email.includes("@example.") || email.includes("@domain.")) return false;
    return !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(email);
  });
}

function extractPhones(text: string): string[] {
  const matches =
    text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g) ?? [];
  return [...new Set(matches.map((phone) => phone.replace(/\s+/g, " ").trim()))].slice(0, 20);
}

function extractDecisionMakers(text: string): Array<{ name: string; role: string }> {
  const roles = "Owner|Founder|Co-Founder|CEO|President|Principal|General Manager|Operations Manager|Manager|Director";
  const lines = text
    .split(/\n| {2,}/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 8 && line.length <= 180);
  const people = new Map<string, { name: string; role: string }>();

  for (const line of lines) {
    const nameThenRole = line.match(new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\b\\s*(?:,|-|:|\\|)?\\s*\\b(${roles})\\b`));
    const roleThenName = line.match(new RegExp(`\\b(${roles})\\b\\s*(?:,|-|:|\\|)?\\s*\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\b`));
    const match = nameThenRole
      ? { name: nameThenRole[1], role: nameThenRole[2] }
      : roleThenName
        ? { name: roleThenName[2], role: roleThenName[1] }
        : null;

    if (!match) continue;
    people.set(`${match.name.toLowerCase()}|${match.role.toLowerCase()}`, match);
  }

  return [...people.values()].slice(0, 20);
}

function findQuote(text: string, needle: string): string {
  const normalizedNeedle = needle.toLowerCase();
  const lines = text
    .split(/\n| {2,}/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const line = lines.find((candidate) => candidate.toLowerCase().includes(normalizedNeedle));
  if (line) return line.slice(0, 500);

  const index = text.toLowerCase().indexOf(normalizedNeedle);
  if (index < 0) return needle;
  return text.slice(Math.max(0, index - 160), Math.min(text.length, index + needle.length + 160));
}

function normalizeSearchHref(href: string): string | null {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    const value = redirected ? decodeURIComponent(redirected) : parsed.href;
    return normalizeInputUrl(value);
  } catch {
    return null;
  }
}

function normalizeInputUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^(mailto|tel|javascript):/i.test(trimmed)) return null;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function isUsefulPublicUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const domain = parsed.hostname.replace(/^www\./, "");
    if (searchEngineDomains.has(domain)) return false;
    if (/\.(css|gif|ico|jpeg|jpg|js|json|mp4|pdf|png|svg|webp|xml)$/i.test(parsed.pathname)) return false;
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function domainFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function canonicalizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function inferCompanyName(title: string, domain: string): string {
  const cleaned = cleanSearchTitle(title)
    .replace(/\b(official site|home|contact us|about us)\b/gi, "")
    .trim();
  if (cleaned.length >= 2) return cleaned.slice(0, 160);

  const name = domain.split(".").slice(0, -1).join(" ");
  return name.replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 160);
}

function cleanSearchTitle(value: string): string {
  return normalizeWhitespace(value)
    .replace(/\s+[|-]\s+(Google Search|DuckDuckGo|Bing)$/i, "")
    .split(/\s+[|-]\s+/)[0]
    .trim();
}

function normalizeCompanyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function readJsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readJsonPeople(value: unknown): Array<{ name: string; role: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is { name: string; role: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { name?: unknown }).name === "string" &&
      typeof (item as { role?: unknown }).role === "string"
  );
}

function mergeStringArrays(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter(Boolean))].slice(0, 50);
}

function mergePeople(
  left: Array<{ name: string; role: string }>,
  right: Array<{ name: string; role: string }>
): Array<{ name: string; role: string }> {
  const people = new Map<string, { name: string; role: string }>();
  for (const person of [...left, ...right]) {
    people.set(`${person.name.toLowerCase()}|${person.role.toLowerCase()}`, person);
  }
  return [...people.values()].slice(0, 50);
}

function isOwnerLike(person: { role: string }) {
  return /owner|founder|ceo|president|principal/i.test(person.role);
}

function randomContextOptions(): BrowserContextOptions {
  return {
    acceptDownloads: false,
    colorScheme: "light",
    hasTouch: false,
    javaScriptEnabled: true,
    locale: "en-US",
    timezoneId: "America/Chicago",
    userAgent: profileUserAgents[Math.floor(Math.random() * profileUserAgents.length)],
    viewport: {
      width: 1280 + Math.floor(Math.random() * 320),
      height: 760 + Math.floor(Math.random() * 220)
    }
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveStorageDir(value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  let closing = false;
  return new Promise((resolve) => {
    const shutdown = () => {
      if (closing) return;
      closing = true;
      cleanup()
        .catch((error) => console.error(error))
        .finally(resolve);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

await main();
