// B-OVERVIEW: pure helpers in lib/dash/fleet.ts (no DB).
import { describe, it, expect } from "vitest";
import { fleetStatus, ident, isOnline, lastSeen, liveIdentities, ONLINE_WINDOW_MS, scopeSummary, sortFleet, TASK_STATUSES } from "../lib/dash/fleet";
import type { AgentId, Role } from "../lib/types";

const NOW = Date.parse("2026-10-07T08:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

type R = { agent: string; machine: string; revoked: boolean; last_heartbeat_at: string | null; last_used_at: string | null };
const row = (p: Partial<R> = {}): R => ({ agent: "claude", machine: "mac", revoked: false, last_heartbeat_at: null, last_used_at: null, ...p });

describe("lastSeen", () => {
  it("is null when never seen", () => expect(lastSeen(row())).toBeNull());
  it("picks the later of heartbeat and last use", () => {
    expect(lastSeen(row({ last_heartbeat_at: ago(60_000), last_used_at: ago(10_000) }))).toBe(ago(10_000));
    expect(lastSeen(row({ last_heartbeat_at: ago(5_000), last_used_at: ago(10_000) }))).toBe(ago(5_000));
    expect(lastSeen(row({ last_used_at: ago(1) }))).toBe(ago(1));
  });
  it("ignores unparseable timestamps", () => {
    expect(lastSeen(row({ last_heartbeat_at: "nope", last_used_at: ago(10) }))).toBe(ago(10));
  });
});

describe("isOnline / fleetStatus (5-minute window)", () => {
  it("online via heartbeat or via last use", () => {
    expect(isOnline(row({ last_heartbeat_at: ago(60_000) }), NOW)).toBe(true);
    expect(isOnline(row({ last_used_at: ago(ONLINE_WINDOW_MS - 1) }), NOW)).toBe(true);
  });
  it("offline at exactly 5 minutes and beyond, or when never seen", () => {
    expect(isOnline(row({ last_heartbeat_at: ago(ONLINE_WINDOW_MS) }), NOW)).toBe(false);
    expect(isOnline(row({ last_heartbeat_at: ago(3_600_000), last_used_at: ago(ONLINE_WINDOW_MS + 1) }), NOW)).toBe(false);
    expect(isOnline(row(), NOW)).toBe(false);
  });
  it("a fresh heartbeat wins over a stale last use", () => {
    expect(isOnline(row({ last_heartbeat_at: ago(1_000), last_used_at: ago(86_400_000) }), NOW)).toBe(true);
  });
  it("revoked is never online", () => {
    const r = row({ revoked: true, last_heartbeat_at: ago(1_000) });
    expect(isOnline(r, NOW)).toBe(false);
    expect(fleetStatus(r, NOW)).toBe("revoked");
  });
  it("status labels", () => {
    expect(fleetStatus(row({ last_used_at: ago(1_000) }), NOW)).toBe("online");
    expect(fleetStatus(row({ last_used_at: ago(ONLINE_WINDOW_MS * 2) }), NOW)).toBe("offline");
  });
});

describe("ident / liveIdentities / sortFleet", () => {
  it("formats agent@machine, agent alone when machine is empty", () => {
    expect(ident({ agent: "codex", machine: "laptop" })).toBe("codex@laptop");
    expect(ident({ agent: "codex", machine: "" })).toBe("codex");
  });
  it("live = not revoked", () => {
    expect(liveIdentities([row(), row({ revoked: true, agent: "grok" })]).map((r) => r.agent)).toEqual(["claude"]);
  });
  it("online first, then most recently seen, revoked last, then name", () => {
    const rows = [
      row({ agent: "grok", revoked: true, last_heartbeat_at: ago(1) }),
      row({ agent: "codex", last_used_at: ago(3_600_000) }),
      row({ agent: "hermes" }),
      row({ agent: "claude", last_heartbeat_at: ago(30_000) }),
      row({ agent: "codex", machine: "win", last_used_at: ago(60_000) }),
      row({ agent: "claude", machine: "win" }),
    ];
    expect(sortFleet(rows, NOW).map((r) => ident(r))).toEqual([
      "claude@mac",
      "codex@win",
      "codex@mac",
      "claude@win",
      "hermes@mac",
      "grok@mac",
    ]);
  });
  it("does not mutate its input", () => {
    const rows = [row({ agent: "b" }), row({ agent: "a" })];
    sortFleet(rows, NOW);
    expect(rows.map((r) => r.agent)).toEqual(["b", "a"]);
  });
});

describe("scopeSummary (§11 incl. restricted cap, §12 grants)", () => {
  const s = (agent: AgentId, role: Role, grants: string[] = []) => scopeSummary({ agent, role, grants });

  it("director and lead read/write everything", () => {
    for (const role of ["director", "lead"] as Role[]) {
      expect(s("claude", role)).toEqual({ read: "everything", write: "everything", inboxOnly: false, grants: [], plusAssigned: false });
    }
  });
  it("member: shared/* + own/* (+ assigned), writes own/* + shared/inbox", () => {
    expect(s("grok", "member")).toEqual({
      read: "shared/*, grok/*",
      write: "grok/*, shared/inbox",
      inboxOnly: false,
      grants: [],
      plusAssigned: true,
    });
  });
  it("restricted agent (hermes by default) is capped at any role", () => {
    for (const role of ["director", "lead", "member"] as Role[]) {
      const h = s("hermes", role);
      expect(h.read).toBe("hermes/*, shared/inbox");
      expect(h.write).toBe("shared/inbox");
      expect(h.inboxOnly).toBe(true);
      expect(h.plusAssigned).toBe(true);
    }
  });
  it("grants are listed sorted and never widen read/write text", () => {
    const g = s("codex", "lead", ["confidential", "alpha"]);
    expect(g.grants).toEqual(["alpha", "confidential"]);
    expect(g.read).toBe("everything");
  });
});

describe("overview task statuses", () => {
  it("counts every task status, blocked included", () => {
    expect([...TASK_STATUSES]).toEqual(["open", "claimed", "blocked", "done", "failed", "cancelled"]);
  });
});
