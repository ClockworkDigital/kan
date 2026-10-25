import baseConfig, { restrictEnvAccess } from "@kan/eslint-config/base";
import nextjsConfig from "@kan/eslint-config/nextjs";
import reactConfig from "@kan/eslint-config/react";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    // Lingui compiles these files from the maintained locale catalogs.
    ignores: [".next/**", "src/locales/*/messages.ts"],
  },
  ...baseConfig,
  ...reactConfig,
  ...nextjsConfig,
  ...restrictEnvAccess,
];
