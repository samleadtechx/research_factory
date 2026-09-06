import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

const configuredTargetBaseUrl = process.env.DASHBOARD_API_PROXY_TARGET ?? process.env.API_BASE_URL;
const targetBaseUrls = configuredTargetBaseUrl
  ? [configuredTargetBaseUrl]
  : ["http://localhost:4000", "http://api:4000"];

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

async function proxyRequest(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const incomingUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-leadfactory-public-api-base-url", publicApiBaseUrl(incomingUrl, path));
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();

  let lastError: unknown;
  for (const targetBaseUrl of targetBaseUrls) {
    const upstreamUrl = new URL(path.join("/"), ensureTrailingSlash(targetBaseUrl));
    upstreamUrl.search = incomingUrl.search;

    try {
      const response = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
        duplex: "half"
      } as RequestInit & { duplex: "half" });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      lastError = error;
    }
  }

  return Response.json(
    {
      error: "api_proxy_unreachable",
      targets: targetBaseUrls,
      message: lastError instanceof Error ? lastError.message : "API proxy target is unreachable"
    },
    { status: 502 }
  );
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function publicApiBaseUrl(incomingUrl: URL, path: string[]): string {
  const externalUrl = new URL(incomingUrl.origin);
  const normalizedPath = incomingUrl.pathname.replace(/\/+$/, "");
  const pathTail = `/${path.join("/")}`.replace(/\/+$/, "");

  externalUrl.pathname =
    pathTail && normalizedPath.endsWith(pathTail)
      ? normalizedPath.slice(0, -pathTail.length) || "/"
      : normalizedPath || "/";

  return externalUrl.toString().replace(/\/$/, "");
}
