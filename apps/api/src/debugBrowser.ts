import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@leadfactory/database";
import type { RuntimeSettings } from "@leadfactory/schemas";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";

const DebugHeadlessSchema = z.union([z.boolean(), z.literal("virtual")]);
const ProxyStrategySchema = z.enum(["auto", "direct", "specific"]);

export const StartDebugBrowserInputSchema = z.object({
  engine: z.enum(["camoufox", "playwright"]).default("camoufox"),
  startUrl: z.string().trim().min(1).optional(),
  headless: DebugHeadlessSchema.optional(),
  proxyStrategy: ProxyStrategySchema.default("auto"),
  proxyId: z.string().trim().min(1).optional(),
  humanize: z.union([z.boolean(), z.number().min(0.1).max(10)]).default(true),
  geoip: z.boolean().default(true),
  locale: z.string().trim().min(2).optional(),
  os: z.enum(["windows", "macos", "linux"]).optional()
});

export const DebugBrowserSessionIdSchema = z.object({
  sessionId: z.string().trim().min(1)
});

export const DebugBrowserOpenInputSchema = z.object({
  url: z.string().trim().min(1),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("domcontentloaded")
});

export const DebugBrowserClickInputSchema = z.object({
  selector: z.string().trim().min(1),
  timeoutMs: z.number().int().min(500).max(60000).optional()
});

export const DebugBrowserTypeInputSchema = z.object({
  selector: z.string().trim().min(1),
  text: z.string(),
  clear: z.boolean().default(true),
  submit: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(60000).optional()
});

export const DebugBrowserExtractInputSchema = z.object({
  selector: z.string().trim().min(1).optional(),
  mode: z.enum(["links", "text", "html", "attribute"]).default("links"),
  attribute: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

export const DebugBrowserScreenshotInputSchema = z.object({
  fullPage: z.boolean().default(true)
});

type DebugBrowserStartInput = z.infer<typeof StartDebugBrowserInputSchema>;
type DebugBrowserOpenInput = z.infer<typeof DebugBrowserOpenInputSchema>;
type DebugBrowserClickInput = z.infer<typeof DebugBrowserClickInputSchema>;
type DebugBrowserTypeInput = z.infer<typeof DebugBrowserTypeInputSchema>;
type DebugBrowserExtractInput = z.infer<typeof DebugBrowserExtractInputSchema>;
type DebugBrowserScreenshotInput = z.infer<typeof DebugBrowserScreenshotInputSchema>;

type DebugBrowserEngine = DebugBrowserStartInput["engine"];
type DebugHeadless = z.infer<typeof DebugHeadlessSchema>;

type ProxyRecord = {
  id: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string;
  passwordEncrypted: string | null;
};

type DebugTrailStep = {
  action: "open_url" | "click_selector" | "type_text" | "extract_links" | "extract_text" | "extract_html" | "extract_attribute";
  selector?: string;
  value?: string;
  at: string;
};

type DebugBrowserSession = {
  id: string;
  engine: DebugBrowserEngine;
  headless: DebugHeadless;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  startedAt: Date;
  updatedAt: Date;
  proxy: SafeProxy | null;
  wsEndpoint?: string;
  camoufoxProcess?: ChildProcessWithoutNullStreams;
  launchLog: string;
  trail: DebugTrailStep[];
};

type LaunchedDebugBrowser = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  wsEndpoint?: string;
  camoufoxProcess?: ChildProcessWithoutNullStreams;
  launchLog?: string;
};

type SafeProxy = {
  id: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
};

type PlaywrightProxy = {
  server: string;
  username?: string;
  password?: string;
};

type DebugBrowserControllerOptions = {
  rootDir: string;
  storageDir: string;
  getSettings?: () => Promise<RuntimeSettings>;
};

type DebugBrowserRuntimeSettings = Pick<
  RuntimeSettings,
  | "appStorageDir"
  | "debugBrowserActionTimeoutMs"
  | "debugBrowserConnectTimeoutMs"
  | "debugBrowserHeadless"
  | "debugBrowserMaxSessions"
  | "debugBrowserMaxTextChars"
  | "debugBrowserNavigationTimeoutMs"
>;

type DebugSnapshot = {
  sessionId: string;
  engine: DebugBrowserEngine;
  headless: DebugHeadless;
  proxy: SafeProxy | null;
  currentUrl: string;
  title: string;
  text: string;
  links: Array<{ href: string; text: string; selector: string }>;
  controls: Array<{ tag: string; type?: string; name?: string; placeholder?: string; text?: string; selector: string }>;
  trail: DebugTrailStep[];
  suggestedSourceRecipe: ReturnType<typeof buildRecipeDraft>;
  updatedAt: string;
};

type DebugPageState = {
  title: string;
  text: string;
  links: Array<{ href: string; text: string; selector: string }>;
  controls: Array<{ tag: string; type?: string; name?: string; placeholder?: string; text?: string; selector: string }>;
};

const DEBUG_SNAPSHOT_SCRIPT = String.raw`
(() => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const escapeIdent = (value) =>
    window.CSS && window.CSS.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (element.id) return "#" + escapeIdent(element.id);
    const pieces = [];
    let current = element;
    while (current && current !== document.body && pieces.length < 4) {
      const tag = current.tagName.toLowerCase();
      const className = Array.from(current.classList)
        .slice(0, 2)
        .map((name) => "." + escapeIdent(name))
        .join("");
      const parent = current.parentElement;
      const currentTag = current.tagName;
      const siblings = parent ? Array.from(parent.children).filter((sibling) => sibling.tagName === currentTag) : [];
      const nth = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
      pieces.unshift(tag + className + nth);
      current = parent;
    }
    return pieces.join(" > ");
  };

  const links = Array.from(document.querySelectorAll("a"))
    .slice(0, 250)
    .map((anchor) => ({
      href: anchor.href,
      text: normalize(anchor.textContent),
      selector: selectorFor(anchor)
    }))
    .filter((anchor) => anchor.href);

  const controls = Array.from(document.querySelectorAll("input, textarea, select, button"))
    .slice(0, 250)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.type || undefined,
      name: element.name || undefined,
      placeholder: element.placeholder || undefined,
      text: normalize(element.textContent),
      selector: selectorFor(element)
    }));

  return {
    title: document.title,
    text: document.body ? document.body.innerText : "",
    links,
    controls
  };
})()
`;

export function createDebugBrowserController(options: DebugBrowserControllerOptions) {
  return new DebugBrowserController(options);
}

class DebugBrowserController {
  private readonly sessions = new Map<string, DebugBrowserSession>();
  private readonly rootDir: string;
  private readonly storageDir: string;
  private readonly getSettings?: () => Promise<RuntimeSettings>;

  constructor(options: DebugBrowserControllerOptions) {
    this.rootDir = options.rootDir;
    this.storageDir = resolveStorageDir(options.rootDir, options.storageDir);
    this.getSettings = options.getSettings;
  }

  list() {
    return {
      sessions: [...this.sessions.values()].map((session) => this.summarize(session)),
      summary: {
        total: this.sessions.size,
        camoufox: [...this.sessions.values()].filter((session) => session.engine === "camoufox").length,
        playwright: [...this.sessions.values()].filter((session) => session.engine === "playwright").length
      }
    };
  }

  async start(rawInput: unknown) {
    const input = StartDebugBrowserInputSchema.parse(rawInput ?? {});
    const settings = await this.settings();
    const maxSessions = settings.debugBrowserMaxSessions;
    if (this.sessions.size >= maxSessions) {
      throw new Error(`Debug browser session limit reached (${maxSessions}). Close a session before starting another.`);
    }

    const proxy = await this.selectProxy(input.proxyStrategy, input.proxyId);
    const headless = input.headless ?? defaultHeadless(settings.debugBrowserHeadless);
    const launched =
      input.engine === "camoufox"
        ? await this.launchCamoufox(input, proxy, headless, settings)
        : await this.launchPlaywright(proxy, headless, settings);

    const session: DebugBrowserSession = {
      id: randomUUID(),
      engine: input.engine,
      headless,
      browser: launched.browser,
      context: launched.context,
      page: launched.page,
      startedAt: new Date(),
      updatedAt: new Date(),
      proxy: proxy ? sanitizeProxy(proxy) : null,
      wsEndpoint: launched.wsEndpoint,
      camoufoxProcess: launched.camoufoxProcess,
      launchLog: launched.launchLog ?? "",
      trail: []
    };

    this.sessions.set(session.id, session);

    try {
      if (input.startUrl) {
        await this.open(session.id, {
          url: input.startUrl,
          waitUntil: "domcontentloaded"
        });
      }
      return this.summarize(session);
    } catch (error) {
      await this.close(session.id).catch(() => undefined);
      throw error;
    }
  }

  async snapshot(sessionId: string): Promise<DebugSnapshot> {
    const session = this.requireSession(sessionId);
    const settings = await this.settings();
    const pageState = (await session.page.evaluate(DEBUG_SNAPSHOT_SCRIPT)) as DebugPageState;

    session.updatedAt = new Date();
    const currentUrl = session.page.url();
    return {
      sessionId: session.id,
      engine: session.engine,
      headless: session.headless,
      proxy: session.proxy,
      currentUrl,
      title: normalizeWhitespace(pageState.title),
      text: normalizeWhitespace(pageState.text).slice(0, settings.debugBrowserMaxTextChars),
      links: pageState.links,
      controls: pageState.controls,
      trail: session.trail,
      suggestedSourceRecipe: buildRecipeDraft(session, currentUrl),
      updatedAt: session.updatedAt.toISOString()
    };
  }

  async open(sessionId: string, rawInput: unknown) {
    const input = DebugBrowserOpenInputSchema.parse(rawInput);
    const session = this.requireSession(sessionId);
    const settings = await this.settings();
    const url = normalizeInputUrl(input.url);
    if (!url) throw new Error(`Invalid URL: ${input.url}`);

    await session.page.goto(url, {
      waitUntil: input.waitUntil,
      timeout: settings.debugBrowserNavigationTimeoutMs
    });
    await session.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    this.addTrail(session, { action: "open_url", value: url });
    return this.snapshot(session.id);
  }

  async click(sessionId: string, rawInput: unknown) {
    const input = DebugBrowserClickInputSchema.parse(rawInput);
    const session = this.requireSession(sessionId);
    const settings = await this.settings();
    const locator = session.page.locator(input.selector).first();
    await locator.waitFor({
      state: "visible",
      timeout: input.timeoutMs ?? settings.debugBrowserActionTimeoutMs
    });
    await locator.click({
      timeout: input.timeoutMs ?? settings.debugBrowserActionTimeoutMs
    });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await session.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    this.addTrail(session, { action: "click_selector", selector: input.selector });
    return this.snapshot(session.id);
  }

  async type(sessionId: string, rawInput: unknown) {
    const input = DebugBrowserTypeInputSchema.parse(rawInput);
    const session = this.requireSession(sessionId);
    const settings = await this.settings();
    const locator = session.page.locator(input.selector).first();
    const timeout = input.timeoutMs ?? settings.debugBrowserActionTimeoutMs;
    await locator.waitFor({ state: "visible", timeout });
    if (input.clear) {
      await locator.fill(input.text, { timeout });
    } else {
      await locator.type(input.text, { timeout });
    }
    if (input.submit) await locator.press("Enter", { timeout });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await session.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    this.addTrail(session, { action: "type_text", selector: input.selector, value: input.text });
    return this.snapshot(session.id);
  }

  async extract(sessionId: string, rawInput: unknown) {
    const input = DebugBrowserExtractInputSchema.parse(rawInput ?? {});
    const session = this.requireSession(sessionId);
    const result = await session.page.evaluate(renderExtractScript(input));

    this.addTrail(session, {
      action:
        input.mode === "links"
          ? "extract_links"
          : input.mode === "html"
            ? "extract_html"
            : input.mode === "attribute"
              ? "extract_attribute"
              : "extract_text",
      selector: input.selector,
      value: input.attribute
    });
    session.updatedAt = new Date();
    return {
      sessionId: session.id,
      currentUrl: session.page.url(),
      mode: input.mode,
      selector: input.selector,
      result
    };
  }

  async screenshot(sessionId: string, rawInput: unknown) {
    const input = DebugBrowserScreenshotInputSchema.parse(rawInput ?? {});
    const session = this.requireSession(sessionId);
    const settings = await this.settings();
    const screenshotDir = path.join(resolveStorageDir(this.rootDir, settings.appStorageDir), "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `debug-${session.id}-${Date.now()}.png`);
    await session.page.screenshot({
      path: screenshotPath,
      fullPage: input.fullPage
    });
    session.updatedAt = new Date();
    return {
      sessionId: session.id,
      currentUrl: session.page.url(),
      screenshotPath,
      fullPage: input.fullPage
    };
  }

  recipeDraft(sessionId: string) {
    const session = this.requireSession(sessionId);
    return {
      sessionId: session.id,
      sourceRecipe: buildRecipeDraft(session, session.page.url())
    };
  }

  async close(sessionId: string) {
    const session = this.requireSession(sessionId);
    this.sessions.delete(session.id);
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    killProcess(session.camoufoxProcess);
    return {
      sessionId: session.id,
      closed: true
    };
  }

  async closeAll() {
    const sessions = [...this.sessions.keys()];
    await Promise.all(sessions.map((sessionId) => this.close(sessionId).catch(() => undefined)));
  }

  private async launchCamoufox(
    input: DebugBrowserStartInput,
    proxy: ProxyRecord | null,
    headless: DebugHeadless,
    settings: DebugBrowserRuntimeSettings
  ): Promise<LaunchedDebugBrowser> {
    const python = resolvePythonExecutable(this.rootDir);
    const launcher = path.join(this.rootDir, "scripts", "camoufox-server.py");
    const launchOptions: Record<string, unknown> = {
      headless,
      humanize: input.humanize,
      fingerprint_preset: true,
      block_webrtc: true,
      enable_cache: false,
      config: { showcursor: false },
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1"
      }
    };

    if (input.locale) launchOptions.locale = input.locale;
    if (input.os) launchOptions.os = input.os;
    if (proxy) {
      launchOptions.proxy = playwrightProxy(proxy);
      if (input.geoip) launchOptions.geoip = true;
    }

    const child = spawn(python, [launcher], {
      cwd: this.rootDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    child.stdin.end(JSON.stringify(launchOptions));
    const launch = await waitForCamoufoxEndpoint(child, settings.debugBrowserConnectTimeoutMs);
    const browser = await firefox.connect(launch.wsEndpoint, {
      timeout: settings.debugBrowserConnectTimeoutMs
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(settings.debugBrowserActionTimeoutMs);

    child.once("exit", () => {
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.camoufoxProcess?.pid === child.pid) this.sessions.delete(sessionId);
      }
    });

    return {
      browser,
      context,
      page,
      wsEndpoint: launch.wsEndpoint,
      camoufoxProcess: child,
      launchLog: launch.launchLog
    };
  }

  private async launchPlaywright(
    proxy: ProxyRecord | null,
    headless: DebugHeadless,
    settings: DebugBrowserRuntimeSettings
  ): Promise<LaunchedDebugBrowser> {
    const browser = await chromium.launch({
      headless: headless === "virtual" ? true : headless,
      proxy: proxy ? playwrightProxy(proxy) : undefined
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(settings.debugBrowserActionTimeoutMs);
    return { browser, context, page };
  }

  private async settings(): Promise<DebugBrowserRuntimeSettings> {
    if (this.getSettings) {
      try {
        return await this.getSettings();
      } catch {
        return fallbackDebugBrowserSettings(this.storageDir);
      }
    }

    return fallbackDebugBrowserSettings(this.storageDir);
  }

  private async selectProxy(strategy: z.infer<typeof ProxyStrategySchema>, proxyId?: string): Promise<ProxyRecord | null> {
    if (strategy === "direct") return null;

    if (strategy === "specific" && proxyId) {
      const proxy = await prisma.proxy.findUnique({ where: { id: proxyId } });
      if (!proxy || proxy.status === "quarantined") return null;
      return proxy as ProxyRecord;
    }

    const usableStatuses = ["healthy", "untested", "degraded"] as const;
    for (const status of usableStatuses) {
      const proxy = await prisma.proxy.findFirst({
        where: {
          status,
          OR: [{ cooldownUntil: null }, { cooldownUntil: { lt: new Date() } }]
        },
        orderBy: [{ healthScore: "desc" }, { lastUsedAt: "asc" }]
      });
      if (proxy) return proxy as ProxyRecord;
    }

    return null;
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Debug browser session not found: ${sessionId}`);
    return session;
  }

  private addTrail(session: DebugBrowserSession, step: Omit<DebugTrailStep, "at">) {
    session.trail.push({
      ...step,
      at: new Date().toISOString()
    });
    session.updatedAt = new Date();
  }

  private summarize(session: DebugBrowserSession) {
    return {
      id: session.id,
      engine: session.engine,
      headless: session.headless,
      currentUrl: session.page.url(),
      proxy: session.proxy,
      startedAt: session.startedAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      steps: session.trail.length
    };
  }
}

async function waitForCamoufoxEndpoint(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  let launchLog = "";
  return new Promise<{ wsEndpoint: string; launchLog: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      killProcess(child);
      reject(new Error(`Timed out waiting for Camoufox websocket endpoint.\n${launchLog}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      launchLog += chunk.toString();
      const clean = stripAnsi(launchLog);
      const match = clean.match(/ws:\/\/[^\s]+/);
      if (match) {
        cleanup();
        resolve({ wsEndpoint: match[0], launchLog: clean });
      }
    };

    const onErrorData = (chunk: Buffer) => {
      launchLog += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Camoufox server exited before launch. code=${code ?? "null"} signal=${signal ?? "null"}\n${launchLog}`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
  });
}

function buildRecipeDraft(session: DebugBrowserSession, currentUrl: string) {
  const openedUrls = session.trail
    .filter((step) => step.action === "open_url" && step.value)
    .map((step) => step.value!);
  const seedUrls = [...new Set(openedUrls.length ? openedUrls : [currentUrl].filter(Boolean))];
  const clickSteps = session.trail
    .filter((step) => step.action === "click_selector" && step.selector)
    .map((step) => ({
      action: "click_selector" as const,
      selector: step.selector
    }));
  const extractionSteps = session.trail.filter((step) => step.action.startsWith("extract_"));
  const sourceDomain = domainFromUrl(currentUrl);

  return {
    name: sourceDomain ? `${sourceDomain} provider` : "debug provider",
    version: "v1",
    status: "trial" as const,
    supportedDomains: sourceDomain ? [sourceDomain] : [],
    description: "Draft generated from a debug browser session. Review selectors before activating globally.",
    seedUrls,
    discoveryQueries: [],
    steps: [
      ...clickSteps,
      {
        action: extractionSteps.some((step) => step.action === "extract_text") ? "extract_text" : ("extract_links" as const),
        selector: extractionSteps.find((step) => step.selector)?.selector,
        limit: 100
      }
    ],
    outputMapping: {}
  };
}

function renderExtractScript(input: DebugBrowserExtractInput): string {
  return String.raw`
((params) => {
  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const roots = params.selector
    ? Array.from(document.querySelectorAll(params.selector))
    : Array.from(document.querySelectorAll(params.mode === "links" ? "a" : "body"));
  const elements =
    params.mode === "links"
      ? roots.flatMap((root) => root instanceof HTMLAnchorElement ? [root] : Array.from(root.querySelectorAll("a")))
      : roots;

  return elements.slice(0, params.limit).map((element) => {
    if (params.mode === "links") {
      return {
        href: element.href,
        text: normalize(element.textContent)
      };
    }

    if (params.mode === "html") return element.outerHTML;
    if (params.mode === "attribute") return element.getAttribute(params.attribute || "") || "";
    return normalize(element.innerText || element.textContent);
  });
})(${JSON.stringify(input)})
`;
}

function fallbackDebugBrowserSettings(storageDir: string): DebugBrowserRuntimeSettings {
  return {
    appStorageDir: storageDir,
    debugBrowserActionTimeoutMs: 15000,
    debugBrowserConnectTimeoutMs: 45000,
    debugBrowserHeadless: process.platform === "linux" && !process.env.DISPLAY ? "virtual" : false,
    debugBrowserMaxSessions: 3,
    debugBrowserMaxTextChars: 8000,
    debugBrowserNavigationTimeoutMs: 45000
  };
}

function defaultHeadless(configured: DebugHeadless): DebugHeadless {
  if (configured === false || configured === true || configured === "virtual") return configured;
  return process.platform === "linux" && !process.env.DISPLAY ? "virtual" : false;
}

function playwrightProxy(proxy: ProxyRecord): PlaywrightProxy {
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.passwordEncrypted ?? undefined
  };
}

function sanitizeProxy(proxy: ProxyRecord): SafeProxy {
  return {
    id: proxy.id,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || undefined
  };
}

function resolvePythonExecutable(rootDir: string): string {
  const venvPython = path.join(rootDir, ".venv", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return process.env.PYTHON_BIN ?? "python3";
}

function resolveStorageDir(rootDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
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

function domainFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function killProcess(child?: ChildProcessWithoutNullStreams) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, "SIGKILL");
  }, 2500).unref();
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  child.kill(signal);
}
