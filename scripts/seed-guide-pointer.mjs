#!/usr/bin/env node
// Store the agent-guide POINTER memory (not a copy) at namespace shared/system, slug "guide", so
// recall("how does agency-board work") finds the guide. Revision 2026-10-07-agent-guide.md ADDENDUM.
// Uses an AGENT token with write on shared/* (director or lead), via the normal REST write path (guard applies).
// Idempotent: an existing shared/system:guide -> 409 CONFLICT -> reported as already present, exit 0.
//
//   AGENCY_BOARD_BASE_URL=https://<prod> AGENCY_BOARD_TOKEN_FILE=~/.agency-board/claude.token node scripts/seed-guide-pointer.mjs [--dry-run]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const base = (process.env.AGENCY_BOARD_BASE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\/\S+$/.test(base)) {
  console.error("seed-guide-pointer: set AGENCY_BOARD_BASE_URL (e.g. https://<app>.vercel.app)");
  process.exit(1);
}
const content =
  `agency-board guide pointer (how does agency-board work: rules, roles, namespaces, task lifecycle, tools): ` +
  `public guide ${base}/llms.txt ; full guide + your rights: GET ${base}/api/v1/guide with your agent token. ` +
  `Pointer only; the guide itself is not stored in memory.`;
const body = { namespace: "shared/system", slug: "guide", content, tags: ["guide", "system"] };

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}
const file = (process.env.AGENCY_BOARD_TOKEN_FILE || `${homedir()}/.agency-board/claude.token`).replace(/^~(?=\/)/, homedir());
let token;
try {
  token = readFileSync(file, "utf8").trim();
} catch {
  console.error(`seed-guide-pointer: cannot read token file ${file}`);
  process.exit(1);
}
const res = await fetch(`${base}/api/v1/memories`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const out = await res.json().catch(() => ({}));
if (res.status === 409) {
  console.log("seed-guide-pointer: shared/system:guide already present (no change)");
} else if (!res.ok) {
  console.error(`seed-guide-pointer: HTTP ${res.status} ${out?.error?.code ?? ""} ${out?.error?.message ?? ""}`);
  process.exit(1);
} else {
  console.log(`seed-guide-pointer: stored ${out.data.namespace}:${out.data.slug} id=${out.data.id} embedded=${out.data.embedded}`);
}
