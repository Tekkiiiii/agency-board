import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig has "jsx": "preserve" (Next compiles JSX itself); Vite would then leave JSX untouched and fail to parse any .tsx a test imports.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.ts"],
    // No loadEnv here: Vite loads .env.local even in mode "test". The test env is built in tests/global-setup.ts.
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
  },
});
