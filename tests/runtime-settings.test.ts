import { describe, expect, it } from "vitest";
import { RuntimeSettingsSchema, RuntimeSettingsUpdateSchema } from "@leadfactory/schemas";

describe("runtime settings schema", () => {
  it("defaults deploy settings that moved out of env", () => {
    const settings = RuntimeSettingsSchema.parse({});

    expect(settings.redisUrl).toBe("redis://localhost:6379");
    expect(settings.localLlmBaseUrl).toBe("http://73.72.215.253:11434/v1");
    expect(settings.localLlmModel).toBe("qwen2.5:14b");
    expect(settings.mcpBearerToken).toBe("");
    expect(settings.appStorageDir).toBe("./data");
    expect(settings.browserEngine).toBe("camoufox");
    expect(settings.debugBrowserHeadless).toBe("virtual");
  });

  it("accepts partial updates from dashboard and MCP", () => {
    const update = RuntimeSettingsUpdateSchema.parse({
      redisUrl: "redis://redis:6379",
      mcpBearerToken: "secret-token",
      serverUsagePercent: 70,
      browserEngine: "playwright",
      browserFirst: false,
      debugBrowserHeadless: true
    });

    expect(update).toEqual({
      redisUrl: "redis://redis:6379",
      mcpBearerToken: "secret-token",
      serverUsagePercent: 70,
      browserEngine: "playwright",
      browserFirst: false,
      debugBrowserHeadless: true
    });
  });
});
