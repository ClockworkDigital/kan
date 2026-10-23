/**
 * Bootstrap script for the distroless production image.
 *
 * Distroless images have no shell, so this Node.js script handles two tasks
 * that would normally be done in an entrypoint.sh:
 *
 * 1. Regenerate `public/__ENV.js` with the current runtime NEXT_PUBLIC_*
 *    environment variables.  The file was originally created at build time by
 *    next-runtime-env's `configureRuntimeEnv()`, but in a Docker deployment the
 *    env vars are provided at *run* time via docker-compose / docker run.
 *
 * 2. Start the Next.js standalone server.
 */

const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("fs");
const path = require("path");

for (const name of ["POSTGRES_URL", "BETTER_AUTH_SECRET", "KAN_ADMIN_API_KEY"]) {
  const filename = process.env[`${name}_FILE`];
  if (filename) {
    const value = readFileSync(filename, "utf8").trim();
    if (!value) throw new Error(`Empty ${name}_FILE`);
    process.env[name] = value;
  }
}

// ---------------------------------------------------------------------------
// 1. Inject runtime NEXT_PUBLIC_* env vars into __ENV.js
// ---------------------------------------------------------------------------

const publicDir = path.join(__dirname, "apps", "web", "public");

if (!existsSync(publicDir)) {
  mkdirSync(publicDir, { recursive: true });
}

const envVars = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("NEXT_PUBLIC_")) {
    envVars[key] = value;
  }
}

writeFileSync(
  path.join(publicDir, "__ENV.js"),
  `self.__ENV = ${JSON.stringify(envVars)};`,
);

// ---------------------------------------------------------------------------
// 2. Start the Next.js standalone server
// ---------------------------------------------------------------------------

require("./apps/web/server.js");
