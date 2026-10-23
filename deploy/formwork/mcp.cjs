const fs = require("node:fs");

try {
  const filename = process.argv[2];
  const stat = fs.statSync(filename);
  if (stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error();
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof config.apiToken !== "string" ||
    !/^kan_mcp_[A-Za-z0-9_-]+$/.test(config.apiToken) ||
    !Number.isFinite(Date.parse(config.expiresAt)) ||
    Date.parse(config.expiresAt) <= Date.now()
  )
    throw new Error();
  process.env.KAN_BASE_URL = url.origin;
  process.env.KAN_API_TOKEN = config.apiToken;
  import("../../packages/mcp/dist/index.js").catch(() => {
    process.stderr.write(
      "Kan MCP could not start. Check the local build and credential.\n",
    );
    process.exitCode = 1;
  });
} catch {
  process.stderr.write(
    "Kan MCP requires a private, unexpired Formwork credential file.\n",
  );
  process.exitCode = 1;
}
