import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const server = new McpServer({
  name: "lead-research-factory",
  version: "0.1.0"
});

const sourceRecipeStepInputSchema = z.object({
  action: z.enum([
    "open_url",
    "search_web",
    "click_selector",
    "extract_links",
    "extract_text",
    "extract_structured_fields",
    "paginate"
  ]),
  selector: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const debugBrowserHeadlessSchema = z.union([z.boolean(), z.literal("virtual")]);

const providerRequestInputSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH"]).optional(),
  urlTemplate: z.string().min(1),
  headersTemplate: z.record(z.string().min(1), z.string()).optional(),
  queryTemplate: z.record(z.string().min(1), z.string()).optional(),
  bodyTemplate: z.unknown().optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  retryCount: z.number().int().min(0).max(5).optional()
});

const enrichmentOutputMappingInputSchema = z.object({
  companyNamePath: z.string().min(1).optional(),
  websitePath: z.string().min(1).optional(),
  domainPath: z.string().min(1).optional(),
  phonePath: z.string().min(1).optional(),
  cityPath: z.string().min(1).optional(),
  statePath: z.string().min(1).optional(),
  countryPath: z.string().min(1).optional(),
  emailsPath: z.string().min(1).optional(),
  ownersPath: z.string().min(1).optional(),
  managersPath: z.string().min(1).optional(),
  decisionMakersPath: z.string().min(1).optional(),
  sourceUrlPath: z.string().min(1).optional(),
  evidenceQuotePath: z.string().min(1).optional(),
  confidencePath: z.string().min(1).optional()
});

const emailVerificationOutputMappingInputSchema = z.object({
  statusPath: z.string().min(1).optional(),
  normalizedEmailPath: z.string().min(1).optional(),
  scorePath: z.string().min(1).optional(),
  reasonPath: z.string().min(1).optional(),
  sourceUrlPath: z.string().min(1).optional(),
  evidenceQuotePath: z.string().min(1).optional(),
  deliverableValues: z.array(z.string().min(1)).optional(),
  invalidValues: z.array(z.string().min(1)).optional(),
  riskyValues: z.array(z.string().min(1)).optional()
});

server.registerTool(
  "create_campaign",
  {
    title: "Create Campaign",
    description: "Create and immediately queue a prompt-driven lead research campaign.",
    inputSchema: {
      prompt: z.string().min(20),
      name: z.string().optional(),
      targetLeadCount: z.number().int().positive().optional(),
      serverUsagePercent: z.number().int().min(1).max(100).optional()
    }
  },
  async (input) => jsonResult(await postJson("/campaigns", input))
);

server.registerTool(
  "list_campaigns",
  {
    title: "List Campaigns",
    description: "List campaign status, progress, and aggregate stats.",
    inputSchema: {}
  },
  async () => jsonResult(await getJson("/campaigns"))
);

server.registerTool(
  "get_campaign",
  {
    title: "Get Campaign",
    description: "Inspect one campaign with recent worker jobs.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/campaigns/${encodeURIComponent(input.campaignId)}`))
);

server.registerTool(
  "pause_campaign",
  {
    title: "Pause Campaign",
    description: "Pause a campaign so queued workers skip additional work.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/campaigns/${encodeURIComponent(input.campaignId)}/pause`, {}))
);

server.registerTool(
  "resume_campaign",
  {
    title: "Resume Campaign",
    description: "Resume a paused campaign and queue discovery again.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/campaigns/${encodeURIComponent(input.campaignId)}/resume`, {}))
);

server.registerTool(
  "cancel_campaign",
  {
    title: "Cancel Campaign",
    description: "Cancel a campaign so queued workers skip additional work.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/campaigns/${encodeURIComponent(input.campaignId)}/cancel`, {}))
);

server.registerTool(
  "get_leads",
  {
    title: "Get Leads",
    description: "List ranked and researched leads for a campaign.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/campaigns/${encodeURIComponent(input.campaignId)}/leads`))
);

server.registerTool(
  "get_lead_evidence",
  {
    title: "Get Lead Evidence",
    description: "Inspect all claims and evidence for a single lead.",
    inputSchema: {
      leadId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/leads/${encodeURIComponent(input.leadId)}/evidence`))
);

server.registerTool(
  "create_source_recipe",
  {
    title: "Create Source Recipe",
    description:
      "Save or update a reusable browser/search data provider recipe that future campaigns can run automatically.",
    inputSchema: {
      name: z.string().min(1).max(120),
      version: z.string().min(1).max(40).optional(),
      status: z.enum(["trial", "active", "disabled"]).optional(),
      campaignId: z.string().min(1).optional(),
      supportedDomains: z.array(z.string().min(1)).optional(),
      description: z.string().max(2000).optional(),
      discoveryQueries: z.array(z.string().min(1)).optional(),
      seedUrls: z.array(z.string().min(1)).optional(),
      steps: z.array(sourceRecipeStepInputSchema).optional(),
      outputMapping: z.record(z.string().min(1), z.string().min(1)).optional()
    }
  },
  async (input) => jsonResult(await postJson("/source-recipes", input))
);

server.registerTool(
  "list_source_recipes",
  {
    title: "List Source Recipes",
    description: "List reusable provider recipes, statuses, supported domains, and success/failure counters.",
    inputSchema: {
      campaignId: z.string().min(1).optional()
    }
  },
  async (input) => {
    const params = input.campaignId ? `?campaignId=${encodeURIComponent(input.campaignId)}` : "";
    return jsonResult(await getJson(`/source-recipes${params}`));
  }
);

server.registerTool(
  "get_source_recipe",
  {
    title: "Get Source Recipe",
    description: "Inspect one reusable provider recipe.",
    inputSchema: {
      recipeId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/source-recipes/${encodeURIComponent(input.recipeId)}`))
);

server.registerTool(
  "activate_source_recipe",
  {
    title: "Activate Source Recipe",
    description: "Mark a saved provider recipe active so discovery workers can reuse it.",
    inputSchema: {
      recipeId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/source-recipes/${encodeURIComponent(input.recipeId)}/activate`, {}))
);

server.registerTool(
  "disable_source_recipe",
  {
    title: "Disable Source Recipe",
    description: "Disable a provider recipe without deleting its history.",
    inputSchema: {
      recipeId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/source-recipes/${encodeURIComponent(input.recipeId)}/disable`, {}))
);

server.registerTool(
  "create_enrichment_provider",
  {
    title: "Create Enrichment Provider",
    description:
      "Save or update a reusable HTTP API enrichment provider for company, contact, owner, manager, phone, website, and email enrichment.",
    inputSchema: {
      name: z.string().min(1).max(120),
      version: z.string().min(1).max(40).optional(),
      status: z.enum(["trial", "active", "disabled"]).optional(),
      campaignId: z.string().min(1).optional(),
      supportedDomains: z.array(z.string().min(1)).optional(),
      description: z.string().max(2000).optional(),
      kind: z.enum(["http_api"]).optional(),
      request: providerRequestInputSchema,
      requiredEnvVars: z.array(z.string().min(1)).optional(),
      inputFields: z
        .array(z.enum(["companyName", "domain", "website", "city", "state", "country", "phone", "emails"]))
        .optional(),
      runWhen: z.enum(["always", "missing_email", "missing_decision_maker", "missing_contact_data"]).optional(),
      rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
      outputMapping: enrichmentOutputMappingInputSchema.optional()
    }
  },
  async (input) => jsonResult(await postJson("/enrichment-providers", input))
);

server.registerTool(
  "list_enrichment_providers",
  {
    title: "List Enrichment Providers",
    description: "List reusable enrichment providers, status, required env vars, domains, and run counters.",
    inputSchema: {
      campaignId: z.string().min(1).optional()
    }
  },
  async (input) => {
    const params = input.campaignId ? `?campaignId=${encodeURIComponent(input.campaignId)}` : "";
    return jsonResult(await getJson(`/enrichment-providers${params}`));
  }
);

server.registerTool(
  "get_enrichment_provider",
  {
    title: "Get Enrichment Provider",
    description: "Inspect one reusable enrichment provider config.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/enrichment-providers/${encodeURIComponent(input.providerId)}`))
);

server.registerTool(
  "activate_enrichment_provider",
  {
    title: "Activate Enrichment Provider",
    description: "Mark an enrichment provider active so analysis workers can use it.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/enrichment-providers/${encodeURIComponent(input.providerId)}/activate`, {}))
);

server.registerTool(
  "disable_enrichment_provider",
  {
    title: "Disable Enrichment Provider",
    description: "Disable an enrichment provider without deleting its history.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/enrichment-providers/${encodeURIComponent(input.providerId)}/disable`, {}))
);

server.registerTool(
  "create_email_verification_provider",
  {
    title: "Create Email Verification Provider",
    description:
      "Save or update a reusable HTTP API provider that verifies public business emails before final scoring/export.",
    inputSchema: {
      name: z.string().min(1).max(120),
      version: z.string().min(1).max(40).optional(),
      status: z.enum(["trial", "active", "disabled"]).optional(),
      campaignId: z.string().min(1).optional(),
      supportedDomains: z.array(z.string().min(1)).optional(),
      description: z.string().max(2000).optional(),
      kind: z.enum(["http_api"]).optional(),
      request: providerRequestInputSchema,
      requiredEnvVars: z.array(z.string().min(1)).optional(),
      rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
      outputMapping: emailVerificationOutputMappingInputSchema.optional()
    }
  },
  async (input) => jsonResult(await postJson("/email-verification-providers", input))
);

server.registerTool(
  "list_email_verification_providers",
  {
    title: "List Email Verification Providers",
    description: "List reusable email verification providers, status, required env vars, domains, and run counters.",
    inputSchema: {
      campaignId: z.string().min(1).optional()
    }
  },
  async (input) => {
    const params = input.campaignId ? `?campaignId=${encodeURIComponent(input.campaignId)}` : "";
    return jsonResult(await getJson(`/email-verification-providers${params}`));
  }
);

server.registerTool(
  "get_email_verification_provider",
  {
    title: "Get Email Verification Provider",
    description: "Inspect one reusable email verification provider config.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/email-verification-providers/${encodeURIComponent(input.providerId)}`))
);

server.registerTool(
  "activate_email_verification_provider",
  {
    title: "Activate Email Verification Provider",
    description: "Mark an email verification provider active so analysis workers can use it.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) =>
    jsonResult(await postJson(`/email-verification-providers/${encodeURIComponent(input.providerId)}/activate`, {}))
);

server.registerTool(
  "disable_email_verification_provider",
  {
    title: "Disable Email Verification Provider",
    description: "Disable an email verification provider without deleting its history.",
    inputSchema: {
      providerId: z.string().min(1)
    }
  },
  async (input) =>
    jsonResult(await postJson(`/email-verification-providers/${encodeURIComponent(input.providerId)}/disable`, {}))
);

server.registerTool(
  "export_campaign_csv",
  {
    title: "Export Campaign CSV",
    description: "Return the campaign CSV text and the dashboard/API download URL.",
    inputSchema: {
      campaignId: z.string().min(1)
    }
  },
  async (input) => {
    const path = `/campaigns/${encodeURIComponent(input.campaignId)}/export.csv`;
    const csv = await getText(path);
    return jsonResult({
      downloadUrl: `${apiBaseUrl}${path}`,
      csv
    });
  }
);

server.registerTool(
  "system_stats",
  {
    title: "System Stats",
    description: "Return capacity, settings, and computed worker limits.",
    inputSchema: {}
  },
  async () => jsonResult(await getJson("/system/capacity"))
);

server.registerTool(
  "system_health",
  {
    title: "System Health",
    description: "Check installed modules and hardware usage.",
    inputSchema: {}
  },
  async () => jsonResult(await getJson("/system/health"))
);

server.registerTool(
  "start_debug_browser",
  {
    title: "Start Debug Browser",
    description:
      "Start a Camoufox browser session for Codex-driven source debugging. Use this before creating a new source recipe.",
    inputSchema: {
      engine: z.enum(["camoufox", "playwright"]).optional(),
      startUrl: z.string().min(1).optional(),
      headless: debugBrowserHeadlessSchema.optional(),
      proxyStrategy: z.enum(["auto", "direct", "specific"]).optional(),
      proxyId: z.string().min(1).optional(),
      humanize: z.union([z.boolean(), z.number().min(0.1).max(10)]).optional(),
      geoip: z.boolean().optional(),
      locale: z.string().min(2).optional(),
      os: z.enum(["windows", "macos", "linux"]).optional()
    }
  },
  async (input) => jsonResult(await postJson("/debug-browser/sessions", input))
);

server.registerTool(
  "list_debug_browsers",
  {
    title: "List Debug Browsers",
    description: "List active debug browser sessions.",
    inputSchema: {}
  },
  async () => jsonResult(await getJson("/debug-browser/sessions"))
);

server.registerTool(
  "debug_browser_snapshot",
  {
    title: "Debug Browser Snapshot",
    description: "Inspect current page title, URL, text, links, controls, and a source recipe draft.",
    inputSchema: {
      sessionId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/debug-browser/sessions/${encodeURIComponent(input.sessionId)}`))
);

server.registerTool(
  "debug_browser_open",
  {
    title: "Debug Browser Open",
    description: "Open a URL in an active debug browser session.",
    inputSchema: {
      sessionId: z.string().min(1),
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional()
    }
  },
  async (input) => {
    const { sessionId, ...body } = input;
    return jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(sessionId)}/open`, body));
  }
);

server.registerTool(
  "debug_browser_click",
  {
    title: "Debug Browser Click",
    description: "Click a selector in an active debug browser session and return a fresh snapshot.",
    inputSchema: {
      sessionId: z.string().min(1),
      selector: z.string().min(1),
      timeoutMs: z.number().int().min(500).max(60000).optional()
    }
  },
  async (input) => {
    const { sessionId, ...body } = input;
    return jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(sessionId)}/click`, body));
  }
);

server.registerTool(
  "debug_browser_type",
  {
    title: "Debug Browser Type",
    description: "Type or fill text into a selector in an active debug browser session.",
    inputSchema: {
      sessionId: z.string().min(1),
      selector: z.string().min(1),
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
      timeoutMs: z.number().int().min(500).max(60000).optional()
    }
  },
  async (input) => {
    const { sessionId, ...body } = input;
    return jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(sessionId)}/type`, body));
  }
);

server.registerTool(
  "debug_browser_extract",
  {
    title: "Debug Browser Extract",
    description: "Extract links, text, HTML, or attributes from the current debug browser page.",
    inputSchema: {
      sessionId: z.string().min(1),
      selector: z.string().min(1).optional(),
      mode: z.enum(["links", "text", "html", "attribute"]).optional(),
      attribute: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional()
    }
  },
  async (input) => {
    const { sessionId, ...body } = input;
    return jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(sessionId)}/extract`, body));
  }
);

server.registerTool(
  "debug_browser_screenshot",
  {
    title: "Debug Browser Screenshot",
    description: "Save a screenshot from the current debug browser page and return its local path.",
    inputSchema: {
      sessionId: z.string().min(1),
      fullPage: z.boolean().optional()
    }
  },
  async (input) => {
    const { sessionId, ...body } = input;
    return jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(sessionId)}/screenshot`, body));
  }
);

server.registerTool(
  "debug_browser_recipe_draft",
  {
    title: "Debug Browser Recipe Draft",
    description: "Return a draft create_source_recipe payload from the debug browser trail.",
    inputSchema: {
      sessionId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await getJson(`/debug-browser/sessions/${encodeURIComponent(input.sessionId)}/recipe-draft`))
);

server.registerTool(
  "close_debug_browser",
  {
    title: "Close Debug Browser",
    description: "Close an active debug browser session.",
    inputSchema: {
      sessionId: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson(`/debug-browser/sessions/${encodeURIComponent(input.sessionId)}/close`, {}))
);

server.registerTool(
  "parse_proxies",
  {
    title: "Parse Proxies",
    description: "Validate pasted HTTP/SOCKS5 proxies before saving them.",
    inputSchema: {
      text: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson("/proxies/parse", input))
);

server.registerTool(
  "upload_proxies",
  {
    title: "Upload Proxies",
    description: "Save pasted HTTP/SOCKS5 proxies for browser rotation.",
    inputSchema: {
      text: z.string().min(1)
    }
  },
  async (input) => jsonResult(await postJson("/proxies/upload", input))
);

server.registerTool(
  "list_proxies",
  {
    title: "List Proxies",
    description: "Return proxy pool health and summary stats.",
    inputSchema: {}
  },
  async () => jsonResult(await getJson("/proxies"))
);

await server.connect(new StdioServerTransport());

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  return readApiResponse(response);
}

async function getText(path: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${text}`);
  }
  return text;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readApiResponse(response);
}

async function readApiResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Plain text responses stay readable in Codex.
  }

  if (!response.ok) {
    return {
      error: "api_error",
      status: response.status,
      body
    };
  }

  return body;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
