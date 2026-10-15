// The exact hook lines (as printed by linger.sh prompt codex) that the Codex skills must quote. Tests pin both the real
// hook output (tests/linger.test.ts) and the generated SKILL.md files (tests/scripts.test.ts) to these strings.
export const HOOK_LINE_PREFIXES = {
  listen: "agency-board: listen mode ON for this codex session",
  wait: "agency-board: wait mode ON for this codex session",
  unlisten: "agency-board: listen/wait mode is OFF for every codex session on this machine",
} as const;
