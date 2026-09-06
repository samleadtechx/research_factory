import { ProxyInputSchema, type ProxyInput } from "@leadfactory/schemas";

export type ProxyParseResult = {
  proxies: ProxyInput[];
  errors: Array<{ line: number; value: string; reason: string }>;
};

export function parseProxyText(text: string): ProxyParseResult {
  const proxies: ProxyInput[] = [];
  const errors: Array<{ line: number; value: string; reason: string }> = [];

  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line, index) => {
      if (!line || line.startsWith("#")) return;

      const parsed = parseProxyLine(line);
      if (parsed.ok) {
        proxies.push(parsed.proxy);
      } else {
        errors.push({ line: index + 1, value: line, reason: parsed.reason });
      }
    });

  return { proxies, errors };
}

export function parseProxyLine(
  line: string
): { ok: true; proxy: ProxyInput } | { ok: false; reason: string } {
  try {
    const value = line.includes("://") ? line : `http://${line}`;
    const url = new URL(value);
    const protocol = url.protocol.replace(":", "");

    const candidate = {
      protocol,
      host: url.hostname,
      port: Number(url.port),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined
    };

    const result = ProxyInputSchema.safeParse(candidate);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error.issues.map((issue: { message: string }) => issue.message).join("; ")
      };
    }

    return { ok: true, proxy: result.data };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "invalid proxy" };
  }
}

export function proxyCacheKey(proxy: ProxyInput): string {
  const auth = proxy.username ? `${proxy.username}@` : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

export function redactProxy(proxy: ProxyInput): string {
  const auth = proxy.username ? `${proxy.username}:***@` : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}
