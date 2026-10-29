import type { Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";

import baseConfig from "@kan/tailwind-config/web";

export default {
  darkMode: "class",
  content: [...baseConfig.content],
  plugins: [require("@tailwindcss/typography")],
  presets: [baseConfig],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Anybody SemiExpanded", ...fontFamily.sans],
        heading: ["Anybody Expanded", ...fontFamily.sans],
        mono: fontFamily.mono,
      },
    },
  },
} satisfies Config;
