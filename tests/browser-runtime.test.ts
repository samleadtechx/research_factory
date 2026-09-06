import { describe, expect, it } from "vitest";
import {
  buildCamoufoxLaunchOptions,
  buildWorkerContextOptions,
  detectBlockReason,
  playwrightProxy,
  type WorkerProxyRecord
} from "../apps/worker-browser/src/browserRuntime";

const proxy: WorkerProxyRecord = {
  id: "proxy_1",
  protocol: "socks5",
  host: "23.236.227.190",
  port: 8800,
  username: "",
  passwordEncrypted: null
};

describe("browser runtime fingerprint settings", () => {
  it("uses Camoufox fingerprints with proxy-aligned geoip and no manual user agent", () => {
    const options = buildCamoufoxLaunchOptions({
      settings: { browserHeadless: true },
      proxy,
      env: { platform: "linux", display: undefined }
    });
    const context = buildWorkerContextOptions("camoufox");

    expect(options.headless).toBe("virtual");
    expect(options.fingerprint_preset).toBe(true);
    expect(options.humanize).toBe(true);
    expect(options.geoip).toBe(true);
    expect(options.block_webrtc).toBe(true);
    expect(options.proxy).toEqual(playwrightProxy(proxy));
    expect(options).not.toHaveProperty("userAgent");
    expect(context).not.toHaveProperty("userAgent");
    expect(context).not.toHaveProperty("timezoneId");
    expect(context).not.toHaveProperty("viewport");
  });

  it("uses a stable US locale only when no proxy geoip can be derived", () => {
    const options = buildCamoufoxLaunchOptions({
      settings: { browserHeadless: false },
      proxy: null,
      env: { platform: "darwin" }
    });

    expect(options.headless).toBe(false);
    expect(options.locale).toBe("en-US");
    expect(options).not.toHaveProperty("geoip");
    expect(options).not.toHaveProperty("proxy");
  });
});

describe("browser block detection", () => {
  it("marks Google sorry interstitials as blocked", () => {
    expect(
      detectBlockReason({
        finalUrl: "https://www.google.com/sorry/index?continue=https://www.google.com/search",
        text: "To continue, please type the characters below.",
        html: "<html></html>",
        statusCode: 200
      })
    ).toBe("google_sorry_interstitial");
  });
});
