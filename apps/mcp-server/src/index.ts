import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

const server = new McpServer({
  name: "lead-research-factory",
  version: "0.1.0"
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
