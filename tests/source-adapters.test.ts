import { describe, expect, it } from "vitest";
import {
  CreateEmailVerificationProviderInputSchema,
  CreateEnrichmentProviderInputSchema,
  CreateSourceRecipeInputSchema,
  SourceRecipeConfigSchema,
  UpdateSourceRecipeStatusInputSchema
} from "@leadfactory/source-adapters";

describe("source recipe schemas", () => {
  it("defaults reusable recipe fields for MCP-created providers", () => {
    const recipe = CreateSourceRecipeInputSchema.parse({
      name: "Public profile search",
      discoveryQueries: ['site:yelp.com "{query}" owner manager'],
      steps: [{ action: "search_web", value: "{query}", limit: 25 }]
    });

    expect(recipe.version).toBe("v1");
    expect(recipe.status).toBe("trial");
    expect(recipe.supportedDomains).toEqual([]);
    expect(recipe.steps[0]?.action).toBe("search_web");
  });

  it("keeps executable browser recipe config separate from storage metadata", () => {
    const recipe = CreateSourceRecipeInputSchema.parse({
      name: "Directory listings",
      version: "v2",
      status: "active",
      supportedDomains: ["example-directory.com"],
      seedUrls: ["https://example-directory.com/search?q={query}"],
      steps: [
        { action: "extract_links", selector: ".listing", limit: 50 },
        { action: "paginate", selector: "a.next", limit: 3 }
      ]
    });

    const config = SourceRecipeConfigSchema.parse(recipe);

    expect(config).toEqual({
      description: "",
      discoveryQueries: [],
      seedUrls: ["https://example-directory.com/search?q={query}"],
      steps: [
        { action: "extract_links", selector: ".listing", limit: 50 },
        { action: "paginate", selector: "a.next", limit: 3 }
      ],
      outputMapping: {}
    });
  });

  it("accepts only valid recipe statuses", () => {
    expect(UpdateSourceRecipeStatusInputSchema.parse({ status: "active" }).status).toBe("active");
    expect(() => UpdateSourceRecipeStatusInputSchema.parse({ status: "deleted" })).toThrow();
  });

  it("defaults enrichment provider config for reusable HTTP APIs", () => {
    const provider = CreateEnrichmentProviderInputSchema.parse({
      name: "Example enrichment",
      request: {
        urlTemplate: "https://api.example.test/companies",
        queryTemplate: {
          domain: "{domain}",
          api_key: "{env:EXAMPLE_API_KEY}"
        }
      },
      requiredEnvVars: ["EXAMPLE_API_KEY"],
      outputMapping: {
        emailsPath: "emails",
        ownersPath: "owners"
      }
    });

    expect(provider.version).toBe("v1");
    expect(provider.status).toBe("trial");
    expect(provider.kind).toBe("http_api");
    expect(provider.runWhen).toBe("missing_contact_data");
    expect(provider.rateLimitPerMinute).toBe(60);
    expect(provider.request.method).toBe("GET");
  });

  it("defaults email verification provider mappings for verifier APIs", () => {
    const provider = CreateEmailVerificationProviderInputSchema.parse({
      name: "Example verifier",
      request: {
        urlTemplate: "https://api.example.test/verify",
        queryTemplate: {
          email: "{email}"
        }
      }
    });

    expect(provider.status).toBe("trial");
    expect(provider.outputMapping.statusPath).toBe("status");
    expect(provider.outputMapping.deliverableValues).toContain("deliverable");
    expect(provider.outputMapping.invalidValues).toContain("invalid");
    expect(provider.outputMapping.riskyValues).toContain("catch_all");
  });
});
