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
const workspacePath = "/Users/bizrate/Documents/ChatGPT/Research_factory";
const mcpConfig = `{
  "mcpServers": {
    "lead-research-factory": {
      "command": "/bin/bash",
      "args": [
        "${workspacePath}/scripts/start-mcp.sh"
      ],
      "env": {
        "API_BASE_URL": "http://localhost:4000"
      }
    }
  }
}`;
const codexInstructions = `Use the lead-research-factory MCP server as the control plane for lead research.

Operating model:
- Codex is the research director.
- The dashboard is for monitoring, settings, proxies, progress, and CSV export.
- Qwen and workers do bulk research.
- Codex should use MCP tools instead of manually operating browsers.

Normal workflow:
1. Check system_stats before creating a campaign.
2. Create campaigns from the user's ICP prompt with create_campaign.
3. Use strict evidence. Unknown is better than guessed.
4. Inspect reusable providers with list_source_recipes, list_enrichment_providers, and list_email_verification_providers before creating new ones.
5. When a source needs custom browser handling, start Camoufox with start_debug_browser and inspect it with debug_browser_snapshot/open/click/type/extract/screenshot.
6. Convert the debug trail into a source recipe draft with debug_browser_recipe_draft, then save it with create_source_recipe.
7. When an HTTP API can enrich company/contact data, save it with create_enrichment_provider. Keep API keys in env vars and reference them as {env:VAR_NAME}.
8. When an HTTP API can verify discovered emails, save it with create_email_verification_provider. Map response fields so workers can mark valid/risky/invalid emails.
9. Reuse active providers before creating new ones. Use trial providers for one campaign, and global active providers when reusable.
10. Inspect leads, evidence, provider runs, and weak fields before presenting recommendations.
11. Pause, resume, cancel, audit, rerun analysis, and export through MCP when those tools are available.

Currently wired MCP tools:
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

Local app:
- Dashboard: http://localhost:3000
- API: http://localhost:4000
- MCP stdio launcher: ${workspacePath}/scripts/start-mcp.sh`;
const allMcpInstructions = `MCP config:

${mcpConfig}

Codex instructions:

${codexInstructions}`;

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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [isRefreshingHealth, setIsRefreshingHealth] = useState(false);
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

  useEffect(() => {
    void refreshAll();
  }, []);

  async function refreshAll() {
    await Promise.all([refreshCampaigns(), refreshHealth(), refreshProxies(), refreshSourceRecipes()]);
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
            <button className="copyButton" onClick={() => copyText(mcpConfig, "config")}>
              {copiedTarget === "config" ? <Check size={16} /> : <Copy size={16} />}
              <span>Config</span>
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
              value={health?.capacity.gpu.available ? `${health.capacity.gpu.utilizationPercent ?? 0}%` : "none"}
              detail={
                health?.capacity.gpu.available
                  ? `${health.capacity.gpu.name ?? "GPU"} ${formatMiB(health.capacity.gpu.memoryUsedMiB)} / ${formatMiB(health.capacity.gpu.memoryTotalMiB)}`
                  : "nvidia-smi not available"
              }
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
              <strong>Server config</strong>
              <span>stdio</span>
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
