const path = require("node:path");

const driverPackage = process.argv[2];
const playwright = require(path.join(driverPackage, "index.js"));

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});

process.stdin.on("end", async () => {
  try {
    const options = JSON.parse(Buffer.from(data, "base64").toString());
    const browserServer = await playwright.firefox.launchServer(options);
    console.log(`Websocket endpoint: ${browserServer.wsEndpoint()}`);
    setInterval(() => undefined, 2 ** 30);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});
