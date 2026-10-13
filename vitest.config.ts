import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: loadEnv("test", process.cwd(), ""),
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
  },
});
