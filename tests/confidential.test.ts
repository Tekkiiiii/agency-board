// MVP-b0 §13: confidential tiered rule (owner decision 2026-10-07: "Contracts gated, customers blocked").
//   tier 1 general client work  -> anywhere the role permits; project/acme is NOT confidential (no grant).
//   tier 2 confidential contract      -> ONLY project/confidential[/...] by a granted identity, else 422 CONFIDENTIAL.
//          (confidential context = namespace project/confidential* OR the word "confidential" in the texts; non-confidential contracts, e.g.
//          an unrelated client contract in project/x, are stored normally — migration 0005, CONTRACT §13.2.)
//   tier 3 customer PII          -> NOWHERE (incl. confidential and service-role writes), 422 CUSTOMER_PII_BLOCKED.
//   §13.5 classes 3-5 (employee PII, non-public financials, credentials) -> NOWHERE, 422 EMPLOYEE_PII_BLOCKED /
//   FINANCIALS_BLOCKED / CREDENTIALS_BLOCKED; credentials in ALL namespaces, not only confidential ones.
// Errors never echo content; blocked writes never reach embed(). Pure piiRule/contractRule fixtures live in
// tests/guard-tiers.test.ts. All rows here live under */test-<runId>* (incl. project/acme/test-<runId>* and
// project/confidential/test-<runId>*), removed by cleanup().
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/embed", () => ({ EMBED_MODEL: "gte-small", embed: vi.fn(async () => null) }));

import { embed } from "../lib/embed";
import { db } from "../lib/db";
import { remember, recall, getMemory, getNeighbors, forget, postTask, heartbeat, requestApproval } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, grantFor, cleanup, apiErr, idsOf, recallIds } from "./helpers";

const SB_CONF = "confidential";
const embedSpy = vi.mocked(embed);
const marker = `zb${runId}`;
const acmeNs = (sub?: string) => ns("project/acme", sub); // project/acme/test-<runId>[/sub]: tier 1, not confidential
// Confidential CONTEXT by namespace (slug starts with "confidential") but not a registered confidential project: no grant applies.
const ctxNs = (sub?: string) => ns("project/confidential-ext", sub);
const confNs = (sub?: string) => ns(`project/${SB_CONF}`, sub); // project/confidential/test-<runId>[/sub]

// Fixture texts. Contract text has contract markers and no PII; PII texts have no contract markers.
const CONTRACT = `Hợp đồng số 07/2026/HĐDV giữa Bên A và Bên B về dịch vụ quảng cáo ${marker}`;
const CONTRACT_TITLE = "Review Bên A / Bên B terms of the SME service agreement";
// Same contract wording carrying a confidential marker: confidential context in ANY namespace.
const SB_CONTRACT = `${CONTRACT} với đối tác Confidential`;
const SB_CONTRACT_TITLE = `${CONTRACT_TITLE} with a Confidential partner`;
const PII: Array<[label: string, text: string, secret: string]> = [
  ["CCCD", "khách mới, giấy tờ 001099012345 đã nộp", "001099012345"],
  ["phone", "gọi lại khách theo số 0912 345 678 chiều nay", "0912 345 678"],
  ["Luhn card", "thẻ khách 4111 1111 1111 1111 bị lỗi", "4111 1111 1111 1111"],
  ["name label", "Họ tên: Nguyễn Văn An, cần gọi lại", "Nguyễn Văn An"],
];

// §13.5 classes 3-5: one realistic fixture each (no customer PII, no contract markers, no other class).
// [label, code, text, secret] — the secret is the part that must never be echoed or stored.
type ClassCode = "EMPLOYEE_PII_BLOCKED" | "FINANCIALS_BLOCKED" | "CREDENTIALS_BLOCKED";
const CLASSES: Array<[label: string, code: ClassCode, text: string, secret: string]> = [
  ["class 3 employee PII (staff id + performance review)", "EMPLOYEE_PII_BLOCKED",
    "Mã NV: XY48213 - đánh giá hiệu suất quý 3 chưa đạt, chờ HR xử lý", "XY48213"],
  ["class 4 non-public financials (budget + amount)", "FINANCIALS_BLOCKED",
    "Ngân sách chiến dịch SME quý 4: 2,5 tỷ, phân bổ theo kênh", "2,5 tỷ"],
  ["class 5 credentials (password)", "CREDENTIALS_BLOCKED",
    "Staging DB login cho dashboard: password: Tq7#mZ2vLp", "Tq7#mZ2vLp"],
];
const [EMP, FIN, CRED] = CLASSES;
// Must PASS with the new rules (revision "False positives"): stored normally, embed called. No runId inside
// these texts: a runId like "4k2m..." next to "KPI" could itself read as an amount; the namespace scopes them.
const CLASS_MUST_PASS = [
  "Acme SME campaign brief Q4: awareness -> consideration -> conversion, kênh Facebook + Zalo",
  "KPI: CTR, CPC cho chiến dịch SME",
  "CTR 2.4% tuần này",
  "lãi suất 6.5% (công bố) cho tiền gửi SME",
  "use the password manager for the shared ads account",
  "API key rotation is due next week",
  "dev server on localhost:13100 for the dashboard",
];

// Migration 0004 probe (class 3-5 DB triggers). There is no RPC to inspect pg_proc, so: one service-role
// credential insert into a runId namespace. Rejected with CREDENTIALS_BLOCKED: -> the triggers are live.
// Accepted -> 0004 not applied: delete the probe row now (cleanup() would too) and skip the trigger cases.
const SKIP_0004 = "migration 0004 not applied, the live DB accepts credentials (no hub_credential_rule trigger yet)";
async function probe0004(): Promise<boolean> {
  const { data, error } = await db().from("memories")
    .insert({ author_agent: "claude", namespace: ns("shared", "probe"), slug: `probe-${runId}`, content: CRED[2] })
    .select("id").maybeSingle();
  if (error) {
    if (error.message?.startsWith("CREDENTIALS_BLOCKED:")) return true;
    throw new Error(`0004 probe: unexpected DB error ${error.code}`);
  }
  if (data?.id) {
    const { error: delErr } = await db().from("memories").delete().eq("id", data.id);
    if (delErr) throw delErr;
  }
  console.warn(`confidential.test: ${SKIP_0004}; class 3-5 trigger cases are skipped`);
  return false;
}
const has0004 = await probe0004();

// Migration 0005 probe (contract routing confidential-only): a service-role insert of a non-confidential contract into a runId
// namespace. Accepted -> 0005 live (delete the probe row). Rejected with CONFIDENTIAL: -> still 0004 (contracts
// blocked everywhere by the DB) -> the "non-confidential contract is stored" cases are skipped (the JS guard alone allows them).
const SKIP_0005 = "migration 0005 not applied, the DB still blocks non-confidential contracts (hub_guard_* from 0004)";
async function probe0005(): Promise<boolean> {
  const { data, error } = await db().from("memories")
    .insert({ author_agent: "claude", namespace: ns("project", "probe5"), slug: `probe5-${runId}`, content: CONTRACT })
    .select("id").maybeSingle();
  if (error) {
    if (error.message?.startsWith("CONFIDENTIAL:")) {
      console.warn(`confidential.test: ${SKIP_0005}; non-confidential contract store cases are skipped`);
      return false;
    }
    throw new Error(`0005 probe: unexpected DB error ${error.code}`);
  }
  if (data?.id) {
    const { error: delErr } = await db().from("memories").delete().eq("id", data.id);
    if (delErr) throw delErr;
  }
  return true;
}
const has0005 = await probe0005();

let granted: AgentCtx, ungranted: AgentCtx;
let grantedTok: string;
const ids: Record<string, string> = {};

async function insertMem(key: string, row: Record<string, unknown>) {
  const { data, error } = await db().from("memories").insert({ author_agent: "claude", author_token: grantedTok, ...row }).select("id").single();
  if (error) throw error;
  ids[key] = data.id;
}

/**
 * heartbeat is rate limited to 2 calls / 60 s PER TOKEN and enforce() runs before the tier guard, so a
 * blocked heartbeat still spends quota. Every heartbeat case gets a freshly minted token for the SAME
 * identity (claude@<machine>, so the same role and grants) and the limit never interferes.
 */
async function freshCtx(machine: "sbg" | "sbu"): Promise<AgentCtx> {
  const t = await mintToken("claude", { machine });
  return ctxFor(t.raw);
}

/** The error (message + details) must not echo any part of the blocked input. */
function expectNoEcho(e: any, ...secrets: string[]) {
  const blob = JSON.stringify({ message: e?.message, details: e?.details });
  for (const s of secrets) expect(blob).not.toContain(s);
}

function expectPii(e: any, ...secrets: string[]) {
  expect(e).toMatchObject({ status: 422, code: "CUSTOMER_PII_BLOCKED" });
  expect(typeof e.details?.rule).toBe("string");
  expectNoEcho(e, ...secrets);
}

function expectContract(e: any, ...secrets: string[]) {
  expect(e).toMatchObject({ status: 422, code: "CONFIDENTIAL" });
  expect(typeof e.details?.rule).toBe("string");
  expectNoEcho(e, ...secrets);
}

function expectClass(e: any, code: ClassCode, ...secrets: string[]) {
  expect(e).toMatchObject({ status: 422, code });
  expect(typeof e.details?.rule).toBe("string");
  expectNoEcho(e, ...secrets);
}

describe("integration (live DB)", () => {
  beforeAll(async () => {
    const g = await mintToken("claude", { machine: "sbg" });
    const u = await mintToken("claude", { machine: "sbu" });
    grantedTok = g.tokenId;
    expect(await grantFor("claude", g.deviceId, SB_CONF, true)).toBe(true);
    granted = await ctxFor(g.raw);
    ungranted = await ctxFor(u.raw);
    expect(granted.role).toBe("lead");
    expect(ungranted.role).toBe("lead");
    expect(granted.grants).toContain(SB_CONF);
    expect(ungranted.grants ?? []).not.toContain(SB_CONF);

    // Graph: A (shared) -> S (confidential) -> B (shared, only reachable through S) = the
    // shared -> confidential -> shared bridge; A -> C (shared, control).
    await insertMem("S", { namespace: confNs("graph"), slug: "s", content: `confidential SME pricing terms ${marker}` });
    await insertMem("A", { namespace: ns("shared", "sb"), slug: "a", content: `anchor note ${marker}` });
    await insertMem("B", { namespace: ns("shared", "sb"), slug: "b", content: `beyond the bridge note, only via S` });
    await insertMem("C", { namespace: ns("shared", "sb"), slug: "c", content: `control neighbour of A` });
    const { error } = await db().from("memory_links").insert([
      { from_id: ids.A, to_id: ids.S, relation: "relates_to", created_by: "test" },
      { from_id: ids.S, to_id: ids.B, relation: "relates_to", created_by: "test" },
      { from_id: ids.A, to_id: ids.C, relation: "relates_to", created_by: "test" },
    ]);
    if (error) throw error;
  });
  beforeEach(() => embedSpy.mockClear());
  afterAll(cleanup);

  // ---------------------------------------------------------------- tier 1
  describe("tier 1: general client work", () => {
    it("project/acme is NOT a confidential project; confidential is", () => {
      expect(ungranted.confidential).toContain(SB_CONF);
      expect(ungranted.confidential).not.toContain("acme");
    });

    it("a lead with NO grant saves a campaign brief in project/acme/test-<runId>; another lead recalls it", async () => {
      const r: any = await remember(ungranted, { namespace: acmeNs(), content: `Acme SME campaign brief ${marker}`, tags: ["acme"] });
      expect(r.id).toBeTruthy();
      expect(r.namespace).toBe(acmeNs());
      ids.T1 = r.id;
      expect(embedSpy).toHaveBeenCalledTimes(1); // allowed writes do embed

      expect(recallIds(await recall(granted, { q: marker, limit: 20 }))).toContain(r.id);
      expect(((await getMemory(granted, { id: r.id })) as any).id).toBe(r.id);
    });

    it("client-name wording, a standalone branch address and SME segment talk pass in shared too", async () => {
      for (const content of [
        `Notes about client onboarding funnel ${runId}`,
        `Chi nhánh Acme 25 Trần Hưng Đạo, Hoàn Kiếm, Hà Nội ${runId}`,
        `Khách hàng SME phản hồi tốt với ưu đãi 150.000.000đ ${runId}`,
      ]) {
        const r: any = await remember(ungranted, { namespace: ns("shared", "t1"), content });
        expect(r.id).toBeTruthy();
      }
    });

    it("recall / post_task / heartbeat / request_approval mentioning a client are fine", async () => {
      const res: any = await recall(ungranted, { q: "Acme SME funnel", limit: 5 });
      expect(Array.isArray(res.hits)).toBe(true);
      const t: any = await postTask(ungranted, { namespace: acmeNs("tasks"), title: "Prep the Acme SME deck" });
      expect(t.id).toBeTruthy();
      expect(await heartbeat(await freshCtx("sbu"), { status_note: "working on Acme deck" })).toMatchObject({ ok: true });
      const a: any = await requestApproval(ungranted, { question: `Send the Acme deck ${runId}?` });
      expect(a.id).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------- tier 2
  describe("tier 2: confidential contracts only in project/confidential (granted)", () => {
    it("contract text into project/confidential-ext/... (confidential context, not a project) -> 422 CONFIDENTIAL (granted or not), embed not called", async () => {
      for (const ctx of [granted, ungranted]) {
        expectContract(await apiErr(remember(ctx, { namespace: ctxNs(), content: CONTRACT })), "07/2026", marker);
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("Confidential-marked contract text into shared / project/test-<runId> -> 422 CONFIDENTIAL", async () => {
      for (const namespace of [ns("shared"), ns("project")]) {
        expectContract(await apiErr(remember(granted, { namespace, content: SB_CONTRACT })), "07/2026", "đối tác");
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("non-confidential contract text into project/test-<runId> (ungranted lead) -> stored normally, embedded", async (t) => {
      if (!has0005) t.skip(SKIP_0005);
      const r: any = await remember(ungranted, { namespace: ns("project", "other-client"), content: CONTRACT, tags: ["client-contract"] });
      expect(r.id).toBeTruthy();
      expect(r.namespace).toBe(ns("project", "other-client"));
      expect(embedSpy).toHaveBeenCalledTimes(1);
    });

    it("into project/confidential/test-<runId> without the grant -> 403 GRANT_REQUIRED, embed not called", async () => {
      for (const confidential of [true, false]) {
        const e = await apiErr(remember(ungranted, { namespace: confNs(), content: CONTRACT, confidential }));
        expect(e).toMatchObject({ status: 403, code: "GRANT_REQUIRED", details: { project: SB_CONF } });
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("WITH the grant + confidential=true -> ok", async () => {
      const r: any = await remember(granted, { namespace: confNs(), content: CONTRACT, confidential: true });
      expect(r.id).toBeTruthy();
      expect(r.namespace).toBe(confNs());
      ids.K = r.id;
      expect(((await getMemory(granted, { id: r.id })) as any).id).toBe(r.id);
    });

    it("confidential=true into a non-confidential namespace -> 422 VALIDATION", async () => {
      for (const namespace of [ns("shared"), acmeNs()]) {
        const e = await apiErr(remember(granted, { namespace, content: `clean text ${runId}`, confidential: true }));
        expect(e).toMatchObject({ status: 422, code: "VALIDATION" });
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("recall with confidential contract wording: ungranted -> 422 CONFIDENTIAL (no embed); granted -> ok", async () => {
      const q = "điều khoản Confidential giữa Bên A và Bên B";
      expectContract(await apiErr(recall(ungranted, { q })), "điều khoản");
      expect(embedSpy).not.toHaveBeenCalled();
      const res: any = await recall(granted, { q, limit: 5 });
      expect(Array.isArray(res.hits)).toBe(true);
      // Non-confidential contract wording (no marker, no confidential namespace filter): fine for anyone
      const plain: any = await recall(ungranted, { q: "điều khoản giữa Bên A và Bên B", limit: 5 });
      expect(Array.isArray(plain.hits)).toBe(true);
      expectContract(await apiErr(recall(ungranted, { q: "điều khoản giữa Bên A và Bên B", namespace: "project/confidential-ext" })));
    });

    it("post_task: confidential contract title in project/test-<runId> -> 422; in project/confidential-ext -> 422; confidential granted -> ok; ungranted -> 403", async () => {
      expectContract(await apiErr(postTask(granted, { namespace: ns("project"), title: SB_CONTRACT_TITLE })), "SME service");
      expectContract(await apiErr(postTask(granted, { namespace: ctxNs(), title: CONTRACT_TITLE })));
      const t: any = await postTask(granted, { namespace: confNs(), title: CONTRACT_TITLE });
      expect(t.id).toBeTruthy();
      ids.KT = t.id;
      expect(await apiErr(postTask(ungranted, { namespace: confNs(), title: CONTRACT_TITLE })))
        .toMatchObject({ status: 403, code: "GRANT_REQUIRED" });
    });

    it("post_task: non-confidential contract title in project/test-<runId> -> ok", async (t) => {
      if (!has0005) t.skip(SKIP_0005);
      const task: any = await postTask(ungranted, { namespace: ns("project"), title: CONTRACT_TITLE });
      expect(task.id).toBeTruthy();
    });

    it("request_approval with confidential contract wording: without task -> 422; on a confidential task (granted) -> ok", async () => {
      expectContract(await apiErr(requestApproval(granted, { question: "Sign Confidential hợp đồng số 07/2026 now?" })), "07/2026");
      const a: any = await requestApproval(granted, { question: "Sign Confidential hợp đồng số 07/2026 now?", task_id: ids.KT });
      expect(a.id).toBeTruthy();
    });

    it("request_approval without task, non-confidential contract wording -> ok", async (t) => {
      if (!has0005) t.skip(SKIP_0005);
      const a: any = await requestApproval(granted, { question: "Sign hợp đồng số 07/2026 now?" });
      expect(a.id).toBeTruthy();
    });

    it("heartbeat status_note with confidential contract wording -> 422 (no namespace, the grant does not help)", async () => {
      const hb = await freshCtx("sbg");
      expect(hb.grants).toContain(SB_CONF); // same identity as `granted`: the grant does not make it allowed
      expectContract(await apiErr(heartbeat(hb, { status_note: "drafting Confidential hợp đồng số 07/2026" })), "07/2026");
    });

    it("heartbeat status_note with non-confidential contract wording (no marker) -> ok", async (t) => {
      if (!has0005) t.skip(SKIP_0005);
      expect(await heartbeat(await freshCtx("sbg"), { status_note: "drafting hợp đồng số 07/2026" })).toMatchObject({ ok: true });
    });
  });

  describe("tier 2: ungranted identity cannot see project/confidential", () => {
    it("recall never returns the confidential memories", async () => {
      const got = recallIds(await recall(ungranted, { q: marker, limit: 20 }));
      expect(got).toContain(ids.A); // control
      expect(got).not.toContain(ids.S);
      expect(got).not.toContain(ids.K);
      expect(got).not.toContain(ids.B); // only reachable through S
    });

    it("get_memory -> 404 NOT_FOUND (no existence leak)", async () => {
      for (const id of [ids.S, ids.K]) {
        expect(await apiErr(getMemory(ungranted, { id }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
      }
    });

    it("get_neighbors(S) -> 404; forget(S) -> 404", async () => {
      expect(await apiErr(getNeighbors(ungranted, { id: ids.S, depth: 2 }))).toMatchObject({ status: 404 });
      expect(await apiErr(forget(ungranted, { id: ids.S }))).toMatchObject({ status: 404 });
    });

    it("graph walk from A at depth 2 never returns S nor B (bridge shared -> confidential -> shared)", async () => {
      const got = idsOf(await getNeighbors(ungranted, { id: ids.A, depth: 2 }));
      expect(got).toContain(ids.C); // control
      expect(got).not.toContain(ids.S);
      expect(got).not.toContain(ids.B);
    });

    it("graph walk from B (incoming side) never returns S nor A through S", async () => {
      const got = idsOf(await getNeighbors(ungranted, { id: ids.B, depth: 2 }));
      expect(got).not.toContain(ids.S);
      expect(got).not.toContain(ids.A);
    });

    it("recall neighbours of A never include S or B", async () => {
      const res: any = await recall(ungranted, { q: `anchor ${marker}`, namespace: ns("shared", "sb"), limit: 1 });
      const hitA = (res.hits ?? []).find((h: any) => h.id === ids.A);
      expect(hitA).toBeTruthy();
      const nb = (hitA.neighbors ?? []).map((n: any) => n.id);
      expect(nb).not.toContain(ids.S);
      expect(nb).not.toContain(ids.B);
    });

    it("granted identity (control) sees S and B through the graph and K in recall", async () => {
      const got = idsOf(await getNeighbors(granted, { id: ids.A, depth: 2 }));
      expect(got).toContain(ids.S);
      expect(got).toContain(ids.B);
      const r = recallIds(await recall(granted, { q: marker, limit: 20 }));
      expect(r).toContain(ids.S);
      expect(r).toContain(ids.K);
    });
  });

  // ---------------------------------------------------------------- tier 3
  describe("tier 3: customer PII is blocked everywhere", () => {
    it.each(PII)("remember %s -> 422 CUSTOMER_PII_BLOCKED in shared, project/acme AND confidential (granted)", async (_l, text, secret) => {
      for (const [namespace, confidential] of [[ns("shared"), false], [acmeNs(), false], [confNs(), true]] as const) {
        expectPii(await apiErr(remember(granted, { namespace, content: text, confidential })), secret, text);
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("PII beats the contract allowance: contract + CCCD in confidential -> CUSTOMER_PII_BLOCKED", async () => {
      expectPii(await apiErr(remember(granted, { namespace: confNs(), content: `${CONTRACT}, Bên B CCCD 001099012345`, confidential: true })), "001099012345");
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("PII in tags is blocked too", async () => {
      expectPii(await apiErr(remember(granted, { namespace: ns("shared"), content: `clean ${runId}`, tags: ["0912 345 678"] })), "0912 345 678");
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it.each(PII)("recall query with %s -> 422, embed not called", async (_l, text, secret) => {
      for (const ctx of [granted, ungranted]) expectPii(await apiErr(recall(ctx, { q: text })), secret);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it.each(PII)("post_task title with %s -> 422 (shared project and confidential)", async (_l, text, secret) => {
      for (const namespace of [ns("project"), acmeNs(), confNs()]) {
        expectPii(await apiErr(postTask(granted, { namespace, title: text })), secret);
      }
    });

    it.each(PII)("heartbeat status_note with %s -> 422", async (_l, text, secret) => {
      expectPii(await apiErr(heartbeat(await freshCtx("sbg"), { status_note: text })), secret);
    });

    it.each(PII)("request_approval with %s -> 422 (with and without a confidential task)", async (_l, text, secret) => {
      expectPii(await apiErr(requestApproval(granted, { question: text })), secret);
      expectPii(await apiErr(requestApproval(granted, { question: text, task_id: ids.KT })), secret);
    });

    it("nothing PII-bearing was stored by the handler calls above", async () => {
      for (const [, , secret] of PII) {
        const { data: m } = await db().from("memories").select("id").like("namespace", `%/test-${runId}%`).like("content", `%${secret}%`);
        expect(m ?? []).toEqual([]);
        const { data: t } = await db().from("tasks").select("id").like("namespace", `%/test-${runId}%`).like("title", `%${secret}%`);
        expect(t ?? []).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------- classes 3-5 (§13.5)
  describe("classes 3-5: employee PII, non-public financials, credentials are blocked everywhere", () => {
    it.each(CLASSES)("remember %s -> 422 in shared, project/acme AND confidential (granted, confidential)", async (_l, code, text, secret) => {
      for (const [namespace, confidential] of [[ns("shared"), false], [acmeNs(), false], [confNs(), true]] as const) {
        expectClass(await apiErr(remember(granted, { namespace, content: text, confidential })), code, secret, text);
      }
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("credentials are blocked in non-confidential namespaces too (claude/test-<runId>, project/test-<runId>/x)", async () => {
      const [, code, text, secret] = CRED;
      for (const namespace of [ns("claude"), ns("project", "x")]) {
        expectClass(await apiErr(remember(ungranted, { namespace, content: text })), code, secret, text);
      }
      expectClass(await apiErr(postTask(ungranted, { namespace: ns("project", "x"), title: text })), code, secret);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("recall query with a credential -> 422 CREDENTIALS_BLOCKED, embed not called", async () => {
      const [, code, text, secret] = CRED;
      for (const ctx of [granted, ungranted]) expectClass(await apiErr(recall(ctx, { q: text })), code, secret);
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("post_task title with non-public financials -> 422 (project/acme and confidential)", async () => {
      const [, code, text, secret] = FIN;
      for (const namespace of [acmeNs("tasks"), confNs()]) {
        expectClass(await apiErr(postTask(granted, { namespace, title: text })), code, secret);
      }
    });

    it("heartbeat status_note with a credential -> 422 (fresh token)", async () => {
      const [, code, text, secret] = CRED;
      expectClass(await apiErr(heartbeat(await freshCtx("sbg"), { status_note: text })), code, secret);
    });

    it("request_approval with employee PII -> 422 (with and without a confidential task)", async () => {
      const [, code, text, secret] = EMP;
      expectClass(await apiErr(requestApproval(granted, { question: text })), code, secret);
      expectClass(await apiErr(requestApproval(granted, { question: text, task_id: ids.KT })), code, secret);
    });

    it("must-pass texts are stored normally in project/acme (no grant) and embed is called", async () => {
      for (const content of CLASS_MUST_PASS) {
        embedSpy.mockClear();
        const r: any = await remember(ungranted, { namespace: acmeNs("pass"), content });
        expect(r.id, content).toBeTruthy();
        expect(embedSpy).toHaveBeenCalledTimes(1);
      }
    });

    it("nothing class 3-5 bearing was stored by the handler calls above", async () => {
      for (const [, , , secret] of CLASSES) {
        const { data: m } = await db().from("memories").select("id").like("namespace", `%/test-${runId}%`).like("content", `%${secret}%`);
        expect(m ?? []).toEqual([]);
        const { data: t } = await db().from("tasks").select("id").like("namespace", `%/test-${runId}%`).like("title", `%${secret}%`);
        expect(t ?? []).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------- DB layer 2
  describe("DB layer 2 (triggers, service role)", () => {
    const base = () => ({ author_agent: "claude", author_token: grantedTok });

    it.each(PII)("direct memory insert with %s anywhere -> CUSTOMER_PII_BLOCKED:<rule>, no echo", async (_l, text, secret) => {
      for (const namespace of [ns("shared"), acmeNs("direct"), confNs("direct")]) {
        const { error } = await db().from("memories").insert({ ...base(), namespace, slug: `pii-${runId}`, content: text });
        expect(error?.message?.startsWith("CUSTOMER_PII_BLOCKED:")).toBe(true);
        expect(error?.message).not.toContain(secret);
      }
    });

    it("direct task insert with PII title (even in confidential) -> CUSTOMER_PII_BLOCKED:", async () => {
      for (const namespace of [ns("project"), confNs()]) {
        const { error } = await db().from("tasks").insert({ namespace, title: "gọi 0912 345 678", created_by: "test", created_by_token: grantedTok });
        expect(error?.message?.startsWith("CUSTOMER_PII_BLOCKED:")).toBe(true);
      }
    });

    it("direct approval insert with PII question -> CUSTOMER_PII_BLOCKED:", async () => {
      const { error } = await db().from("approvals").insert({
        requested_by: "claude", requested_by_token: grantedTok, question: "Họ tên: Nguyễn Văn An ok?", options: [],
      });
      expect(error?.message?.startsWith("CUSTOMER_PII_BLOCKED:")).toBe(true);
    });

    it("direct memory insert of confidential contract text (marker in shared / plain in project/confidential-ext) -> CONFIDENTIAL:<rule>, no echo", async () => {
      for (const [namespace, content] of [[ns("shared"), SB_CONTRACT], [ctxNs("direct"), CONTRACT]]) {
        const { error } = await db().from("memories").insert({ ...base(), namespace, slug: `k-${runId}`, content });
        expect(error?.message?.startsWith("CONFIDENTIAL:")).toBe(true);
        expect(error?.message).not.toContain("07/2026");
      }
    });

    it("direct memory / task insert of a non-confidential contract in project/test-<runId> -> ok (0005)", async (t) => {
      if (!has0005) t.skip(SKIP_0005);
      const m = await db().from("memories").insert({ ...base(), namespace: ns("project", "direct"), slug: `nk-${runId}`, content: CONTRACT });
      expect(m.error).toBeNull();
      const k = await db().from("tasks").insert({ namespace: ns("project", "direct"), title: CONTRACT_TITLE, created_by: "test", created_by_token: grantedTok });
      expect(k.error).toBeNull();
    });

    it("direct memory insert of contract text in project/confidential/test-<runId> -> ok", async () => {
      const { data, error } = await db().from("memories").insert({ ...base(), namespace: confNs("direct"), slug: `k-${runId}`, content: CONTRACT }).select("id").single();
      expect(error).toBeNull();
      expect(data?.id).toBeTruthy();
    });

    it("direct task insert with confidential contract title: outside -> CONFIDENTIAL:; in confidential -> ok", async () => {
      const out = await db().from("tasks").insert({ namespace: ns("project"), title: SB_CONTRACT_TITLE, created_by: "test", created_by_token: grantedTok });
      expect(out.error?.message?.startsWith("CONFIDENTIAL:")).toBe(true);
      const ok = await db().from("tasks").insert({ namespace: confNs("direct"), title: CONTRACT_TITLE, created_by: "test", created_by_token: grantedTok }).select("id").single();
      expect(ok.error).toBeNull();
    });

    it("general confidential-project wording passes the triggers in shared (old name rule no longer blocks)", async () => {
      const { error } = await db().from("memories").insert({ ...base(), namespace: ns("shared", "direct"), slug: `g-${runId}`, content: "notes about client SME funnel" });
      expect(error).toBeNull();
    });
  });

  // ---------------------------------------------------------------- DB layer 2, classes 3-5 (migration 0004)
  // Runs only once the live DB has the class 3-5 trigger rules (hub_credential_rule etc., migration 0004);
  // until then every case is SKIPPED (has0004 is probed at module load, see probe0004 above).
  describe.skipIf(!has0004)(`DB layer 2, classes 3-5 (triggers, service role)${has0004 ? "" : ` [SKIPPED: ${SKIP_0004}]`}`, () => {
    const base = () => ({ author_agent: "claude", author_token: grantedTok });

    it.each(CLASSES)("direct memory insert with %s (shared, project/acme, confidential) -> <CODE>:<rule>, no echo", async (_l, code, text, secret) => {
      for (const namespace of [ns("shared"), acmeNs("direct"), confNs("direct")]) {
        const { error } = await db().from("memories").insert({ ...base(), namespace, slug: `c35-${runId}`, content: text });
        expect(error?.message?.startsWith(`${code}:`), namespace).toBe(true);
        expect(error?.message).not.toContain(secret);
      }
    });

    it("direct memory insert with a credential in non-confidential namespaces -> CREDENTIALS_BLOCKED:", async () => {
      for (const namespace of [ns("claude"), ns("project", "x")]) {
        const { error } = await db().from("memories").insert({ ...base(), namespace, slug: `cred-${runId}`, content: CRED[2] });
        expect(error?.message?.startsWith("CREDENTIALS_BLOCKED:")).toBe(true);
        expect(error?.message).not.toContain(CRED[3]);
      }
    });

    it.each(CLASSES)("direct task insert with %s title (even in confidential) -> <CODE>:", async (_l, code, text) => {
      for (const namespace of [ns("project"), confNs("direct")]) {
        const { error } = await db().from("tasks").insert({ namespace, title: text, created_by: "test", created_by_token: grantedTok });
        expect(error?.message?.startsWith(`${code}:`)).toBe(true);
      }
    });

    it.each(CLASSES)("direct approval insert with %s question -> <CODE>:", async (_l, code, text) => {
      const { error } = await db().from("approvals").insert({ requested_by: "claude", requested_by_token: grantedTok, question: text, options: [] });
      expect(error?.message?.startsWith(`${code}:`)).toBe(true);
    });

    it("direct task_events note and agent_tokens status_note with a credential -> CREDENTIALS_BLOCKED:", async () => {
      const ok = await db().from("tasks").insert({ namespace: ns("project", "ev"), title: `clean ${runId}`, created_by: "test", created_by_token: grantedTok }).select("id").single();
      if (ok.error) throw ok.error;
      const ev = await db().from("task_events").insert({ task_id: ok.data.id, actor: "test", kind: "update", note: CRED[2] });
      expect(ev.error?.message?.startsWith("CREDENTIALS_BLOCKED:")).toBe(true);
      const tk = await db().from("agent_tokens").update({ status_note: CRED[2] }).eq("id", grantedTok);
      expect(tk.error?.message?.startsWith("CREDENTIALS_BLOCKED:")).toBe(true);
    });

    it("must-pass texts pass the triggers in project/acme", async () => {
      for (const [i, content] of CLASS_MUST_PASS.entries()) {
        const { error } = await db().from("memories").insert({ ...base(), namespace: acmeNs("direct-pass"), slug: `p${i}-${runId}`, content });
        expect(error, content).toBeNull();
      }
    });
  });
});
