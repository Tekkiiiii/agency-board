import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// Build-time facts for the in-app Update button (lib/update/*): the running version and the migrations bundled with it.
// Injected through `env`, so Next inlines them into the server bundle where lib/update reads process.env.AGENCY_BOARD_*.
function buildVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

// 14-digit versions of supabase/migrations/*.sql, comma-joined and sorted.
function bundledMigrations(): string {
  try {
    return readdirSync(join(process.cwd(), "supabase", "migrations"))
      .map((file) => file.match(/^(\d{14})_.*\.sql$/)?.[1])
      .filter((version): version is string => !!version)
      .sort()
      .join(",");
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: {
    AGENCY_BOARD_VERSION: buildVersion(),
    AGENCY_BOARD_MIGRATIONS: bundledMigrations(),
  },
};

export default nextConfig;
