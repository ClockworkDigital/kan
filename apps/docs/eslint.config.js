import baseConfig from "../../tooling/eslint/base.js";

export default [...baseConfig, { ignores: ["!eslint.config.js"] }];
