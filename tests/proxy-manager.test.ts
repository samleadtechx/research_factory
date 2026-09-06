import { describe, expect, it } from "vitest";
import { parseProxyText, redactProxy } from "@leadfactory/proxy-manager";

describe("proxy parsing", () => {
  it("parses HTTP and SOCKS5 proxy URLs", () => {
    const result = parseProxyText(`
http://user:pass@example.com:8080
socks5://proxy.local:1080
`);

    expect(result.errors).toEqual([]);
    expect(result.proxies).toHaveLength(2);
    expect(result.proxies[0]).toMatchObject({
      protocol: "http",
      host: "example.com",
      port: 8080,
      username: "user",
      password: "pass"
    });
    expect(result.proxies[1]).toMatchObject({
      protocol: "socks5",
      host: "proxy.local",
      port: 1080
    });
  });

  it("redacts proxy passwords", () => {
    expect(
      redactProxy({
        protocol: "http",
        host: "example.com",
        port: 8080,
        username: "user",
        password: "pass"
      })
    ).toBe("http://user:***@example.com:8080");
  });
});
