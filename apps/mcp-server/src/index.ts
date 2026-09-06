import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLeadResearchMcpServer } from "./server.js";

const server = createLeadResearchMcpServer();
await server.connect(new StdioServerTransport());
