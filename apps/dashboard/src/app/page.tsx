"use client";

import {
  Activity,
  Check,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Server,
  Settings,
  Square,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type CampaignStatus = "draft" | "planning" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

type CampaignSummary = {
  id: string;
  name: string;
  status: CampaignStatus;
  prompt: string;
  progress: {
    percent: number;
    discovered: number;
    researched: number;
    ranked: number;
    errors: number;
  };
  createdAt: string;
  updatedAt: string;
};

type CampaignListResponse = {
  campaigns: CampaignSummary[];
  summary: {
    total: number;
    queued: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
    rankedLeads: number;
    errors: number;
  };
};

type ModuleHealth = {
  key: string;
  label: string;
  status: "healthy" | "degraded" | "missing" | "unreachable";
  version?: string;
  detail?: string;
};

type HealthResponse = {
  checkedAt: string;
  capacity: {
    platform: string;
    cpuCores: number;
    loadAverage1m?: number;
    cpuUsagePercent?: number;
    totalMemoryBytes: number;
    freeMemoryBytes?: number;
    usedMemoryBytes?: number;
    memoryUsagePercent?: number;
    disk?: {
      path: string;
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      usagePercent: number;
    };
    gpu: {
      available: boolean;
      name?: string;
      memoryTotalMiB?: number;
      memoryUsedMiB?: number;
      utilizationPercent?: number;
      detectionSource?: string;
      detail?: string;
    };
  };
  modules: ModuleHealth[];
};

type Person = {
  name: string;
  role?: string;
  email?: string;
};

type LeadSummary = {
  id: string;
  campaignId: string;
  rank: number | null;
  score: number;
  confidence: number;
  strongestSignal?: string;
  status: string;
  companyName: string;
  website?: string;
  location?: string;
  emails: string[];
  owners: Person[];
  managers: Person[];
  evidence: Array<{
    id: string;
    field?: string;
    url: string;
    quote: string;
  }>;
};

type LeadListResponse = {
  leads: LeadSummary[];
};

type ProxyListResponse = {
  proxies: Array<{
    id: string;
    protocol: string;
    host: string;
    port: number;
    username?: string;
    status: string;
    successes: number;
    failures: number;
    healthScore: number;
  }>;
  summary: {
    total: number;
    healthy: number;
    untested: number;
    degraded: number;
    quarantined: number;
  };
};

type DebugBrowserHeadless = boolean | "virtual";

type RuntimeSettings = {
  redisUrl: string;
  localLlmBaseUrl: string;
  localLlmModel: string;
  localLlmApiKey: string;
  mcpBearerToken: string;
  appStorageDir: string;
  serverUsagePercent: number;
  maxBrowsersHardCap: number;
  maxQwenConcurrency: number;
  maxCampaignRuntimeMinutes: number;
  maxPagesPerLead: number;
  proxyRetryCount: number;
  browserFirst: boolean;
  maxDiscoveryResults: number;
  searchRetryCount: number;
  browserHeadless: boolean;
  browserActionTimeoutMs: number;
  browserNavigationTimeoutMs: number;
  maxActiveSourceRecipes: number;
  sourceRecipeResultLimit: number;
  sourceRecipeMaxQueries: number;
  sourceRecipeMaxSeeds: number;
  sourceRecipeMaxPages: number;
  sourceRecipeRetryCount: number;
  sourceRecipeAutoActivateAfter: number;
  sourceRecipeAutoDisableAfter: number;
  maxActiveEnrichmentProviders: number;
  maxActiveEmailVerificationProviders: number;
  maxEmailsToVerifyPerLead: number;
  providerAutoActivateAfter: number;
  providerAutoDisableAfter: number;
  providerEnforceRateLimits: boolean;
  providerMaxRateDelayMs: number;
  qwenTimeoutMs: number;
  qwenMaxSourceChars: number;
  debugBrowserHeadless: DebugBrowserHeadless;
  debugBrowserMaxSessions: number;
  debugBrowserActionTimeoutMs: number;
  debugBrowserNavigationTimeoutMs: number;
  debugBrowserConnectTimeoutMs: number;
  debugBrowserMaxTextChars: number;
};

type RuntimeSettingsResponse = {
  settings: RuntimeSettings;
  defaults: RuntimeSettings;
};

type ProviderStatus = "trial" | "active" | "disabled";

type SourceRecipeSummary = {
  id: string;
  campaignId?: string | null;
  generatedFromCampaignId?: string;
  name: string;
  version: string;
  status: ProviderStatus;
  supportedDomains: string[];
  description: string;
  discoveryQueries: string[];
  seedUrls: string[];
  steps: Array<{
    action: string;
    selector?: string;
    value?: string;
    limit?: number;
  }>;
  successCount: number;
  failureCount: number;
  updatedAt: string;
};

type SavedProviderSummary = {
  id: string;
  campaignId?: string | null;
  generatedFromCampaignId?: string;
  name: string;
  version: string;
  status: ProviderStatus;
  supportedDomains: string[];
  description: string;
  kind: string;
  runWhen?: string;
  rateLimitPerMinute?: number;
  requiredEnvVars: string[];
  missingEnvVars: string[];
  successCount: number;
  failureCount: number;
  lastUsedAt?: string | null;
  updatedAt: string;
};

type ProviderListSummary = {
  total: number;
  active: number;
  trial: number;
  disabled: number;
  successes: number;
  failures: number;
};

type SourceRecipeListResponse = {
  recipes: SourceRecipeSummary[];
  summary: ProviderListSummary;
};

type SavedProviderListResponse = {
  providers: SavedProviderSummary[];
  summary: ProviderListSummary;
};

type DataProviderRow =
  | ({ type: "Discovery"; mode: string } & SourceRecipeSummary)
  | ({ type: "Enrichment" | "Email Verify"; mode: string } & SavedProviderSummary);

type ProviderEndpoint = "source-recipes" | "enrichment-providers" | "email-verification-providers";

const emptyCampaignSummary: CampaignListResponse["summary"] = {
  total: 0,
  queued: 0,
  running: 0,
  paused: 0,
  completed: 0,
  failed: 0,
  rankedLeads: 0,
  errors: 0
};

const emptySourceRecipeSummary: SourceRecipeListResponse["summary"] = {
  total: 0,
  active: 0,
  trial: 0,
  disabled: 0,
  successes: 0,
  failures: 0
};

const emptySavedProviderSummary: ProviderListSummary = {
  total: 0,
  active: 0,
  trial: 0,
  disabled: 0,
  successes: 0,
  failures: 0
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";
const defaultPublicAppUrl = "http://localhost:3000";
const publicAppUrlStorageKey = "leadfactory.publicAppUrl";

function buildMcpConfig(remoteMcpUrl: string, bearerToken: string): string {
  const hasToken = bearerToken.trim().length > 0;
  return JSON.stringify(
    {
      mcpServers: {
        "lead-research-factory": {
          command: "npx",
          args: hasToken
            ? ["-y", "mcp-remote", remoteMcpUrl, "--header", "Authorization:Bearer ${LEADFACTORY_MCP_TOKEN}"]
            : ["-y", "mcp-remote", remoteMcpUrl],
          env: hasToken
            ? {
                LEADFACTORY_MCP_TOKEN: bearerToken
              }
            : {}
        }
      }
    },
    null,
    2
  );
}

function buildCodexTomlConfig(remoteMcpUrl: string, bearerToken: string): string {
  const lines = [
    "[mcp_servers.lead-research-factory]",
    `url = "${tomlString(remoteMcpUrl)}"`
  ];

  if (bearerToken.trim()) {
    lines.push('bearer_token_env_var = "LEADFACTORY_MCP_TOKEN"');
  }

  return lines.join("\n");
}

function buildCodexCliCommand(remoteMcpUrl: string, bearerToken: string): string {
  const command = [
    "codex",
    "mcp",
    "add",
    "lead-research-factory",
    "--url",
    shellQuote(remoteMcpUrl)
  ];

  if (bearerToken.trim()) {
    command.push("--bearer-token-env-var", "LEADFACTORY_MCP_TOKEN");
    return `export LEADFACTORY_MCP_TOKEN=${shellQuote(bearerToken)}\n${command.join(" ")}`;
  }

  return command.join(" ");
}

function buildCodexInstructions(publicAppUrl: string, mcpApiBaseUrl: string, remoteMcpUrl: string): string {
  return `Use the lead-research-factory MCP server as the control plane for lead research.

Operating model:
- Codex is the research director.
- The dashboard is for monitoring, settings, proxies, progress, and CSV export.
- Qwen and workers do bulk research.
- Codex should use MCP tools instead of manually operating browsers.

Normal workflow:
1. Check get_runtime_settings, system_health, and system_stats before creating a campaign.
2. Update Redis, Qwen, storage, browser, capacity, and provider runtime settings with update_runtime_settings when the user asks.
3. Create campaigns from the user's ICP prompt with create_campaign.
4. Use strict evidence. Unknown is better than guessed.
5. Inspect reusable providers with list_source_recipes, list_enrichment_providers, and list_email_verification_providers before creating new ones.
6. When a source needs custom browser handling, start Camoufox with start_debug_browser and inspect it with debug_browser_snapshot/open/click/type/extract/screenshot.
7. Convert the debug trail into a source recipe draft with debug_browser_recipe_draft, then save it with create_source_recipe.
8. When an HTTP API can enrich company/contact data, save it with create_enrichment_provider. Store reusable provider credentials in provider templates or server secrets.
9. When an HTTP API can verify discovered emails, save it with create_email_verification_provider. Map response fields so workers can mark valid/risky/invalid emails.
10. Reuse active providers before creating new ones. Use trial providers for one campaign, and global active providers when reusable.
11. Inspect leads, evidence, provider runs, and weak fields before presenting recommendations.
12. Pause, resume, cancel, audit, rerun analysis, and export through MCP when those tools are available.

Currently wired MCP tools:
- get_runtime_settings
- update_runtime_settings
- create_campaign
- create_source_recipe
- list_source_recipes
- get_source_recipe
- activate_source_recipe
- disable_source_recipe
- create_enrichment_provider
- list_enrichment_providers
- get_enrichment_provider
- activate_enrichment_provider
- disable_enrichment_provider
- create_email_verification_provider
- list_email_verification_providers
- get_email_verification_provider
- activate_email_verification_provider
- disable_email_verification_provider
- start_debug_browser
- list_debug_browsers
- debug_browser_snapshot
- debug_browser_open
- debug_browser_click
- debug_browser_type
- debug_browser_extract
- debug_browser_screenshot
- debug_browser_recipe_draft
- close_debug_browser
- system_stats
- parse_proxies
- upload_proxies
- list_campaigns
- get_campaign
- pause_campaign
- resume_campaign
- cancel_campaign
- get_leads
- get_lead_evidence
- export_campaign_csv
- system_health
- list_proxies

App endpoints:
- Dashboard: ${publicAppUrl}
- API base: ${mcpApiBaseUrl}
- Remote MCP: ${remoteMcpUrl}`;
}

function buildAllMcpInstructions(
  codexTomlConfig: string,
  codexCliCommand: string,
  mcpConfig: string,
  codexInstructions: string
): string {
  return `Codex config.toml:

${codexTomlConfig}

Codex CLI:

${codexCliCommand}

Claude-style JSON config:

${mcpConfig}

Codex instructions:

${codexInstructions}`;
}

function normalizePublicAppUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return defaultPublicAppUrl;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.search = "";
    if (url.pathname.replace(/\/+$/, "") === "/api") url.pathname = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

function deriveMcpApiBaseUrl(publicAppUrl: string): string {
  try {
    const url = new URL(publicAppUrl);
    const isLocalhost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (normalizedPath.endsWith("/api") || url.port === "4000") {
      return url.toString().replace(/\/$/, "");
    }

    if (isLocalhost && (!url.port || url.port === "3000")) {
      url.port = "4000";
      url.pathname = normalizedPath || "/";
      return url.toString().replace(/\/$/, "");
    }

    url.pathname = `${normalizedPath || ""}/api`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return publicAppUrl.replace(/\/$/, "");
  }
}

function deriveRemoteMcpUrl(publicAppUrl: string): string {
  const apiBase = deriveMcpApiBaseUrl(publicAppUrl);
  try {
    const url = new URL(apiBase);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = normalizedPath.endsWith("/mcp") ? normalizedPath : `${normalizedPath || ""}/mcp`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return `${apiBase.replace(/\/$/, "")}/mcp`;
  }
}

function tomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export default function DashboardPage() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignSummary, setCampaignSummary] =
    useState<CampaignListResponse["summary"]>(emptyCampaignSummary);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [isRefreshingCampaigns, setIsRefreshingCampaigns] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadSummary[]>([]);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [isRefreshingLeads, setIsRefreshingLeads] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);
  const [publicAppUrl, setPublicAppUrl] = useState(defaultPublicAppUrl);
  const [isPublicAppUrlLoaded, setIsPublicAppUrlLoaded] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeSettings | null>(null);
  const [runtimeSettingsError, setRuntimeSettingsError] = useState<string | null>(null);
  const [runtimeSettingsResult, setRuntimeSettingsResult] = useState<string | null>(null);
  const [isSavingRuntimeSettings, setIsSavingRuntimeSettings] = useState(false);
  const [proxyText, setProxyText] = useState("");
  const [proxyList, setProxyList] = useState<ProxyListResponse | null>(null);
  const [proxyResult, setProxyResult] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [isUploadingProxies, setIsUploadingProxies] = useState(false);
  const [sourceRecipes, setSourceRecipes] = useState<SourceRecipeSummary[]>([]);
  const [sourceRecipeSummary, setSourceRecipeSummary] =
    useState<SourceRecipeListResponse["summary"]>(emptySourceRecipeSummary);
  const [enrichmentProviders, setEnrichmentProviders] = useState<SavedProviderSummary[]>([]);
  const [enrichmentProviderSummary, setEnrichmentProviderSummary] =
    useState<ProviderListSummary>(emptySavedProviderSummary);
  const [emailVerificationProviders, setEmailVerificationProviders] = useState<SavedProviderSummary[]>([]);
  const [emailVerificationProviderSummary, setEmailVerificationProviderSummary] =
    useState<ProviderListSummary>(emptySavedProviderSummary);
  const [sourceRecipeError, setSourceRecipeError] = useState<string | null>(null);
  const [isRefreshingSourceRecipes, setIsRefreshingSourceRecipes] = useState(false);

  const moduleStatus = useMemo(() => {
    const byKey = new Map((health?.modules ?? []).map((module) => [module.key, module]));
    return {
      healthyCount: (health?.modules ?? []).filter((module) => module.status === "healthy").length,
      totalCount: health?.modules.length ?? 0,
      qwen: byKey.get("qwen"),
      camoufox: byKey.get("camoufox"),
      playwright: byKey.get("playwright")
    };
  }, [health]);

  const browserRuntimeReady =
    moduleStatus.camoufox?.status === "healthy" && moduleStatus.playwright?.status === "healthy";

  const dataProviderRows = useMemo<DataProviderRow[]>(
    () => [
      ...sourceRecipes.map((recipe) => ({
        ...recipe,
        type: "Discovery" as const,
        mode: `${recipe.steps.length} steps`
      })),
      ...enrichmentProviders.map((provider) => ({
        ...provider,
        type: "Enrichment" as const,
        mode: provider.runWhen ?? provider.kind
      })),
      ...emailVerificationProviders.map((provider) => ({
        ...provider,
        type: "Email Verify" as const,
        mode: `${provider.rateLimitPerMinute ?? "-"} rpm`
      }))
    ],
    [sourceRecipes, enrichmentProviders, emailVerificationProviders]
  );

  const dataProviderSummary = useMemo(
    () => combineProviderSummaries([sourceRecipeSummary, enrichmentProviderSummary, emailVerificationProviderSummary]),
    [sourceRecipeSummary, enrichmentProviderSummary, emailVerificationProviderSummary]
  );

  const normalizedPublicAppUrl = useMemo(() => normalizePublicAppUrl(publicAppUrl), [publicAppUrl]);
  const mcpApiBaseUrl = useMemo(() => deriveMcpApiBaseUrl(normalizedPublicAppUrl), [normalizedPublicAppUrl]);
  const remoteMcpUrl = useMemo(() => deriveRemoteMcpUrl(normalizedPublicAppUrl), [normalizedPublicAppUrl]);
  const mcpBearerToken = runtimeSettings?.mcpBearerToken ?? "";
  const mcpConfig = useMemo(() => buildMcpConfig(remoteMcpUrl, mcpBearerToken), [remoteMcpUrl, mcpBearerToken]);
  const codexTomlConfig = useMemo(
    () => buildCodexTomlConfig(remoteMcpUrl, mcpBearerToken),
    [remoteMcpUrl, mcpBearerToken]
  );
  const codexCliCommand = useMemo(
    () => buildCodexCliCommand(remoteMcpUrl, mcpBearerToken),
    [remoteMcpUrl, mcpBearerToken]
  );
  const codexInstructions = useMemo(
    () => buildCodexInstructions(normalizedPublicAppUrl, mcpApiBaseUrl, remoteMcpUrl),
    [normalizedPublicAppUrl, mcpApiBaseUrl, remoteMcpUrl]
  );
  const allMcpInstructions = useMemo(
    () => buildAllMcpInstructions(codexTomlConfig, codexCliCommand, mcpConfig, codexInstructions),
    [codexTomlConfig, codexCliCommand, mcpConfig, codexInstructions]
  );

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(publicAppUrlStorageKey);
    setPublicAppUrl(stored || window.location.origin);
    setIsPublicAppUrlLoaded(true);
  }, []);

  useEffect(() => {
    if (!isPublicAppUrlLoaded) return;
    window.localStorage.setItem(publicAppUrlStorageKey, publicAppUrl);
  }, [publicAppUrl, isPublicAppUrlLoaded]);

  async function refreshAll() {
    await Promise.all([refreshCampaigns(), refreshHealth(), refreshRuntimeSettings(), refreshProxies(), refreshSourceRecipes()]);
  }

  async function refreshCampaigns() {
    setIsRefreshingCampaigns(true);
    setCampaignError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/campaigns`);
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as CampaignListResponse;
      setCampaigns(payload.campaigns);
      setCampaignSummary(payload.summary);
      setSelectedCampaignId((current) => current ?? payload.campaigns[0]?.id ?? null);
    } catch (caught) {
      setCampaignError(caught instanceof Error ? caught.message : "Campaign list failed to load");
    } finally {
      setIsRefreshingCampaigns(false);
    }
  }

  async function refreshLeads(campaignId = selectedCampaignId) {
    if (!campaignId) {
      setLeads([]);
      return;
    }

    setIsRefreshingLeads(true);
    setLeadError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/campaigns/${campaignId}/leads`);
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as LeadListResponse;
      setLeads(payload.leads);
    } catch (caught) {
      setLeadError(caught instanceof Error ? caught.message : "Lead list failed to load");
    } finally {
      setIsRefreshingLeads(false);
    }
  }

  async function controlCampaign(campaignId: string, action: "pause" | "resume" | "cancel") {
    const response = await fetch(`${apiBaseUrl}/campaigns/${campaignId}/${action}`, {
      method: "POST"
    });
    if (!response.ok) {
      setCampaignError(await response.text());
      return;
    }
    await refreshCampaigns();
  }

  async function copyText(value: string, target: string) {
    await navigator.clipboard.writeText(value);
    setCopiedTarget(target);
    window.setTimeout(() => setCopiedTarget(null), 1600);
  }

  async function refreshHealth() {
    setIsRefreshingHealth(true);
    setHealthError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/system/health`);
      if (!response.ok) throw new Error(await response.text());
      setHealth((await response.json()) as HealthResponse);
    } catch (caught) {
      setHealthError(caught instanceof Error ? caught.message : "Health check failed");
    } finally {
      setIsRefreshingHealth(false);
    }
  }

  async function refreshRuntimeSettings() {
    setRuntimeSettingsError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/settings/runtime`);
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as RuntimeSettingsResponse;
      setRuntimeSettings(payload.settings);
      setRuntimeDefaults(payload.defaults);
    } catch (caught) {
      setRuntimeSettingsError(caught instanceof Error ? caught.message : "Settings failed to load");
    }
  }

  async function saveRuntimeSettings() {
    if (!runtimeSettings) return;
    setIsSavingRuntimeSettings(true);
    setRuntimeSettingsError(null);
    setRuntimeSettingsResult(null);
    try {
      const response = await fetch(`${apiBaseUrl}/settings/runtime`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runtimeSettings)
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as RuntimeSettingsResponse;
      setRuntimeSettings(payload.settings);
      setRuntimeDefaults(payload.defaults);
      setRuntimeSettingsResult("Settings saved");
      await refreshHealth();
    } catch (caught) {
      setRuntimeSettingsError(caught instanceof Error ? caught.message : "Settings save failed");
    } finally {
      setIsSavingRuntimeSettings(false);
    }
  }

  function updateRuntimeSetting<Key extends keyof RuntimeSettings>(key: Key, value: RuntimeSettings[Key]) {
    setRuntimeSettings((current) => (current ? { ...current, [key]: value } : current));
  }

  async function refreshProxies() {
    setProxyError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/proxies`);
      if (!response.ok) throw new Error(await response.text());
      setProxyList((await response.json()) as ProxyListResponse);
    } catch (caught) {
      setProxyError(caught instanceof Error ? caught.message : "Proxy list failed to load");
    }
  }

  async function refreshSourceRecipes() {
    setIsRefreshingSourceRecipes(true);
    setSourceRecipeError(null);
    try {
      const [sourceResponse, enrichmentResponse, emailVerificationResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/source-recipes`),
        fetch(`${apiBaseUrl}/enrichment-providers`),
        fetch(`${apiBaseUrl}/email-verification-providers`)
      ]);
      if (!sourceResponse.ok) throw new Error(await sourceResponse.text());
      if (!enrichmentResponse.ok) throw new Error(await enrichmentResponse.text());
      if (!emailVerificationResponse.ok) throw new Error(await emailVerificationResponse.text());
      const sourcePayload = (await sourceResponse.json()) as SourceRecipeListResponse;
      const enrichmentPayload = (await enrichmentResponse.json()) as SavedProviderListResponse;
      const emailVerificationPayload = (await emailVerificationResponse.json()) as SavedProviderListResponse;
      setSourceRecipes(sourcePayload.recipes);
      setSourceRecipeSummary(sourcePayload.summary);
      setEnrichmentProviders(enrichmentPayload.providers);
      setEnrichmentProviderSummary(enrichmentPayload.summary);
      setEmailVerificationProviders(emailVerificationPayload.providers);
      setEmailVerificationProviderSummary(emailVerificationPayload.summary);
    } catch (caught) {
      setSourceRecipeError(caught instanceof Error ? caught.message : "Provider list failed to load");
    } finally {
      setIsRefreshingSourceRecipes(false);
    }
  }

  async function updateSavedProviderStatus(endpoint: ProviderEndpoint, providerId: string, status: ProviderStatus) {
    setSourceRecipeError(null);
    const response = await fetch(`${apiBaseUrl}/${endpoint}/${providerId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      setSourceRecipeError(await response.text());
      return;
    }
    await refreshSourceRecipes();
  }

  async function uploadProxies() {
    setIsUploadingProxies(true);
    setProxyError(null);
    setProxyResult(null);
    try {
      const response = await fetch(`${apiBaseUrl}/proxies/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: proxyText })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { accepted: number; rejected: number };
      setProxyResult(`${payload.accepted} saved, ${payload.rejected} rejected`);
      setProxyText("");
      await refreshProxies();
      await refreshHealth();
    } catch (caught) {
      setProxyError(caught instanceof Error ? caught.message : "Proxy upload failed");
    } finally {
      setIsUploadingProxies(false);
    }
  }

  useEffect(() => {
    void refreshLeads(selectedCampaignId);
  }, [selectedCampaignId]);

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Lead Research Factory</h1>
          <p>Campaign operations</p>
        </div>
        <div className="actions">
          <button className="iconButton" title="Refresh" onClick={refreshAll} disabled={isRefreshingCampaigns || isRefreshingHealth}>
            <RefreshCw size={18} />
          </button>
          <a className="iconButton" title="Upload proxies" href="#proxies">
            <Upload size={18} />
          </a>
          <button
            className="iconButton"
            title="Export selected campaign CSV"
            disabled={!selectedCampaignId}
            onClick={() => {
              if (selectedCampaignId) window.location.href = `${apiBaseUrl}/campaigns/${selectedCampaignId}/export.csv`;
            }}
          >
            <Download size={18} />
          </button>
          <a className="iconButton" title="Settings" href="#settings">
            <Settings size={18} />
          </a>
        </div>
      </section>

      <section className="overviewGrid">
        <StatCard
          icon={<Activity size={18} />}
          label="Active Campaigns"
          value={String(campaignSummary.running + campaignSummary.queued)}
          detail={`${campaignSummary.total} total, ${campaignSummary.completed} completed`}
        />
        <StatCard
          icon={<Download size={18} />}
          label="Ranked Leads"
          value={String(campaignSummary.rankedLeads)}
          detail={`${campaignSummary.errors} research errors`}
        />
        <StatCard
          icon={<Server size={18} />}
          label="Runtime"
          value={browserRuntimeReady ? "ready" : "check"}
          detail={`${moduleStatus.healthyCount}/${moduleStatus.totalCount} modules healthy`}
        />
        <StatCard
          icon={<Cpu size={18} />}
          label="Server Load"
          value={health ? `${health.capacity.cpuUsagePercent ?? 0}%` : "-"}
          detail={health ? `${health.capacity.memoryUsagePercent ?? 0}% RAM, ${health.capacity.disk?.usagePercent ?? 0}% disk` : "waiting for API"}
        />
      </section>

      <section className="tablePanel campaignTablePanel">
        <div className="panelHeader">
          <h2>Campaigns</h2>
          <button className="copyButton" onClick={refreshCampaigns} disabled={isRefreshingCampaigns}>
            <RefreshCw size={16} />
            <span>{isRefreshingCampaigns ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
        {campaignError ? <pre className="error">{campaignError}</pre> : null}
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Discovered</th>
              <th>Researched</th>
              <th>Ranked</th>
              <th>Updated</th>
              <th>Controls</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id} className={selectedCampaignId === campaign.id ? "selectedRow" : undefined}>
                <td>
                  <div className="campaignCell">
                    <strong>{campaign.name}</strong>
                    <span>{truncate(campaign.prompt, 120)}</span>
                  </div>
                </td>
                <td>
                  <span className={`statusBadge ${campaign.status}`}>{campaign.status}</span>
                </td>
                <td>
                  <div className="progressCell">
                    <span>{campaign.progress.percent}%</span>
                    <div className="miniProgressTrack">
                      <div className="miniProgressFill" style={{ width: `${campaign.progress.percent}%` }} />
                    </div>
                  </div>
                </td>
                <td>{campaign.progress.discovered}</td>
                <td>{campaign.progress.researched}</td>
                <td>{campaign.progress.ranked}</td>
                <td>{formatDateTime(campaign.updatedAt)}</td>
                <td>
                  <div className="rowActions">
                    <button className="iconButton smallIconButton" title="View leads" onClick={() => setSelectedCampaignId(campaign.id)}>
                      <Eye size={15} />
                    </button>
                    <button
                      className="iconButton smallIconButton"
                      title="Resume campaign"
                      onClick={() => void controlCampaign(campaign.id, "resume")}
                      disabled={campaign.status !== "paused"}
                    >
                      <Play size={15} />
                    </button>
                    <button
                      className="iconButton smallIconButton"
                      title="Pause campaign"
                      onClick={() => void controlCampaign(campaign.id, "pause")}
                      disabled={!["queued", "running"].includes(campaign.status)}
                    >
                      <Pause size={15} />
                    </button>
                    <button
                      className="iconButton smallIconButton"
                      title="Cancel campaign"
                      onClick={() => void controlCampaign(campaign.id, "cancel")}
                      disabled={["completed", "failed", "cancelled"].includes(campaign.status)}
                    >
                      <Square size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {campaigns.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="emptyState">Campaigns created through MCP will appear here.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="tablePanel leadsPanel">
        <div className="panelHeader">
          <div>
            <h2>Ranked Leads</h2>
            <span>{selectedCampaignId ? campaigns.find((campaign) => campaign.id === selectedCampaignId)?.name : "No campaign selected"}</span>
          </div>
          <div className="copyActions">
            <button className="copyButton" onClick={() => refreshLeads()} disabled={!selectedCampaignId || isRefreshingLeads}>
              <RefreshCw size={16} />
              <span>{isRefreshingLeads ? "Refreshing" : "Refresh"}</span>
            </button>
            <button
              className="copyButton"
              disabled={!selectedCampaignId}
              onClick={() => {
                if (selectedCampaignId) window.location.href = `${apiBaseUrl}/campaigns/${selectedCampaignId}/export.csv`;
              }}
            >
              <Download size={16} />
              <span>CSV</span>
            </button>
          </div>
        </div>
        {leadError ? <pre className="error">{leadError}</pre> : null}
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Company</th>
              <th>Score</th>
              <th>Public Emails</th>
              <th>Owners / Managers</th>
              <th>Signal</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>{lead.rank ?? "-"}</td>
                <td>
                  <div className="campaignCell">
                    <strong>{lead.companyName}</strong>
                    {lead.website ? <a href={lead.website} target="_blank">{lead.website}</a> : <span>{lead.location || lead.status}</span>}
                  </div>
                </td>
                <td>
                  <strong>{lead.score}</strong>
                  <span className="mutedText">{Math.round(lead.confidence * 100)}%</span>
                </td>
                <td>{lead.emails.length ? lead.emails.join(", ") : "-"}</td>
                <td>{formatPeople([...lead.owners, ...lead.managers]) || "-"}</td>
                <td>{lead.strongestSignal ?? "-"}</td>
                <td>
                  {lead.evidence[0] ? (
                    <a href={lead.evidence[0].url} target="_blank">
                      {truncate(lead.evidence[0].quote, 80)}
                    </a>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
            {selectedCampaignId && leads.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="emptyState">Leads will appear here after browser research and Qwen analysis finish.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="settingsSection" id="settings">
        <div className="panelHeader">
          <h2>MCP Settings</h2>
          <div className="copyActions">
            <button className="copyButton" onClick={() => copyText(codexTomlConfig, "codex-config")}>
              {copiedTarget === "codex-config" ? <Check size={16} /> : <Copy size={16} />}
              <span>Codex Config</span>
            </button>
            <button className="copyButton" onClick={() => copyText(codexCliCommand, "codex-cli")}>
              {copiedTarget === "codex-cli" ? <Check size={16} /> : <Copy size={16} />}
              <span>CLI</span>
            </button>
            <button className="copyButton" onClick={() => copyText(codexInstructions, "instructions")}>
              {copiedTarget === "instructions" ? <Check size={16} /> : <Copy size={16} />}
              <span>Instructions</span>
            </button>
            <button className="copyButton primaryCopy" onClick={() => copyText(allMcpInstructions, "all")}>
              {copiedTarget === "all" ? <Check size={16} /> : <Copy size={16} />}
              <span>All</span>
            </button>
          </div>
        </div>

        <div className="mcpEndpointRow">
          <label className="runtimeField publicUrlField">
            <span>Public App URL</span>
            <input
              type="url"
              value={publicAppUrl}
              onChange={(event) => setPublicAppUrl(event.target.value)}
              placeholder="https://factory.leadtechx.com"
            />
          </label>
          <div className="endpointPreview">
            <span>Remote MCP URL</span>
            <strong>{remoteMcpUrl}</strong>
          </div>
          <button className="copyButton" onClick={() => setPublicAppUrl(window.location.origin)}>
            <RefreshCw size={16} />
            <span>Current</span>
          </button>
        </div>

        <div className="runtimePanel">
          <div className="sectionHeader">
            <div>
              <h2>Runtime Settings</h2>
              <span>{runtimeSettings ? "Saved in database" : "Waiting for API"}</span>
            </div>
            <div className="copyActions">
              <button className="copyButton" onClick={refreshRuntimeSettings}>
                <RefreshCw size={16} />
                <span>Reload</span>
              </button>
              <button
                className="copyButton"
                onClick={() => runtimeDefaults && setRuntimeSettings(runtimeDefaults)}
                disabled={!runtimeDefaults}
              >
                <Settings size={16} />
                <span>Defaults</span>
              </button>
              <button className="copyButton primaryCopy" onClick={saveRuntimeSettings} disabled={!runtimeSettings || isSavingRuntimeSettings}>
                <Check size={16} />
                <span>{isSavingRuntimeSettings ? "Saving" : "Save"}</span>
              </button>
            </div>
          </div>

          {runtimeSettingsError ? <pre className="error">{runtimeSettingsError}</pre> : null}
          {runtimeSettingsResult ? <span className="successText">{runtimeSettingsResult}</span> : null}

          {runtimeSettings ? (
            <div className="runtimeForm">
              <div className="runtimeGroup">
                <h3>Core</h3>
                <div className="runtimeGrid">
                  <RuntimeTextInput
                    label="Redis URL"
                    value={runtimeSettings.redisUrl}
                    onChange={(value) => updateRuntimeSetting("redisUrl", value)}
                  />
                  <RuntimeTextInput
                    label="Qwen Base URL"
                    value={runtimeSettings.localLlmBaseUrl}
                    onChange={(value) => updateRuntimeSetting("localLlmBaseUrl", value)}
                  />
                  <RuntimeTextInput
                    label="Qwen Model"
                    value={runtimeSettings.localLlmModel}
                    onChange={(value) => updateRuntimeSetting("localLlmModel", value)}
                  />
                  <RuntimeTextInput
                    label="Qwen API Key"
                    value={runtimeSettings.localLlmApiKey}
                    type="password"
                    onChange={(value) => updateRuntimeSetting("localLlmApiKey", value)}
                  />
                  <RuntimeTextInput
                    label="MCP Token"
                    value={runtimeSettings.mcpBearerToken}
                    type="password"
                    onChange={(value) => updateRuntimeSetting("mcpBearerToken", value)}
                  />
                  <RuntimeTextInput
                    label="Storage Dir"
                    value={runtimeSettings.appStorageDir}
                    onChange={(value) => updateRuntimeSetting("appStorageDir", value)}
                  />
                </div>
              </div>

              <div className="runtimeGroup">
                <h3>Capacity</h3>
                <div className="runtimeGrid">
                  <RuntimeNumberInput
                    label="Server Usage %"
                    value={runtimeSettings.serverUsagePercent}
                    onChange={(value) => updateRuntimeSetting("serverUsagePercent", value)}
                  />
                  <RuntimeNumberInput
                    label="Max Browsers"
                    value={runtimeSettings.maxBrowsersHardCap}
                    onChange={(value) => updateRuntimeSetting("maxBrowsersHardCap", value)}
                  />
                  <RuntimeNumberInput
                    label="Max Qwen"
                    value={runtimeSettings.maxQwenConcurrency}
                    onChange={(value) => updateRuntimeSetting("maxQwenConcurrency", value)}
                  />
                  <RuntimeNumberInput
                    label="Runtime Min"
                    value={runtimeSettings.maxCampaignRuntimeMinutes}
                    onChange={(value) => updateRuntimeSetting("maxCampaignRuntimeMinutes", value)}
                  />
                  <RuntimeNumberInput
                    label="Pages / Lead"
                    value={runtimeSettings.maxPagesPerLead}
                    onChange={(value) => updateRuntimeSetting("maxPagesPerLead", value)}
                  />
                  <RuntimeNumberInput
                    label="Proxy Retries"
                    value={runtimeSettings.proxyRetryCount}
                    onChange={(value) => updateRuntimeSetting("proxyRetryCount", value)}
                  />
                </div>
              </div>

              <div className="runtimeGroup">
                <h3>Browser</h3>
                <div className="runtimeGrid">
                  <RuntimeToggle
                    label="Browser First"
                    checked={runtimeSettings.browserFirst}
                    onChange={(value) => updateRuntimeSetting("browserFirst", value)}
                  />
                  <RuntimeToggle
                    label="Headless"
                    checked={runtimeSettings.browserHeadless}
                    onChange={(value) => updateRuntimeSetting("browserHeadless", value)}
                  />
                  <RuntimeNumberInput
                    label="Discovery Limit"
                    value={runtimeSettings.maxDiscoveryResults}
                    onChange={(value) => updateRuntimeSetting("maxDiscoveryResults", value)}
                  />
                  <RuntimeNumberInput
                    label="Search Retries"
                    value={runtimeSettings.searchRetryCount}
                    onChange={(value) => updateRuntimeSetting("searchRetryCount", value)}
                  />
                  <RuntimeNumberInput
                    label="Action Timeout"
                    value={runtimeSettings.browserActionTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("browserActionTimeoutMs", value)}
                  />
                  <RuntimeNumberInput
                    label="Nav Timeout"
                    value={runtimeSettings.browserNavigationTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("browserNavigationTimeoutMs", value)}
                  />
                </div>
              </div>

              <div className="runtimeGroup">
                <h3>Providers</h3>
                <div className="runtimeGrid">
                  <RuntimeNumberInput
                    label="Source Recipes"
                    value={runtimeSettings.maxActiveSourceRecipes}
                    onChange={(value) => updateRuntimeSetting("maxActiveSourceRecipes", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Results"
                    value={runtimeSettings.sourceRecipeResultLimit}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeResultLimit", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Queries"
                    value={runtimeSettings.sourceRecipeMaxQueries}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeMaxQueries", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Seeds"
                    value={runtimeSettings.sourceRecipeMaxSeeds}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeMaxSeeds", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Pages"
                    value={runtimeSettings.sourceRecipeMaxPages}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeMaxPages", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Retries"
                    value={runtimeSettings.sourceRecipeRetryCount}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeRetryCount", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Auto Active"
                    value={runtimeSettings.sourceRecipeAutoActivateAfter}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeAutoActivateAfter", value)}
                  />
                  <RuntimeNumberInput
                    label="Recipe Auto Disable"
                    value={runtimeSettings.sourceRecipeAutoDisableAfter}
                    onChange={(value) => updateRuntimeSetting("sourceRecipeAutoDisableAfter", value)}
                  />
                  <RuntimeNumberInput
                    label="Enrichment APIs"
                    value={runtimeSettings.maxActiveEnrichmentProviders}
                    onChange={(value) => updateRuntimeSetting("maxActiveEnrichmentProviders", value)}
                  />
                  <RuntimeNumberInput
                    label="Email Verify APIs"
                    value={runtimeSettings.maxActiveEmailVerificationProviders}
                    onChange={(value) => updateRuntimeSetting("maxActiveEmailVerificationProviders", value)}
                  />
                  <RuntimeNumberInput
                    label="Emails / Lead"
                    value={runtimeSettings.maxEmailsToVerifyPerLead}
                    onChange={(value) => updateRuntimeSetting("maxEmailsToVerifyPerLead", value)}
                  />
                  <RuntimeNumberInput
                    label="Provider Auto Active"
                    value={runtimeSettings.providerAutoActivateAfter}
                    onChange={(value) => updateRuntimeSetting("providerAutoActivateAfter", value)}
                  />
                  <RuntimeNumberInput
                    label="Provider Auto Disable"
                    value={runtimeSettings.providerAutoDisableAfter}
                    onChange={(value) => updateRuntimeSetting("providerAutoDisableAfter", value)}
                  />
                  <RuntimeToggle
                    label="Rate Limits"
                    checked={runtimeSettings.providerEnforceRateLimits}
                    onChange={(value) => updateRuntimeSetting("providerEnforceRateLimits", value)}
                  />
                  <RuntimeNumberInput
                    label="Max Rate Delay"
                    value={runtimeSettings.providerMaxRateDelayMs}
                    onChange={(value) => updateRuntimeSetting("providerMaxRateDelayMs", value)}
                  />
                </div>
              </div>

              <div className="runtimeGroup">
                <h3>Analysis</h3>
                <div className="runtimeGrid">
                  <RuntimeNumberInput
                    label="Qwen Timeout"
                    value={runtimeSettings.qwenTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("qwenTimeoutMs", value)}
                  />
                  <RuntimeNumberInput
                    label="Source Chars"
                    value={runtimeSettings.qwenMaxSourceChars}
                    onChange={(value) => updateRuntimeSetting("qwenMaxSourceChars", value)}
                  />
                </div>
              </div>

              <div className="runtimeGroup">
                <h3>Debug Browser</h3>
                <div className="runtimeGrid">
                  <RuntimeHeadlessSelect
                    label="Debug Headless"
                    value={runtimeSettings.debugBrowserHeadless}
                    onChange={(value) => updateRuntimeSetting("debugBrowserHeadless", value)}
                  />
                  <RuntimeNumberInput
                    label="Debug Sessions"
                    value={runtimeSettings.debugBrowserMaxSessions}
                    onChange={(value) => updateRuntimeSetting("debugBrowserMaxSessions", value)}
                  />
                  <RuntimeNumberInput
                    label="Debug Action"
                    value={runtimeSettings.debugBrowserActionTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("debugBrowserActionTimeoutMs", value)}
                  />
                  <RuntimeNumberInput
                    label="Debug Nav"
                    value={runtimeSettings.debugBrowserNavigationTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("debugBrowserNavigationTimeoutMs", value)}
                  />
                  <RuntimeNumberInput
                    label="Debug Connect"
                    value={runtimeSettings.debugBrowserConnectTimeoutMs}
                    onChange={(value) => updateRuntimeSetting("debugBrowserConnectTimeoutMs", value)}
                  />
                  <RuntimeNumberInput
                    label="Debug Text"
                    value={runtimeSettings.debugBrowserMaxTextChars}
                    onChange={(value) => updateRuntimeSetting("debugBrowserMaxTextChars", value)}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="emptyState">Runtime settings will appear when the API is running.</div>
          )}
        </div>

        <div className="proxyPanel" id="proxies">
          <div className="sectionHeader">
            <div>
              <h2>Proxy Pool</h2>
              <span>
                {proxyList
                  ? `${proxyList.summary.total} total, ${proxyList.summary.healthy} healthy, ${proxyList.summary.untested} untested`
                  : "Waiting for API"}
              </span>
            </div>
            <button className="copyButton" onClick={refreshProxies}>
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
          </div>
          <div className="proxyUploadGrid">
            <textarea
              className="proxyTextarea"
              value={proxyText}
              onChange={(event) => setProxyText(event.target.value)}
              placeholder="http://user:pass@host:port&#10;socks5://user:pass@host:port"
            />
            <div className="proxySummaryBox">
              <strong>Pool Status</strong>
              <p>{proxyList ? `${proxyList.summary.degraded} degraded, ${proxyList.summary.quarantined} quarantined` : "No proxy data yet"}</p>
              <button className="copyButton primaryCopy" onClick={uploadProxies} disabled={!proxyText.trim() || isUploadingProxies}>
                <Upload size={16} />
                <span>{isUploadingProxies ? "Saving" : "Save Proxies"}</span>
              </button>
              {proxyResult ? <span className="successText">{proxyResult}</span> : null}
              {proxyError ? <pre className="error">{proxyError}</pre> : null}
            </div>
          </div>
        </div>

        <div className="providerPanel">
          <div className="sectionHeader">
            <div>
              <h2>Data Providers</h2>
              <span>
                {dataProviderSummary.total
                  ? `${dataProviderSummary.active} active, ${dataProviderSummary.trial} trial, ${dataProviderSummary.disabled} disabled`
                  : "Providers created through MCP will appear here"}
              </span>
            </div>
            <button className="copyButton" onClick={refreshSourceRecipes} disabled={isRefreshingSourceRecipes}>
              <RefreshCw size={16} />
              <span>{isRefreshingSourceRecipes ? "Refreshing" : "Refresh"}</span>
            </button>
          </div>

          {sourceRecipeError ? <pre className="error">{sourceRecipeError}</pre> : null}

          <div className="providerSummaryGrid">
            <HealthMetric
              icon={<Database size={18} />}
              label="Discovery"
              value={String(sourceRecipeSummary.total)}
              detail={`${sourceRecipeSummary.successes} successful runs`}
            />
            <HealthMetric
              icon={<Activity size={18} />}
              label="Enrichment"
              value={String(enrichmentProviderSummary.total)}
              detail={`${enrichmentProviderSummary.active} active`}
            />
            <HealthMetric
              icon={<Check size={18} />}
              label="Email Verify"
              value={String(emailVerificationProviderSummary.total)}
              detail={`${emailVerificationProviderSummary.active} active`}
            />
          </div>

          <div className="providerTableWrap">
            <table className="providerTable">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Scope</th>
                  <th>Domains</th>
                  <th>Mode</th>
                  <th>Runs</th>
                  <th>Updated</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {dataProviderRows.map((provider) => (
                  <tr key={`${provider.type}-${provider.id}`}>
                    <td>
                      <span className={`providerTypeBadge ${provider.type.toLowerCase().replace(/\s+/g, "")}`}>
                        {provider.type}
                      </span>
                    </td>
                    <td>
                      <div className="campaignCell">
                        <strong>{provider.name}</strong>
                        <span>{providerDescription(provider)}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`statusBadge ${provider.status}`}>{provider.status}</span>
                    </td>
                    <td>{provider.campaignId ? "campaign" : "global"}</td>
                    <td>
                      <div className="providerDomains">
                        {provider.supportedDomains.slice(0, 4).map((domain) => (
                          <span key={domain}>{domain}</span>
                        ))}
                        {provider.supportedDomains.length > 4 ? <span>+{provider.supportedDomains.length - 4}</span> : null}
                        {provider.supportedDomains.length === 0 ? "-" : null}
                      </div>
                    </td>
                    <td>{provider.mode}</td>
                    <td>
                      <div className="providerRuns">
                        <span>
                          {provider.successCount} ok / {provider.failureCount} fail
                        </span>
                        {"missingEnvVars" in provider && provider.missingEnvVars.length ? (
                          <span className="providerWarning">{provider.missingEnvVars.length} env missing</span>
                        ) : null}
                      </div>
                    </td>
                    <td>{formatDateTime(provider.updatedAt)}</td>
                    <td>
                      <div className="rowActions">
                        <button
                          className="iconButton smallIconButton"
                          title="Activate provider"
                          onClick={() => void updateSavedProviderStatus(providerEndpoint(provider.type), provider.id, "active")}
                          disabled={provider.status === "active"}
                        >
                          <Play size={15} />
                        </button>
                        <button
                          className="iconButton smallIconButton"
                          title="Disable provider"
                          onClick={() => void updateSavedProviderStatus(providerEndpoint(provider.type), provider.id, "disabled")}
                          disabled={provider.status === "disabled"}
                        >
                          <Square size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {dataProviderRows.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <div className="emptyState">No reusable data providers saved yet.</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="healthPanel">
          <div className="sectionHeader">
            <div>
              <h2>System Health</h2>
              <span>{health ? `Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : "Waiting for API"}</span>
            </div>
            <button className="copyButton" onClick={refreshHealth} disabled={isRefreshingHealth}>
              <RefreshCw size={16} />
              <span>{isRefreshingHealth ? "Checking" : "Refresh"}</span>
            </button>
          </div>

          {healthError ? <pre className="error">{healthError}</pre> : null}

          <div className="hardwareGrid">
            <HealthMetric
              icon={<Cpu size={18} />}
              label="CPU"
              value={health ? `${health.capacity.cpuUsagePercent ?? 0}%` : "-"}
              detail={health ? `${health.capacity.cpuCores} cores, load ${formatNumber(health.capacity.loadAverage1m)}` : "Not checked"}
            />
            <HealthMetric
              icon={<Activity size={18} />}
              label="RAM"
              value={health ? `${health.capacity.memoryUsagePercent ?? 0}%` : "-"}
              detail={
                health
                  ? `${formatBytes(health.capacity.usedMemoryBytes)} / ${formatBytes(health.capacity.totalMemoryBytes)}`
                  : "Not checked"
              }
            />
            <HealthMetric
              icon={<HardDrive size={18} />}
              label="Disk"
              value={health?.capacity.disk ? `${health.capacity.disk.usagePercent}%` : "-"}
              detail={
                health?.capacity.disk
                  ? `${formatBytes(health.capacity.disk.availableBytes)} free`
                  : "Disk probe unavailable"
              }
            />
            <HealthMetric
              icon={<Server size={18} />}
              label="GPU"
              value={formatGpuValue(health?.capacity.gpu)}
              detail={formatGpuDetail(health?.capacity.gpu)}
            />
          </div>

          <div className="moduleGrid">
            {(health?.modules ?? []).map((module) => (
              <div className="moduleRow" key={module.key}>
                <span className={`statusDot ${module.status}`} />
                <div>
                  <strong>{module.label}</strong>
                  <p>{module.version ?? module.detail ?? statusLabel(module.status)}</p>
                </div>
                <span className={`statusPill ${module.status}`}>{statusLabel(module.status)}</span>
              </div>
            ))}
            {!health && !healthError ? <div className="moduleEmpty">Health data will appear when the API is running.</div> : null}
          </div>
        </div>

        <div className="settingsGrid">
          <div className="settingsBlock">
            <div className="blockTitle">
              <strong>Codex config</strong>
              <span>config.toml</span>
            </div>
            <pre>{codexTomlConfig}</pre>
          </div>

          <div className="settingsBlock">
            <div className="blockTitle">
              <strong>Codex CLI</strong>
              <span>direct HTTP</span>
            </div>
            <pre>{codexCliCommand}</pre>
          </div>

          <div className="settingsBlock">
            <div className="blockTitle">
              <strong>JSON config</strong>
              <span>mcp-remote</span>
            </div>
            <pre>{mcpConfig}</pre>
          </div>

          <div className="settingsBlock">
            <div className="blockTitle">
              <strong>Codex instructions</strong>
              <span>control plane</span>
            </div>
            <pre>{codexInstructions}</pre>
          </div>
        </div>
      </section>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="statCard">
      <div className="statIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function HealthMetric({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="healthMetric">
      <div className="metricIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function RuntimeTextInput({
  label,
  value,
  type = "text",
  onChange
}: {
  label: string;
  value: string;
  type?: "text" | "password";
  onChange: (value: string) => void;
}) {
  return (
    <label className="runtimeField">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function RuntimeNumberInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="runtimeField">
      <span>{label}</span>
      <input
        type="number"
        value={String(value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </label>
  );
}

function RuntimeToggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="runtimeToggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function RuntimeHeadlessSelect({
  label,
  value,
  onChange
}: {
  label: string;
  value: DebugBrowserHeadless;
  onChange: (value: DebugBrowserHeadless) => void;
}) {
  return (
    <label className="runtimeField">
      <span>{label}</span>
      <select value={debugHeadlessToString(value)} onChange={(event) => onChange(debugHeadlessFromString(event.target.value))}>
        <option value="virtual">virtual</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    </label>
  );
}

function formatBytes(value?: number): string {
  if (!value || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function formatMiB(value?: number): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${value} MB`;
}

function formatGpuValue(gpu?: HealthResponse["capacity"]["gpu"]): string {
  if (!gpu?.available) return "none";
  if (typeof gpu.utilizationPercent === "number" && !Number.isNaN(gpu.utilizationPercent)) {
    return `${gpu.utilizationPercent}%`;
  }
  return "detected";
}

function formatGpuDetail(gpu?: HealthResponse["capacity"]["gpu"]): string {
  if (!gpu?.available) {
    return gpu?.detail ?? "No GPU visible inside this container";
  }

  const name = gpu.name ?? "GPU";
  const hasMemory = typeof gpu.memoryUsedMiB === "number" || typeof gpu.memoryTotalMiB === "number";
  if (hasMemory) {
    return `${name} ${formatMiB(gpu.memoryUsedMiB)} / ${formatMiB(gpu.memoryTotalMiB)}`;
  }

  if (gpu.detectionSource) return `${name} via ${gpu.detectionSource}`;
  return name;
}

function formatNumber(value?: number): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toFixed(2);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1)}...`;
}

function formatPeople(people: Person[]): string {
  const seen = new Set<string>();
  return people
    .filter((person) => {
      const key = `${person.name}|${person.role ?? ""}|${person.email ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6)
    .map((person) => `${person.name}${person.role ? ` (${person.role})` : ""}${person.email ? ` <${person.email}>` : ""}`)
    .join(", ");
}

function combineProviderSummaries(summaries: ProviderListSummary[]): ProviderListSummary {
  return summaries.reduce(
    (combined, summary) => ({
      total: combined.total + summary.total,
      active: combined.active + summary.active,
      trial: combined.trial + summary.trial,
      disabled: combined.disabled + summary.disabled,
      successes: combined.successes + summary.successes,
      failures: combined.failures + summary.failures
    }),
    { ...emptySavedProviderSummary }
  );
}

function providerDescription(provider: DataProviderRow): string {
  if (provider.type === "Discovery") {
    return provider.description || `${provider.discoveryQueries.length} queries, ${provider.seedUrls.length} seed URLs`;
  }
  return provider.description || `${provider.kind} provider, ${provider.requiredEnvVars.length} env vars`;
}

function providerEndpoint(type: DataProviderRow["type"]): ProviderEndpoint {
  switch (type) {
    case "Discovery":
      return "source-recipes";
    case "Enrichment":
      return "enrichment-providers";
    case "Email Verify":
      return "email-verification-providers";
  }
}

function debugHeadlessToString(value: DebugBrowserHeadless): string {
  if (value === "virtual") return "virtual";
  return value ? "true" : "false";
}

function debugHeadlessFromString(value: string): DebugBrowserHeadless {
  if (value === "virtual") return "virtual";
  return value === "true";
}

function statusLabel(status: ModuleHealth["status"]): string {
  switch (status) {
    case "healthy":
      return "installed";
    case "degraded":
      return "degraded";
    case "missing":
      return "missing";
    case "unreachable":
      return "unreachable";
  }
}
