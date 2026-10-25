import baseConfig from "@kan/eslint-config/base";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    // React Email's vendored preview application has its own dependencies and config.
    ignores: ["dist/**", ".react-email/**"],
  },
  ...baseConfig,
];
