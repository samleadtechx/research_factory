import { prisma, Prisma, type PrismaClient } from "@leadfactory/database";
import {
  RuntimeSettingsSchema,
  RuntimeSettingsUpdateSchema,
  type RuntimeSettings,
  type RuntimeSettingsUpdate
} from "@leadfactory/schemas";

const runtimeSettingsKey = "runtime";

export function defaultRuntimeSettings(): RuntimeSettings {
  const inContainer = process.env.LEADFACTORY_CONTAINER === "1" || process.cwd().startsWith("/app");
  return RuntimeSettingsSchema.parse({
    redisUrl: process.env.REDIS_URL ?? (inContainer ? "redis://redis:6379" : "redis://localhost:6379"),
    localLlmBaseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://73.72.215.253:11434/v1",
    localLlmModel: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:14b",
    localLlmApiKey: process.env.LOCAL_LLM_API_KEY ?? "local",
    mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? "",
    appStorageDir: process.env.APP_STORAGE_DIR ?? (inContainer ? "/app/data" : "./data"),
    serverUsagePercent: numberFromEnv("SERVER_USAGE_PERCENT", 60),
    maxBrowsersHardCap: numberFromEnv("MAX_BROWSERS_HARD_CAP", 40),
    maxQwenConcurrency: numberFromEnv("MAX_QWEN_CONCURRENCY", 4),
    maxCampaignRuntimeMinutes: numberFromEnv("MAX_CAMPAIGN_RUNTIME_MINUTES", 240),
    maxPagesPerLead: numberFromEnv("MAX_PAGES_PER_LEAD", 25),
    proxyRetryCount: numberFromEnv("PROXY_RETRY_COUNT", 2),
    browserFirst: booleanFromEnv("BROWSER_FIRST", true),
    maxDiscoveryResults: numberFromEnv("MAX_DISCOVERY_RESULTS", 80),
    searchRetryCount: numberFromEnv("SEARCH_RETRY_COUNT", 2),
    browserEngine: browserEngineFromEnv(),
    browserHeadless: booleanFromEnv("BROWSER_HEADLESS", true),
    browserActionTimeoutMs: numberFromEnv("BROWSER_ACTION_TIMEOUT_MS", 15000),
    browserNavigationTimeoutMs: numberFromEnv("BROWSER_NAVIGATION_TIMEOUT_MS", 45000),
    maxActiveSourceRecipes: numberFromEnv("MAX_ACTIVE_SOURCE_RECIPES", 10),
    sourceRecipeResultLimit: numberFromEnv("SOURCE_RECIPE_RESULT_LIMIT", 60),
    sourceRecipeMaxQueries: numberFromEnv("SOURCE_RECIPE_MAX_QUERIES", 8),
    sourceRecipeMaxSeeds: numberFromEnv("SOURCE_RECIPE_MAX_SEEDS", 10),
    sourceRecipeMaxPages: numberFromEnv("SOURCE_RECIPE_MAX_PAGES", 8),
    sourceRecipeRetryCount: numberFromEnv("SOURCE_RECIPE_RETRY_COUNT", 2),
    sourceRecipeAutoActivateAfter: numberFromEnv("SOURCE_RECIPE_AUTO_ACTIVATE_AFTER", 3),
    sourceRecipeAutoDisableAfter: numberFromEnv("SOURCE_RECIPE_AUTO_DISABLE_AFTER", 10),
    maxActiveEnrichmentProviders: numberFromEnv("MAX_ACTIVE_ENRICHMENT_PROVIDERS", 5),
    maxActiveEmailVerificationProviders: numberFromEnv("MAX_ACTIVE_EMAIL_VERIFICATION_PROVIDERS", 3),
    maxEmailsToVerifyPerLead: numberFromEnv("MAX_EMAILS_TO_VERIFY_PER_LEAD", 10),
    providerAutoActivateAfter: numberFromEnv("PROVIDER_AUTO_ACTIVATE_AFTER", 3),
    providerAutoDisableAfter: numberFromEnv("PROVIDER_AUTO_DISABLE_AFTER", 10),
    providerEnforceRateLimits: booleanFromEnv("PROVIDER_ENFORCE_RATE_LIMITS", true),
    providerMaxRateDelayMs: numberFromEnv("PROVIDER_MAX_RATE_DELAY_MS", 30000),
    qwenTimeoutMs: numberFromEnv("QWEN_TIMEOUT_MS", 120000),
    qwenMaxSourceChars: numberFromEnv("QWEN_MAX_SOURCE_CHARS", 45000),
    debugBrowserHeadless: debugHeadlessFromEnv(),
    debugBrowserMaxSessions: numberFromEnv("DEBUG_BROWSER_MAX_SESSIONS", 3),
    debugBrowserActionTimeoutMs: numberFromEnv("DEBUG_BROWSER_ACTION_TIMEOUT_MS", 15000),
    debugBrowserNavigationTimeoutMs: numberFromEnv("DEBUG_BROWSER_NAVIGATION_TIMEOUT_MS", 45000),
    debugBrowserConnectTimeoutMs: numberFromEnv("DEBUG_BROWSER_CONNECT_TIMEOUT_MS", 45000),
    debugBrowserMaxTextChars: numberFromEnv("DEBUG_BROWSER_MAX_TEXT_CHARS", 8000)
  });
}

export async function readRuntimeSettings(client: PrismaClient = prisma): Promise<RuntimeSettings> {
  const defaults = defaultRuntimeSettings();
  try {
    const record = await client.appSetting.findUnique({ where: { key: runtimeSettingsKey } });
    const stored = record?.value && typeof record.value === "object" && !Array.isArray(record.value) ? record.value : {};
    return RuntimeSettingsSchema.parse({ ...defaults, ...stored });
  } catch (error) {
    if (isMissingSettingsTableError(error)) return defaults;
    throw error;
  }
}

export async function updateRuntimeSettings(
  input: RuntimeSettingsUpdate,
  client: PrismaClient = prisma
): Promise<RuntimeSettings> {
  const current = await readRuntimeSettings(client);
  const patch = RuntimeSettingsUpdateSchema.parse(input);
  const next = RuntimeSettingsSchema.parse({ ...current, ...patch });
  await client.appSetting.upsert({
    where: { key: runtimeSettingsKey },
    update: { value: next as Prisma.InputJsonValue },
    create: { key: runtimeSettingsKey, value: next as Prisma.InputJsonValue }
  });
  return next;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function debugHeadlessFromEnv(): RuntimeSettings["debugBrowserHeadless"] {
  const configured = process.env.DEBUG_BROWSER_HEADLESS?.toLowerCase();
  if (configured === "false" || configured === "0") return false;
  if (configured === "true" || configured === "1") return true;
  if (configured === "virtual") return "virtual";
  return process.platform === "linux" && !process.env.DISPLAY ? "virtual" : false;
}

function browserEngineFromEnv(): RuntimeSettings["browserEngine"] {
  const configured = process.env.BROWSER_ENGINE?.toLowerCase();
  if (configured === "playwright") return "playwright";
  return "camoufox";
}

function isMissingSettingsTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AppSetting") || message.includes("does not exist") || (message.includes("table") && message.includes("not exist"));
}
