// Migration 0005 (contract routing confidential-only) SQL-text parity with lib/guard.ts confidentialContext (no DB).
// The SQL regexes are extracted from the migration file and run as JS regexes (`iu`) over the same fixtures; ARE and
// JS agree on this subset (literals, \s, ?, [^/], anchors, alternation). Also asserts the hardening every guard needs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confidentialContext } from "../lib/guard";

const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "20261007000005_contract_confidential_only.sql"), "utf8");
const fn = sql.slice(sql.indexOf("create or replace function public.hub_confidential_context"), sql.indexOf("end $$;") + 7);
const nsSrc = /p_ns, NFC\) ~\* '([^']+)'/.exec(fn)?.[1];
const markerSrc = /normalize\(x, NFC\) ~\* '([^']+)'/.exec(fn)?.[1];

const sqlContext = (ns: string | null, texts: Array<string | null>) =>
  (ns != null && new RegExp(nsSrc!, "iu").test(ns.normalize("NFC"))) ||
  texts.some((t) => t != null && new RegExp(markerSrc!, "iu").test(t.normalize("NFC")));

describe("migration 0005: hub_confidential_context mirrors confidentialContext", () => {
  it("extracts both regexes", () => {
    expect(nsSrc).toBe("^project/confidential[^/]*(/|$)");
    expect(markerSrc).toBe("confidential");
  });

  const cases: Array<[string | null, Array<string | null>]> = [
    ["project/confidential", []], ["project/confidential/deals", []], ["project/Confidential-x", []],
    ["project/x", []], ["project/acme", []], ["project/myconfidential", []], ["shared", []], [null, []],
    ["project/x", ["Hợp đồng confidential"]], [null, ["CONFIDENTIAL"]], [null, ["confidentiality terms"]],
    [null, ["con fidential"]], [null, ["www.example.com/confidential"]], [null, ["Vietcombank", null]],
  ];
  it.each(cases)("ns=%s texts=%j", (ns, texts) => {
    expect(sqlContext(ns, texts)).toBe(confidentialContext(ns, texts));
  });

  it("every guard passes the confidential context into p_contract_ok; hub_guard_check (classes 2-5) is not redefined", () => {
    for (const g of ["hub_guard_memories", "hub_guard_tasks", "hub_guard_approvals", "hub_guard_task_events", "hub_guard_agent_tokens"]) {
      const body = sql.slice(sql.indexOf(`function public.${g}()`), sql.indexOf("end $$;", sql.indexOf(`function public.${g}()`)));
      expect(body).toMatch(/not hub_confidential_context\(/);
      expect(body).toMatch(/security invoker\s+set search_path = public, extensions/);
    }
    expect(sql).not.toMatch(/function public\.hub_guard_check/);
    expect(sql).not.toMatch(/^\s*(begin|commit);/im);
  });

  it("lockdown: every function revoked from public/anon/authenticated and granted to service_role", () => {
    const fns = [...sql.matchAll(/create or replace function (public\.\w+)\(([^)]*)\)/g)].map((m) => m[1]);
    expect(fns).toHaveLength(6);
    for (const f of fns) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${f.replace(".", "\\.")}\\([^)]*\\) to service_role;`));
    }
  });
});
