import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    env: { BETTER_AUTH_SECRET: "test-only-api-encryption-key-not-for-production" },
    include: ["src/**/*.test.ts", "integration-tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kan/db": resolve(__dirname, "../db/src"),
    },
  },
});
