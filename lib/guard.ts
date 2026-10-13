import { ADMIN_TOKEN_PREFIX, TOKEN_PREFIX } from "./config";
import { confSlug } from "./scopes";
import { ApiError, type AgentCtx } from "./types";

// CONTRACT §13 confidential tiered rule + §13.5 classes 3-5. Blocked everywhere: credentials/system info (class 5, ALL
// namespaces), customer PII (class 2), employee PII (class 3), non-public financials (class 4). Contracts (class 1):
// Confidential contracts only inside the grant-gated confidential project; non-confidential contracts are stored normally
// (confidentialContext, migration 0005). General work is never blocked here.
// SQL hub_pii_rule / hub_contract_rule (+ the 0004 class 3-5 functions) mirror these (SQL may be narrower, see §13 parity).
// All regexes run on NFC-normalized text with the `u` flag. JS `\b` is ASCII-only, so Vietnamese-initial
// words use explicit letter/digit lookarounds instead.
// Rule packs: English + Vietnamese patterns ship by default (see the labels/units below); add your own locale's
// patterns alongside them. The confidential slug and marker below are constants here and in SQL
// hub_confidential_context; changing them means changing both.

export const CONFIDENTIAL_SLUG = "confidential";

// §13 / §13.5 fixed messages (never include the input). Shared by the app guard, errorResponse and dashboard mappers.
export type TierCode =
  | "CREDENTIALS_BLOCKED"
  | "CUSTOMER_PII_BLOCKED"
  | "EMPLOYEE_PII_BLOCKED"
  | "FINANCIALS_BLOCKED"
  | "CONFIDENTIAL";
export const TIER_MESSAGES: Readonly<Record<TierCode, string>> = {
  CREDENTIALS_BLOCKED:
    "Credentials and internal system details (passwords, keys, tokens, connection strings, internal hosts) must not be stored. Remove them and save only the non-secret facts.",
  CUSTOMER_PII_BLOCKED: "Customer personal information must not be stored. Remove it and save only the non-personal facts.",
  EMPLOYEE_PII_BLOCKED:
    "Employee personal information (staff IDs, HR records tied to a person) must not be stored. Remove it and save only the non-personal facts.",
  FINANCIALS_BLOCKED:
    "Non-public financial figures (budgets, targets, unpublished rates) must not be stored. Remove the amounts and save only the plan.",
  CONFIDENTIAL: "confidential contract content must be saved with confidential=true in project/confidential (needs a grant).",
};
/** Check order (§13.5): first hit wins. */
export const TIER_CODES: readonly TierCode[] = [
  "CREDENTIALS_BLOCKED",
  "CUSTOMER_PII_BLOCKED",
  "EMPLOYEE_PII_BLOCKED",
  "FINANCIALS_BLOCKED",
  "CONFIDENTIAL",
];
const RULE_ID_RE = /^[a-z0-9_]{1,40}$/;

/**
 * Tier hit from the JS guard (ApiError with a tier code) or a DB trigger (`<CODE>:<rule>` message).
 * Only a well-formed rule id is kept; anything else in the message is dropped (never echoed).
 */
export function tierHit(e: unknown): { code: TierCode; rule?: string } | null {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = (e as { message?: unknown } | null)?.message;
  const clean = (r: unknown) => (typeof r === "string" && RULE_ID_RE.test(r.trim()) ? r.trim() : undefined);
  for (const c of TIER_CODES) {
    if (code === c && e instanceof ApiError) return { code: c, rule: clean((e.details as { rule?: unknown } | undefined)?.rule) };
    if (typeof msg === "string" && msg.startsWith(`${c}:`)) return { code: c, rule: clean(msg.slice(c.length + 1)) };
  }
  return null;
}

/** One readable, content-free sentence for a tier hit (dashboard UIs). Only the rule id is shown. */
export function tierReadable(hit: { code: TierCode; rule?: string }): string {
  return `Blocked${hit.rule ? ` (rule: ${hit.rule})` : ""}: ${TIER_MESSAGES[hit.code]}`;
}

// ---- §13.1 PII (first hit wins, in this order) ----
// cccd: 12 digits, province 0xx, gender/century digit 0-3.
const CCCD_RE = /(?<!\d)0\d{2}[0-3]\d{8}(?!\d)/u;
// id_keyword: ID-document keyword then an (optionally letter-prefixed) 7-12 digit number.
const ID_KEYWORD_RE =
  /(?<![\p{L}\d])(cmnd|cccd|cmt|căn cước|chứng minh|hộ chiếu|passport|id no\.?)\D{0,15}[A-Z]?\d{7,12}(?!\d)/iu;
// phone: VN mobile, +84 / 84 / 0 prefix, separators (space . -) allowed between digits.
const PHONE_RE = /(?<![\d+])(\+?84|0)[\s.-]?[35789](\d[\s.-]?){7}\d(?!\d)/u;
// card: plain 13-19 digits, or 4-4-4-4(+1..3) groups, or 4-6-4/5 (Amex/Diners); Luhn-checked below.
const CARD_RE = /(?<!\d)(?:\d{13,19}|\d{4}(?:[ -]\d{4}){3}(?:[ -]?\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})(?!\d)/gu;
// account: account-number keyword then 6+ digits.
const ACCOUNT_RE = /(?<!\p{L})(stk|s[oố] t[aà]i kho[aả]n|account (no|number|#)|tk ngân hàng)\D{0,5}\d{6,}/iu;
// name_label: label + colon + value.
const NAME_LABEL_RE =
  /(?<!\p{L})(họ (và )?tên|tên kh|tên khách hàng|khách hàng|customer name|full name)\s*[:：]\s*\S/iu;
// name_honorific (JS-only, case-sensitive): honorific + 2+ capitalised words. "Bà Rịa" (province) excluded.
const NAME_HONORIFIC_RE =
  /(?<![\p{L}\d])(Ông|Bà|Anh|Chị|Mr|Mrs|Ms)\.?\s+(?!Rịa(?!\p{L}))\p{Lu}\p{Ll}+(\s+\p{Lu}\p{Ll}+)+/u;

// ---- §13.2 contract markers ----
// Contract-number rules require an id that contains a digit (optional short letter prefix, e.g. "AB-2026-001"),
// so "hợp đồng số hoá" / "the contract not renewed" pass.
const CONTRACT_NO_VI_RE = /(?<!\p{L})(hợp đồng|HĐ)\s*(số|no\.?)\s*[:#]?\s*[A-Za-z]{0,6}[-/]?\d/iu;
const CONTRACT_NUM_LABEL_RE = /(?<!\p{L})số hợp đồng\s*[:：#]\s*\S/iu;
const PARTY_A_RE = /(?<![\p{L}\d])Bên A(?![\p{L}\d])/u;
const PARTY_B_RE = /(?<![\p{L}\d])Bên B(?![\p{L}\d])/u;
const ARTICLE_1_RE = /(?<![\p{L}\d])Điều 1(?![\p{L}\d])/u;
const HOP_DONG_RE = /hợp đồng/iu;
const CONTRACT_NO_EN_RE = /(?<!\p{L})contract no(?:\.|(?![a-z]))\s*[:#]?\s*[A-Za-z]{0,6}[-/]?\d/iu;
const AGREEMENT_BETWEEN_RE = /agreement between/iu;
const THE_PARTIES_RE = /the parties/iu;

function norm(text: string | null | undefined): string | null {
  return text == null ? null : text.normalize("NFC");
}

function luhn(d: string): boolean {
  const digits = d.replace(/\D/g, "");
  if (!digits.length) return false;
  let s = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let x = digits.charCodeAt(i) - 48;
    if (alt) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    s += x;
    alt = !alt;
  }
  return s % 10 === 0;
}

// §13.1: returns the first PII rule id hit, or null.
export function piiRule(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  if (CCCD_RE.test(t)) return "cccd";
  if (ID_KEYWORD_RE.test(t)) return "id_keyword";
  if (PHONE_RE.test(t)) return "phone";
  for (const m of t.matchAll(CARD_RE)) if (luhn(m[0])) return "card";
  if (ACCOUNT_RE.test(t)) return "account";
  if (NAME_LABEL_RE.test(t)) return "name_label";
  if (NAME_HONORIFIC_RE.test(t)) return "name_honorific";
  return null;
}

// §13.2: returns the first contract rule id hit, or null.
export function contractRule(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  if (CONTRACT_NO_VI_RE.test(t)) return "contract_no_vi";
  if (CONTRACT_NUM_LABEL_RE.test(t)) return "contract_number_label";
  if (PARTY_A_RE.test(t) && PARTY_B_RE.test(t)) return "parties_ab";
  if (ARTICLE_1_RE.test(t) && HOP_DONG_RE.test(t)) return "article_1";
  if (CONTRACT_NO_EN_RE.test(t)) return "contract_no_en";
  if (AGREEMENT_BETWEEN_RE.test(t) && THE_PARTIES_RE.test(t)) return "agreement_parties";
  return null;
}

// ---- §13.5 class 5: credentials / system info (ALL namespaces) ----
const PASSWORD_RE = /(?<!\p{L})(mật khẩu|password|passwd|pwd)\s*[:=]\s*\S/iu;
// Known secret prefixes (case-sensitive), each with a minimum body length so a bare prefix mention passes.
const SECRET_TOKEN_RE = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}`,
    String.raw`(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9]{10,}`,
    String.raw`(?<![A-Za-z0-9_-])gh[po]_[A-Za-z0-9]{20,}`,
    String.raw`(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}`,
    String.raw`(?<![A-Za-z0-9_-])xox[abp]-[A-Za-z0-9-]{10,}`,
    String.raw`(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])`,
    String.raw`(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}`,
    // Own token formats: generic agent-id shape (not the configured list, so a removed agent's token still blocks).
    String.raw`(?<![A-Za-z0-9_-])${TOKEN_PREFIX}_[a-z][a-z0-9]{1,23}_[A-Za-z0-9_-]{20,}`,
    String.raw`(?<![A-Za-z0-9_-])${ADMIN_TOKEN_PREFIX}[A-Za-z0-9_-]{20,}`,
    String.raw`eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  ].join("|"),
  "u",
);
const CONN_STRING_RE = /(?<![a-z])(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s:]+:[^\s@]+@/iu;
// Private IPv4 (10/8, 172.16/12, 192.168/16); not part of a longer dotted number (so "v1.10.2.3.4" style passes).
const PRIVATE_IP_RE =
  /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d]|\.\d)/u;
// Internal hostnames: *.local / *.internal / *.corp / *.lan, or an "intranet" host label.
// "localhost:13100" passes (no dot before "local").
const INTERNAL_HOST_RE = new RegExp(
  [
    String.raw`(?<![\p{L}\d-])[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|internal|corp|lan)(?![\p{L}\d-])(?!\.[a-z])`,
    String.raw`(?<![\p{L}\d-])(?:[a-z0-9-]+\.)*intranet[a-z0-9-]*\.[a-z]`,
    String.raw`:\/\/intranet(?![\p{L}\d])`,
  ].join("|"),
  "iu",
);

// §13.5 class 5: returns the first credentials/system-info rule id hit, or null.
export function credentialRule(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  if (PASSWORD_RE.test(t)) return "password";
  if (SECRET_TOKEN_RE.test(t)) return "secret_token";
  if (CONN_STRING_RE.test(t)) return "conn_string";
  if (PRIVATE_IP_RE.test(t) || INTERNAL_HOST_RE.test(t)) return "internal_host";
  return null;
}

// ---- §13.5 class 3: employee PII ----
const STAFF_ID_RE =
  /(?<!\p{L})(mã (nv|nhân viên|số nhân viên)|msnv|employee id|staff id|emp id)\s*(no\.?|number|#)?\s*[:#]?\s*(?=[A-Za-z-]*\d)[A-Za-z0-9-]{3,}/iu;
const HR_RE = /(?<!\p{L})(lương|salary|đánh giá (hiệu suất|năng lực)|performance review|kỷ luật|disciplin\p{L}*)(?!\p{L})/giu;
const toGlobal = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
const NAME_LABEL_G = toGlobal(NAME_LABEL_RE);
const NAME_HONORIFIC_G = toGlobal(NAME_HONORIFIC_RE);
const STAFF_ID_G = toGlobal(STAFF_ID_RE);

/** True if some match of `a` and some match of `b` are within `n` characters of each other (gap between spans). */
function near(t: string, a: RegExp, b: RegExp, n: number): boolean {
  const spans = (re: RegExp) => [...t.matchAll(re)].map((m) => [m.index, m.index + m[0].length] as const);
  const bs = spans(b);
  if (!bs.length) return false;
  for (const [a0, a1] of spans(a)) {
    for (const [b0, b1] of bs) if (Math.max(0, b0 - a1, a0 - b1) <= n) return true;
  }
  return false;
}

// §13.5 class 3: returns the first employee-PII rule id hit, or null.
export function employeeRule(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  if (STAFF_ID_RE.test(t)) return "staff_id";
  if (near(t, HR_RE, NAME_HONORIFIC_G, 60) || near(t, HR_RE, NAME_LABEL_G, 60) || near(t, HR_RE, STAFF_ID_G, 60)) {
    return "hr_record";
  }
  return null;
}

// ---- §13.5 class 4: non-public financials ----
// Amount = number + currency/magnitude unit, currency + number, or a bare integer >= 1,000,000 (7+ digits, or
// 3+ thousand-groups like 150.000.000). Percentages, CTR/CPC ratios and small counts are not amounts.
const AMOUNT_SRC = [
  String.raw`(?<![\p{L}\d])\d[\d.,]*\s*(tỷ|triệu|tr|k|nghìn|ngàn|vnd|vnđ|đ|usd|\$|bn|m|million|billion)(?!\p{L})`,
  String.raw`(?<!\p{L})(\$|vnd|vnđ|usd)\s*\d`,
  String.raw`(?<![\d.,])\d{7,}(?![\d])`,
  String.raw`(?<![\d.,])\d{1,3}([.,]\d{3}){2,}(?![\d])`,
].join("|");
/** Global, case-insensitive matcher for a money/magnitude amount (§13.5). Use with matchAll; do not share lastIndex. */
export const amountRe = (): RegExp => new RegExp(AMOUNT_SRC, "giu");
const AMOUNT_G = amountRe();
const BUDGET_G = /(?<!\p{L})(ngân sách|budgets?|chi phí dự kiến)(?!\p{L})/giu;
const TARGET_G = /(?<!\p{L})(chỉ tiêu|targets?|KPIs?|doanh số|dư nợ)(?!\p{L})/giu;
const RATE_RE = /(?<!\p{L})(lãi suất|interest rates?)(?!\p{L})[^%\n]{0,40}?\d+([.,]\d+)?\s*%/iu;
// "public" exemption, but not "non-public", "unpublished", "chưa công bố", "not (yet) public/published".
const RATE_PUBLIC_RE =
  /(?<![\p{L}-])(?<!chưa )(?<!not )(?<!not yet )(công bố|public|published|niêm yết)(?!\p{L})/iu;

// §13.5 class 4: returns the first financials rule id hit, or null.
export function financialRule(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  if (near(t, BUDGET_G, AMOUNT_G, 40)) return "budget_amount";
  if (near(t, TARGET_G, AMOUNT_G, 40)) return "target_amount";
  if (RATE_RE.test(t) && !RATE_PUBLIC_RE.test(t)) return "rate_unpublished";
  return null;
}

const NAME_RULES = new Set(["name_label", "name_honorific"]);

// ---- §13.2 confidential context (contract tier scope, migration 0005; SQL hub_confidential_context mirrors this) ----
// A namespace whose project slug starts with "confidential" (project/confidential, project/confidential-x, ...), or
// any text carrying the word "confidential". Namespaces are usually among the guarded texts too, so the word anywhere
// in one also counts (the marker regex is unanchored, same as SQL).
const CONFIDENTIAL_NS_RE = /^project\/confidential[^/]*(\/|$)/iu;
const CONFIDENTIAL_MARKER_RE = /confidential/iu;

/** True if `ns` is a confidential project namespace or any text carries a confidential marker (§13.2). */
export function confidentialContext(ns: string | null | undefined, texts: ReadonlyArray<string | null | undefined>): boolean {
  const n = norm(ns);
  if (n && CONFIDENTIAL_NS_RE.test(n)) return true;
  for (const t of texts) {
    const x = norm(t);
    if (x && CONFIDENTIAL_MARKER_RE.test(x)) return true;
  }
  return false;
}

/**
 * Contract gate for assertConfidentialTiers. `ok` = contracts allowed regardless of context (contractOk: confidential
 * + grant). `ns` = namespace the write lands in; null/omitted for ops without one (heartbeat, machine/project names,
 * reassign target, approval without task) -> only a marker in the texts makes it confidential context. `context` = extra
 * texts read ONLY for confidential markers (e.g. the parent task's title/body, the DB row's other columns), never tier-checked.
 */
export type ContractGate = { ok: boolean; ns?: string | null; context?: ReadonlyArray<string | null | undefined> };

// §13.5 order across ALL texts, first hit wins: credentials -> customer PII -> employee PII -> financials -> contract
// (contract only in confidential context and when !gate.ok). A text whose only customer-PII hit is a name AND that is an
// HR record (hr_record) is employee PII, not customer PII. Errors never include the offending text; details are {rule} only.
export function assertConfidentialTiers(gate: ContractGate, ...texts: Array<string | null | undefined>): void {
  const fail = (code: TierCode, rule: string): never => {
    throw new ApiError(422, code, TIER_MESSAGES[code], { rule });
  };
  for (const t of texts) {
    const rule = credentialRule(t);
    if (rule) fail("CREDENTIALS_BLOCKED", rule);
  }
  for (const t of texts) {
    const rule = piiRule(t);
    if (rule && !(NAME_RULES.has(rule) && employeeRule(t) === "hr_record")) fail("CUSTOMER_PII_BLOCKED", rule);
  }
  for (const t of texts) {
    const rule = employeeRule(t);
    if (rule) fail("EMPLOYEE_PII_BLOCKED", rule);
  }
  for (const t of texts) {
    const rule = financialRule(t);
    if (rule) fail("FINANCIALS_BLOCKED", rule);
  }
  if (gate.ok || !confidentialContext(gate.ns, [...texts, ...(gate.context ?? [])])) return;
  for (const t of texts) {
    const rule = contractRule(t);
    if (rule) fail("CONFIDENTIAL", rule);
  }
}

export function contractOk(ctx: Pick<AgentCtx, "grants" | "confidential">, ns: string | null): boolean {
  return (
    ns != null &&
    confSlug(ns, ctx.confidential) === CONFIDENTIAL_SLUG &&
    ctx.grants.includes(CONFIDENTIAL_SLUG)
  );
}

const INSTRUCTION_RE =
  /ignore (all|any|previous|prior) instructions|you must now|system prompt|<\/?(system|tool_call|function_call)>|disregard (the|all) (above|previous)/i;

// ponytail: keyword heuristic only; flags, never blocks. Upgrade to a classifier if false negatives matter.
export function instructionLike(text: string): boolean {
  return INSTRUCTION_RE.test(text);
}
