import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@leadfactory/campaign-planner": new URL("packages/campaign-planner/src/index.ts", import.meta.url).pathname,
      "@leadfactory/database": new URL("packages/database/src/index.ts", import.meta.url).pathname,
      "@leadfactory/document-store": new URL("packages/document-store/src/index.ts", import.meta.url).pathname,
      "@leadfactory/llm": new URL("packages/llm/src/index.ts", import.meta.url).pathname,
      "@leadfactory/proxy-manager": new URL("packages/proxy-manager/src/index.ts", import.meta.url).pathname,
      "@leadfactory/queue": new URL("packages/queue/src/index.ts", import.meta.url).pathname,
      "@leadfactory/resource-governor": new URL("packages/resource-governor/src/index.ts", import.meta.url).pathname,
      "@leadfactory/schemas": new URL("packages/schemas/src/index.ts", import.meta.url).pathname,
      "@leadfactory/scoring": new URL("packages/scoring/src/index.ts", import.meta.url).pathname,
      "@leadfactory/source-adapters": new URL("packages/source-adapters/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false
  }
});
