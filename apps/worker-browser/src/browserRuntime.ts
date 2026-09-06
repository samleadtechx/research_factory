import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, firefox, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import type { RuntimeSettings } from "@leadfactory/schemas";

export type WorkerProxyRecord = {
  id: string;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string;
  passwordEncrypted: string | null;
};

export type WorkerBrowserEngine = RuntimeSettings["browserEngine"];

export type WorkerBrowserSession = {
  engine: WorkerBrowserEngine;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  camoufoxProcess?: ChildProcessWithoutNullStreams;
  launchLog?: string;
};

type PlaywrightProxy = {
  server: string;
  username?: string;
  password?: string;
};

type CamoufoxLaunchEnvironment = {
  platform?: NodeJS.Platform;
  display?: string;
};

type CamoufoxEndpoint = {
  wsEndpoint: string;
  launchLog: string;
};

export async function launchWorkerBrowserSession(params: {
  rootDir: string;
  settings: RuntimeSettings;
  proxy: WorkerProxyRecord | null;
}): Promise<WorkerBrowserSession> {
  if (params.settings.browserEngine === "playwright") {
    return launchPlaywrightSession(params.settings, params.proxy);
  }

  return launchCamoufoxSession(params.rootDir, params.settings, params.proxy);
}

export async function closeWorkerBrowserSession(session: WorkerBrowserSession): Promise<void> {
  await session.context.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
  killProcess(session.camoufoxProcess);
}

export function buildCamoufoxLaunchOptions(params: {
  settings: Pick<RuntimeSettings, "browserHeadless">;
  proxy: WorkerProxyRecord | null;
  env?: CamoufoxLaunchEnvironment;
}): Record<string, unknown> {
  const launchOptions: Record<string, unknown> = {
    headless: camoufoxHeadless(params.settings.browserHeadless, params.env),
    humanize: true,
    fingerprint_preset: true,
    os: ["windows", "macos", "linux"],
    block_webrtc: true,
    enable_cache: false,
    config: {
      showcursor: false
    },
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1"
    }
  };

  if (params.proxy) {
    launchOptions.proxy = playwrightProxy(params.proxy);
    launchOptions.geoip = true;
  } else {
    launchOptions.locale = "en-US";
  }

  return launchOptions;
}

export function buildWorkerContextOptions(engine: WorkerBrowserEngine): BrowserContextOptions {
  if (engine === "camoufox") {
    return {
      acceptDownloads: false,
      colorScheme: "light",
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true
    };
  }

  return {
    acceptDownloads: false,
    colorScheme: "light",
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    locale: "en-US",
    viewport: randomViewport()
  };
}

export function playwrightProxy(proxy: WorkerProxyRecord): PlaywrightProxy {
  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.passwordEncrypted ?? undefined
  };
}

export function detectBlockReason(params: {
  text: string;
  html: string;
  statusCode?: number;
  finalUrl?: string;
}): string | null {
  if (params.statusCode && [401, 403, 407, 429, 503].includes(params.statusCode)) {
    return `HTTP ${params.statusCode} block or throttling response`;
  }

  const finalUrl = params.finalUrl?.toLowerCase() ?? "";
  if (/^https?:\/\/([^/]+\.)?google\.[^/]+\/sorry(?:\/|\?|$)/.test(finalUrl)) {
    return "google_sorry_interstitial";
  }

  const sample = `${params.text}\n${params.html.slice(0, 3000)}`.toLowerCase();
  const patterns = [
    "access denied",
    "are you a human",
    "captcha",
    "checking if the site connection is secure",
    "detected unusual traffic",
    "enable cookies",
    "google sorry",
    "login required",
    "please verify",
    "temporarily blocked",
    "too many requests",
    "unusual traffic",
    "verify you are human"
  ];

  return patterns.find((pattern) => sample.includes(pattern)) ?? null;
}

function camoufoxHeadless(browserHeadless: boolean, env: CamoufoxLaunchEnvironment = {}): boolean | "virtual" {
  const platform = env.platform ?? process.platform;
  const display = env.display ?? process.env.DISPLAY;
  if (browserHeadless && platform === "linux" && !display) return "virtual";
  return browserHeadless;
}

async function launchCamoufoxSession(
  rootDir: string,
  settings: RuntimeSettings,
  proxy: WorkerProxyRecord | null
): Promise<WorkerBrowserSession> {
  const python = resolvePythonExecutable(rootDir);
  const launcher = path.join(rootDir, "scripts", "camoufox-server.py");
  const launchOptions = buildCamoufoxLaunchOptions({ settings, proxy });
  const child = spawn(python, [launcher], {
    cwd: rootDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1"
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  child.stdin.end(JSON.stringify(launchOptions));

  try {
    const launch = await waitForCamoufoxEndpoint(child, settings.browserNavigationTimeoutMs);
    const browser = await firefox.connect(launch.wsEndpoint, {
      timeout: settings.browserNavigationTimeoutMs
    });
    const context = await browser.newContext(buildWorkerContextOptions("camoufox"));
    const page = await context.newPage();
    page.setDefaultTimeout(settings.browserActionTimeoutMs);

    return {
      engine: "camoufox",
      browser,
      context,
      page,
      camoufoxProcess: child,
      launchLog: launch.launchLog
    };
  } catch (error) {
    killProcess(child);
    throw error;
  }
}

async function launchPlaywrightSession(
  settings: RuntimeSettings,
  proxy: WorkerProxyRecord | null
): Promise<WorkerBrowserSession> {
  const browser = await chromium.launch({
    headless: settings.browserHeadless,
    proxy: proxy ? playwrightProxy(proxy) : undefined
  });
  const context = await browser.newContext(buildWorkerContextOptions("playwright"));
  const page = await context.newPage();
  page.setDefaultTimeout(settings.browserActionTimeoutMs);
  return { engine: "playwright", browser, context, page };
}

function resolvePythonExecutable(rootDir: string): string {
  const localVenv = path.join(rootDir, ".venv", "bin", "python");
  if (process.env.CAMOUFOX_PYTHON) return process.env.CAMOUFOX_PYTHON;
  return existsSync(localVenv) ? localVenv : "python3";
}

function randomViewport() {
  return {
    width: 1280 + Math.floor(Math.random() * 320),
    height: 760 + Math.floor(Math.random() * 220)
  };
}

function waitForCamoufoxEndpoint(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<CamoufoxEndpoint> {
  return new Promise((resolve, reject) => {
    let launchLog = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Camoufox websocket endpoint.\n${launchLog}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onStdout = (chunk: Buffer) => {
      launchLog += chunk.toString();
      const match = launchLog.match(/Websocket endpoint:\s*(\S+)/);
      if (!match) return;
      cleanup();
      resolve({
        wsEndpoint: match[1],
        launchLog
      });
    };

    const onStderr = (chunk: Buffer) => {
      launchLog += chunk.toString();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Camoufox server exited before launch. code=${code ?? "null"} signal=${signal ?? "null"}\n${launchLog}`));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function killProcess(child?: ChildProcessWithoutNullStreams) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may already be gone.
    }
  }
}
