// CONTRACT §13 confidential tiered rule: pure fixture tests for lib/guard.ts (no DB).
import { describe, it, expect } from "vitest";
import {
  piiRule,
  contractRule,
  credentialRule,
  employeeRule,
  financialRule,
  amountRe,
  assertConfidentialTiers,
  contractOk,
  confidentialContext,
  tierHit,
  TIER_MESSAGES,
  TIER_CODES,
  CONFIDENTIAL_SLUG,
} from "../lib/guard";
import { ApiError } from "../lib/types";

// [text, expected rule id]
const PII_BLOCK: Array<[string, string]> = [
  ["001203012345", "cccd"],
  ["Số CCCD 079095001234 cấp ngày 01/01/2021", "cccd"],
  ["CMND: 123456789", "id_keyword"],
  ["Hộ chiếu C1234567", "id_keyword"],
  ["passport no. B7654321", "id_keyword"],
  ["0912345678", "phone"],
  ["0912 345 678", "phone"],
  ["091.234.5678", "phone"],
  ["+84 912 345 678", "phone"],
  ["84912345678", "phone"],
  ["Gọi lại số 0387654321 sau 5h", "phone"],
  ["4111 1111 1111 1111", "card"],
  ["5500-0000-0000-0004", "card"],
  ["4242424242424242", "card"],
  ["378282246310005", "card"],
  ["Amex 3782 822463 10005", "card"],
  ["STK 0123456789", "account"],
  ["Số tài khoản: 12345678", "account"],
  ["account number 9876543210", "account"],
  ["Họ tên: Nguyễn Văn An", "name_label"],
  ["Họ và tên: Nguyễn Văn An", "name_label"],
  ["Tên KH: Lê Thị Bình", "name_label"],
  ["Khách hàng: Trần Minh", "name_label"],
  ["Customer name: John Smith", "name_label"],
  ["Ông Nguyễn Văn An", "name_honorific"],
  ["Chị Lê Thị Hoa", "name_honorific"],
  ["Mr John Smith", "name_honorific"],
  ["Gặp Bà Phạm Thu Hà, 12 Lý Thái Tổ, Hà Nội", "name_honorific"],
  ["Bà Phạm Thu Hà, 12 Lý Thái Tổ, Hà Nội", "name_honorific"],
  ["Giao tới 12 Lý Thái Tổ, Hà Nội, SĐT 0912345678", "phone"],
  // NFD (decomposed diacritics) must not slip past.
  ["Họ tên: Nguyễn Văn An".normalize("NFD"), "name_label"],
  ["Ông Nguyễn Văn An".normalize("NFD"), "name_honorific"],
];

const CONTRACT_BLOCK: Array<[string, string]> = [
  ["Hợp đồng số 12/2026/HĐ-XY", "contract_no_vi"],
  ["HĐ số 45", "contract_no_vi"],
  ["Số hợp đồng: 778", "contract_number_label"],
  ["Bên A: Công ty TNHH ABC. Bên B: Công ty TNHH Quảng Cáo XYZ", "parties_ab"],
  ["Điều 1. Phạm vi hợp đồng", "article_1"],
  ["Contract No. XY-2026-001", "contract_no_en"],
  ["This agreement between Acme and Agency X sets out the scope; the parties agree to the terms below.", "agreement_parties"],
  ["Hợp đồng số 12/2026/HĐ-XY".normalize("NFD"), "contract_no_vi"],
];

// Must pass BOTH piiRule and contractRule.
const PASS: string[] = [
  "Acme SME campaign brief Q4",
  "Khách hàng SME cần vay vốn lưu động",
  "customers in the SME segment",
  "Phân khúc khách hàng doanh nghiệp nhỏ",
  // "Budget 150000000 VND" moved to FIN_BLOCK (§13.5 flips it to FINANCIALS_BLOCKED).
  "150.000.000đ",
  "Chi nhánh: 198 Trần Quang Khải, Hoàn Kiếm, Hà Nội",
  "Funnel: landing -> form -> call",
  "Discuss the contract renewal timeline",
  "Điều chỉnh ngân sách",
  "the parties at the event",
  "Q4 2026",
  "07/10/2026",
  "Launch 2026-10-07, review 31/12/2026",
  "CMP-2026-1001",
  "Order 4111111111111112",
  "version 1.2.3.4",
  "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b",
  "XYZ ticker up",
  "Anh em trong team",
  "Chị em phụ nữ",
  "123456789",
  // lone markers (campaign copy talks about contracts)
  "hợp đồng",
  "Tăng số lượng hợp đồng tín dụng SME",
  "Điều 1",
  "contract",
  // plausible campaign copy the narrowed contract regexes must not catch
  "Ký hợp đồng số hoá ngay trên app",
  "Số hợp đồng ký mới tăng 20% so với Q3",
  "The contract not renewed yet, follow up",
  "Agreement between teams on the funnel",
  // address-ish / location copy
  "Sự kiện tại Bà Rịa Vũng Tàu tháng 11",
  "Mr Bean themed ad",
  "Acme hotline 1900 555 587",
  "CTR 3.5%, CPC 12000đ, 45000 clicks",
];

// ---- §13.5 classes 3-5 ----
const CRED_BLOCK: Array<[string, string]> = [
  ["password: Hunter2!", "password"],
  ["Mật khẩu: abc@123", "password"],
  ["pwd=Secr3t", "password"],
  ["wifi passwd : guest2026", "password"],
  ["OpenAI key sk-" + "proj-FAKEFAKE1234567890XyZ", "secret_token"],
  ["Stripe sk_" + "live_FAKE51HxYzAbCdEf12", "secret_token"],
  ["token gh" + "p_FAKEabcdefghijklmnopqrstuvwxyz0123456789", "secret_token"],
  ["github_" + "pat_FAKE11ABCDEFG0123456789_abcdefghij", "secret_token"],
  ["slack xox" + "b-FAKE1234567890-abcdefghij", "secret_token"],
  ["AWS AK" + "IAFAKEFAKEFAKE1234", "secret_token"],
  ["AIza" + "FAKE0123456789abcdefghijklmnopqrstu", "secret_token"],
  ["Bearer agency-board_claude_FAKEFAKEFAKEFAKEFAKEFAKEFAKE", "secret_token"],
  ["admin agency-board-admin_FAKEFAKEFAKEFAKEFAKEFAKEFAKE", "secret_token"],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsig", "secret_token"],
  ["-----BEGIN RSA " + "PRIVATE KEY-----\nFAKEKEYBODY", "secret_token"],
  ["-----BEGIN OPENSSH " + "PRIVATE KEY-----", "secret_token"],
  ["DATABASE_URL=postgres://app:FAKEpass@db.example.com:5432/app", "conn_string"],
  ["mongodb+srv://user:FAKEpass@cluster0.mongodb.net/test", "conn_string"],
  ["redis://default:FAKEpass@cache:6379", "conn_string"],
  ["core banking at 10.20.30.40", "internal_host"],
  ["gateway 192.168.1.10:8080", "internal_host"],
  ["db host 172.16.5.4", "internal_host"],
  ["ssh to build01.corp", "internal_host"],
  ["http://crm.acme.local/login", "internal_host"],
  ["api.internal/v1/customers", "internal_host"],
  ["https://intranet.example.com/hr", "internal_host"],
  ["http://intranet/portal", "internal_host"],
  ["mail.example.corp", "internal_host"],
  ["password: x".normalize("NFD"), "password"],
  ["Mật khẩu: abc@123".normalize("NFD"), "password"],
];

const EMP_BLOCK: Array<[string, string]> = [
  ["Mã NV: XY10234", "staff_id"],
  ["mã nhân viên 004512", "staff_id"],
  ["Mã số nhân viên: NV-2026-17", "staff_id"],
  ["MSNV 88213", "staff_id"],
  ["employee ID E-55821", "staff_id"],
  ["Staff ID #A1023", "staff_id"],
  ["emp id: 7781", "staff_id"],
  ["Anh Nguyễn Văn Bình bị kỷ luật tháng 9", "hr_record"],
  ["Performance review for Ms Lan Pham: below expectations", "hr_record"],
  ["Lương của Chị Trần Thu Hà tăng từ tháng 10", "hr_record"],
  ["Họ tên: Lê Văn Cường — đánh giá hiệu suất: B", "hr_record"],
  ["salary note for Mr Tuan Le", "hr_record"],
  ["Disciplinary action against Mr John Smith", "hr_record"],
  ["Mã NV: XY10234".normalize("NFD"), "staff_id"],
  ["Anh Nguyễn Văn Bình bị kỷ luật".normalize("NFD"), "hr_record"],
];

const FIN_BLOCK: Array<[string, string]> = [
  ["Budget 150000000 VND", "budget_amount"],
  ["Ngân sách Q4: 2 tỷ", "budget_amount"],
  ["ngân sách 500 triệu cho kênh Facebook", "budget_amount"],
  ["Q4 budget is $50k for paid social", "budget_amount"],
  ["Chi phí dự kiến 120tr", "budget_amount"],
  ["Total 1.500.000.000đ budget approved", "budget_amount"],
  ["budget USD 20,000", "budget_amount"],
  ["Chỉ tiêu dư nợ 300 tỷ năm 2026", "target_amount"],
  ["Target: 5bn VND disbursement", "target_amount"],
  ["KPI doanh số 2 tỷ/tháng", "target_amount"],
  ["Dư nợ SME đạt 1200 tỷ", "target_amount"],
  ["KPI: CPC 12000đ", "target_amount"],
  ["Lãi suất 7.2% cho gói SME mới", "rate_unpublished"],
  ["interest rate 6,8 % for the pilot", "rate_unpublished"],
  ["Lãi suất ưu đãi chưa công bố 5.5%", "rate_unpublished"],
  ["non-public interest rate 6%", "rate_unpublished"],
  ["Ngân sách Q4: 2 tỷ".normalize("NFD"), "budget_amount"],
];

// Must pass every rule (credential, PII, employee, financials, contract).
const PASS_35: string[] = [
  // §13.5 must-pass examples
  "SME campaign brief: awareness -> lead form -> RM call, Facebook + Zalo, launch November",
  "Funnel stages: awareness, consideration, application, disbursement",
  "KPI: CTR, CPC",
  "CTR 2.4%",
  "lãi suất 6.5% (công bố)",
  "Interest rate 6.5% as published on example.com",
  "Lãi suất niêm yết 6.1%/năm",
  "Khách hàng SME trong phân khúc doanh nghiệp siêu nhỏ cần vốn lưu động",
  "SME segment: micro businesses with revenue under the SME threshold",
  "use the password manager",
  "Reset your password via the portal",
  "API key rotation is due",
  "Tokens start with agency-board_claude_ and are shown once",
  "dev server on localhost:13100",
  "http://localhost:3000/dashboard",
  "127.0.0.1:54321 is the local Supabase",
  "https://www.example.com/khach-hang-doanh-nghiep",
  "https://example.com/blog/post-1",
  "salary benchmarks in the market report",
  "team review on Friday",
  "Performance review cycle starts in December",
  "Mã NV format is letters then digits",
  "employee ID rotation policy",
  "Target audience: SME owners aged 30-45",
  "Target 1000 leads per week",
  "Điều chỉnh ngân sách",
  "Budget review meeting moved to Monday",
  "Chỉ tiêu tăng trưởng sẽ được chốt sau",
  "CTR 3.5%, CPC 12000đ, 45000 clicks",
  "version 1.2.3.4",
  "The risk-based approach",
  "Acme Corp. annual event",
  "Launch 2026-10-07, review 31/12/2026",
  "Lãi suất là yếu tố quan trọng",
];

describe("credentialRule — must block", () => {
  it.each(CRED_BLOCK)("%s -> %s", (text, rule) => {
    expect(credentialRule(text)).toBe(rule);
  });
});

describe("employeeRule — must block", () => {
  it.each(EMP_BLOCK)("%s -> %s", (text, rule) => {
    expect(employeeRule(text)).toBe(rule);
  });
});

describe("financialRule — must block", () => {
  it.each(FIN_BLOCK)("%s -> %s", (text, rule) => {
    expect(financialRule(text)).toBe(rule);
  });
});

describe("classes 3-5 — must pass", () => {
  it.each([...PASS_35, ...PASS])("%s", (text) => {
    expect(credentialRule(text)).toBeNull();
    expect(employeeRule(text)).toBeNull();
    expect(financialRule(text)).toBeNull();
    expect(piiRule(text)).toBeNull();
    expect(contractRule(text)).toBeNull();
  });
  it("null / undefined / empty pass", () => {
    for (const t of [null, undefined, ""]) {
      expect(credentialRule(t)).toBeNull();
      expect(employeeRule(t)).toBeNull();
      expect(financialRule(t)).toBeNull();
    }
  });
  it("amountRe finds money/magnitude amounts only", () => {
    const hits = (t: string) => [...t.matchAll(amountRe())].length;
    expect(hits("2 tỷ, 500 triệu, $50k, 150000000, 1.500.000.000đ")).toBeGreaterThanOrEqual(5);
    expect(hits("CTR 2.4%, 45 clicks, Q4 2026, 5 min")).toBe(0);
  });
});

describe("piiRule — must block", () => {
  it.each(PII_BLOCK)("%s -> %s", (text, rule) => {
    expect(piiRule(text)).toBe(rule);
  });
});

describe("contractRule — must block", () => {
  it.each(CONTRACT_BLOCK)("%s -> %s", (text, rule) => {
    expect(contractRule(text)).toBe(rule);
    expect(piiRule(text)).toBeNull(); // contract fixtures carry no PII
  });
});

describe("piiRule + contractRule — must pass", () => {
  it.each(PASS)("%s", (text) => {
    expect(piiRule(text)).toBeNull();
    expect(contractRule(text)).toBeNull();
  });
  it("null / undefined / empty pass", () => {
    for (const t of [null, undefined, ""]) {
      expect(piiRule(t)).toBeNull();
      expect(contractRule(t)).toBeNull();
    }
  });
});

function catchErr(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected throw");
}

const PII_MSG = "Customer personal information must not be stored. Remove it and save only the non-personal facts.";
const CONTRACT_MSG =
  "confidential contract content must be saved with confidential=true in project/confidential (needs a grant).";

// Gates for the existing tier tests: confidential context (project/confidential) without / with the contract allowance.
const SB = { ok: false, ns: "project/confidential" };
const SB_OK = { ok: true, ns: "project/confidential" };

describe("assertConfidentialTiers", () => {
  const contract = "Hợp đồng số 12/2026/HĐ-XY";
  const pii = "Họ tên: Nguyễn Văn An, SĐT 0912345678";

  it("passes general client text either way", () => {
    expect(() => assertConfidentialTiers(SB, "Acme SME campaign brief Q4", null, undefined)).not.toThrow();
    expect(() => assertConfidentialTiers(SB_OK, ...PASS)).not.toThrow();
    expect(() => assertConfidentialTiers(SB, ...PASS)).not.toThrow();
  });

  it("contract blocked when !contractOk, allowed when contractOk", () => {
    const e = catchErr(() => assertConfidentialTiers(SB, "title", contract));
    expect([e.status, e.code, e.message, e.details]).toEqual([422, "CONFIDENTIAL", CONTRACT_MSG, { rule: "contract_no_vi" }]);
    expect(() => assertConfidentialTiers(SB_OK, "title", contract)).not.toThrow();
  });

  it("PII blocked even when contractOk", () => {
    const e = catchErr(() => assertConfidentialTiers(SB_OK, pii));
    expect([e.status, e.code, e.message, e.details]).toEqual([422, "CUSTOMER_PII_BLOCKED", PII_MSG, { rule: "phone" }]);
  });

  it("PII wins over contract, across all texts (PII in a later text, contract in an earlier one)", () => {
    for (const ok of [true, false]) {
      expect(catchErr(() => assertConfidentialTiers({ ok, ns: SB.ns }, contract, pii)).code).toBe("CUSTOMER_PII_BLOCKED");
      expect(catchErr(() => assertConfidentialTiers({ ok, ns: SB.ns }, `${contract}\n${pii}`)).code).toBe("CUSTOMER_PII_BLOCKED");
    }
  });

  it("error message and details never contain the input", () => {
    const inputs = [...PII_BLOCK.map(([t]) => t), ...CONTRACT_BLOCK.map(([t]) => t)];
    for (const text of inputs) {
      const e = catchErr(() => assertConfidentialTiers(SB, text));
      const blob = `${e.message} ${JSON.stringify(e.details)}`;
      expect(blob.includes(text)).toBe(false);
      for (const tok of text.normalize("NFC").split(/\s+/).filter((w) => /\d{4,}/.test(w) || /[^\x00-\x7f]/.test(w))) {
        expect(blob.includes(tok)).toBe(false);
      }
      expect(Object.keys(e.details as object)).toEqual(["rule"]);
    }
  });
});

describe("assertConfidentialTiers — classes 3-5", () => {
  const cred = "password: Hunter2!";
  const cust = "SĐT 0912345678";
  const emp = "Mã NV: XY10234";
  const fin = "Ngân sách Q4: 2 tỷ";
  const contract = "Hợp đồng số 12/2026/HĐ-XY";

  it.each([
    ...CRED_BLOCK.map(([t, r]) => [t, "CREDENTIALS_BLOCKED", r] as const),
    ...EMP_BLOCK.map(([t, r]) => [t, "EMPLOYEE_PII_BLOCKED", r] as const),
    ...FIN_BLOCK.map(([t, r]) => [t, "FINANCIALS_BLOCKED", r] as const),
  ])("%s -> %s {rule: %s}, even when contractOk", (text, code, rule) => {
    for (const ok of [true, false]) {
      const e = catchErr(() => assertConfidentialTiers({ ok, ns: SB.ns }, "title", text));
      expect([e.status, e.code, e.message, e.details]).toEqual([422, code, TIER_MESSAGES[code], { rule }]);
    }
  });

  it("order across all texts: credentials > customer PII > employee PII > financials > contract", () => {
    const code = (...t: string[]) => catchErr(() => assertConfidentialTiers(SB, ...t)).code;
    expect(code(contract, fin, emp, cust, cred)).toBe("CREDENTIALS_BLOCKED");
    expect(code(`${cust} ${cred}`)).toBe("CREDENTIALS_BLOCKED");
    expect(code(contract, fin, emp, cust)).toBe("CUSTOMER_PII_BLOCKED");
    expect(code(`${emp} ${cust}`)).toBe("CUSTOMER_PII_BLOCKED");
    expect(code(contract, fin, emp)).toBe("EMPLOYEE_PII_BLOCKED");
    expect(code(`${fin} ${emp}`)).toBe("EMPLOYEE_PII_BLOCKED");
    expect(code(contract, fin)).toBe("FINANCIALS_BLOCKED");
    expect(code(`${contract} ${fin}`)).toBe("FINANCIALS_BLOCKED");
    expect(code(contract)).toBe("CONFIDENTIAL");
    // contractOk only lifts the contract tier
    expect(catchErr(() => assertConfidentialTiers(SB_OK, contract, fin)).code).toBe("FINANCIALS_BLOCKED");
    expect(() => assertConfidentialTiers(SB_OK, contract)).not.toThrow();
  });

  it("a name in an HR record is employee PII; a name alone stays customer PII", () => {
    const e = catchErr(() => assertConfidentialTiers(SB_OK, "Anh Nguyễn Văn Bình bị kỷ luật tháng 9"));
    expect([e.code, e.details]).toEqual(["EMPLOYEE_PII_BLOCKED", { rule: "hr_record" }]);
    expect(catchErr(() => assertConfidentialTiers(SB_OK, "Anh Nguyễn Văn Bình")).code).toBe("CUSTOMER_PII_BLOCKED");
    // a hard customer identifier next to HR words is still customer PII
    expect(catchErr(() => assertConfidentialTiers(SB_OK, "lương Anh Nguyễn Văn Bình, SĐT 0912345678")).code).toBe("CUSTOMER_PII_BLOCKED");
  });

  it("passes every must-pass text", () => {
    expect(() => assertConfidentialTiers(SB, ...PASS_35)).not.toThrow();
  });

  it("error message and details never contain the input", () => {
    for (const text of [...CRED_BLOCK, ...EMP_BLOCK, ...FIN_BLOCK].map(([t]) => t)) {
      const e = catchErr(() => assertConfidentialTiers(SB, text));
      const blob = `${e.message} ${JSON.stringify(e.details)}`;
      expect(blob.includes(text)).toBe(false);
      for (const tok of text.normalize("NFC").split(/\s+/).filter((w) => /\d{3,}/.test(w) || /[^\x00-\x7f]/.test(w) || w.length >= 12)) {
        expect(blob.includes(tok)).toBe(false);
      }
      expect(Object.keys(e.details as object)).toEqual(["rule"]);
    }
  });
});

// §13.2 (migration 0005): contract wording is blocked ONLY in confidential context, and only without the allowance.
describe("confidentialContext + contract tier scope (confidential-only)", () => {
  const contract = "Hợp đồng số 12/2026/HĐ-TS giữa Bên A và Bên B";
  const enContract = "Contract No. TS-2026-014: agreement between the parties for website build";

  it("namespace: project slug starting with confidential (case-insensitive), anything else is not confidential by namespace", () => {
    for (const ns of ["project/confidential", "project/confidential/sme", "project/confidential-x", "project/Confidential-x/y", "PROJECT/confidential"]) {
      expect(confidentialContext(ns, [])).toBe(true);
    }
    for (const ns of ["project/x", "project/acme", "project/myconfidential", "shared", "global", "agent/claude", null, undefined]) {
      expect(confidentialContext(ns, [])).toBe(false);
    }
  });

  it("marker in any text: the word confidential (any case, also inside longer words)", () => {
    for (const t of [
      "brief for CONFIDENTIAL SME", "confidential onboarding", "Strictly Confidential", "see https://example.com/confidential/sme",
      "confidentiality terms", "Tài liệu Confidential",
    ]) {
      expect(confidentialContext(null, ["unrelated", t])).toBe(true);
    }
    for (const t of ["unrelated client", "Vietcombank", "ngân hàng", "confident ial", "con fidential", null, undefined, ""]) {
      expect(confidentialContext("project/x", [t])).toBe(false);
    }
  });

  it("non-confidential contract in project/x, project/acme, shared -> allowed (not confidential context)", () => {
    for (const ns of ["project/x", "project/acme", "shared"]) {
      expect(() => assertConfidentialTiers({ ok: false, ns }, ns, "an unrelated client contract", contract)).not.toThrow();
      expect(() => assertConfidentialTiers({ ok: false, ns }, enContract)).not.toThrow();
    }
  });

  it("confidential contract by namespace (project/confidential*) -> 422 CONFIDENTIAL outside the allowance", () => {
    for (const ns of ["project/confidential", "project/confidential/sme", "project/confidential-x"]) {
      const e = catchErr(() => assertConfidentialTiers({ ok: false, ns }, contract));
      expect([e.status, e.code, e.message, e.details]).toEqual([422, "CONFIDENTIAL", CONTRACT_MSG, { rule: "contract_no_vi" }]);
    }
  });

  it("confidential contract by marker in project/x -> 422 (marker in the same text, another text, or gate.context)", () => {
    const g = { ok: false, ns: "project/x" };
    expect(catchErr(() => assertConfidentialTiers(g, `${contract} với Confidential`)).code).toBe("CONFIDENTIAL");
    expect(catchErr(() => assertConfidentialTiers(g, "Confidential memo", contract)).code).toBe("CONFIDENTIAL");
    expect(catchErr(() => assertConfidentialTiers({ ...g, context: ["Confidential SME deal"] }, contract)).code).toBe("CONFIDENTIAL");
    // context texts are marker-only: PII in context is not checked here (it was checked when that text was written)
    expect(() => assertConfidentialTiers({ ...g, context: ["SĐT 0912345678"] }, "clean")).not.toThrow();
  });

  it("no namespace (heartbeat, machine/project names, reassign target, approval without task): blocks only with a marker", () => {
    expect(() => assertConfidentialTiers({ ok: false }, null, `drafting ${contract}`)).not.toThrow();
    const e = catchErr(() => assertConfidentialTiers({ ok: false }, null, `drafting ${contract} for a confidential client`));
    expect([e.code, e.details]).toEqual(["CONFIDENTIAL", { rule: "contract_no_vi" }]);
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("12/2026");
  });

  it("granted confidential (ok) still allows confidential contracts; other classes stay blocked everywhere", () => {
    expect(() => assertConfidentialTiers(SB_OK, `${contract} confidential`)).not.toThrow();
    for (const ns of ["project/x", "project/confidential"]) {
      for (const ok of [true, false]) {
        expect(catchErr(() => assertConfidentialTiers({ ok, ns }, contract, "SĐT 0912345678")).code).toBe("CUSTOMER_PII_BLOCKED");
        expect(catchErr(() => assertConfidentialTiers({ ok, ns }, contract, "Mã NV: XY10234")).code).toBe("EMPLOYEE_PII_BLOCKED");
        expect(catchErr(() => assertConfidentialTiers({ ok, ns }, contract, "Ngân sách Q4: 2 tỷ")).code).toBe("FINANCIALS_BLOCKED");
        expect(catchErr(() => assertConfidentialTiers({ ok, ns }, contract, "password: Hunter2!")).code).toBe("CREDENTIALS_BLOCKED");
      }
    }
  });
});

describe("tierHit", () => {
  it("maps ApiErrors and DB trigger prefixes for all 5 codes, keeping only a clean rule id", () => {
    expect(TIER_CODES).toHaveLength(5);
    for (const c of TIER_CODES) {
      expect(tierHit(new ApiError(422, c, TIER_MESSAGES[c], { rule: "abc" }))).toEqual({ code: c, rule: "abc" });
      expect(tierHit({ code: "P0001", message: `${c}:abc` })).toEqual({ code: c, rule: "abc" });
      expect(tierHit({ code: "P0001", message: `${c}:0912345678 Nguyễn` })).toEqual({ code: c, rule: undefined });
    }
    expect(tierHit(new Error("boom"))).toBeNull();
    expect(tierHit(null)).toBeNull();
  });
});

describe("contractOk", () => {
  const conf = [CONFIDENTIAL_SLUG, "other"];
  const granted = { grants: [CONFIDENTIAL_SLUG], confidential: conf };
  const ungranted = { grants: ["other"], confidential: conf };
  it("true only in project/confidential with the grant", () => {
    expect(contractOk(granted, "project/confidential")).toBe(true);
    expect(contractOk(granted, "project/confidential/deals")).toBe(true);
    expect(contractOk(ungranted, "project/confidential")).toBe(false);
    expect(contractOk(granted, "project/acme")).toBe(false);
    expect(contractOk(granted, "project/other")).toBe(false);
    expect(contractOk(granted, "global")).toBe(false);
    expect(contractOk(granted, null)).toBe(false);
    // slug not registered as confidential -> not ok even with a stray grant
    expect(contractOk({ grants: [CONFIDENTIAL_SLUG], confidential: [] }, "project/confidential")).toBe(false);
  });
});

// Every error mapper covers all 5 tier codes (ApiError + DB trigger prefix), 422, rule id only, never content.
describe("error mappers cover all 5 tier codes", () => {
  const leak = "0912345678 Nguyễn Văn An password: hunter2";
  const cases = (c: (typeof TIER_CODES)[number]) => [
    new ApiError(422, c, TIER_MESSAGES[c], { rule: "abc" }),
    { code: "P0001", message: `${c}:abc` },
  ];
  it("errorResponse (lib/request.ts)", async () => {
    const { errorResponse } = await import("../lib/request");
    for (const c of TIER_CODES) {
      for (const e of [...cases(c), { code: "P0001", message: `${c}:${leak}` }]) {
        const res = errorResponse(e);
        const body = (await res.json()) as { error: { code: string; message: string; details: { rule: string } } };
        expect(res.status).toBe(422);
        expect(body.error.code).toBe(c);
        expect(body.error.message).toBe(TIER_MESSAGES[c]);
        expect(JSON.stringify(body).includes("0912345678")).toBe(false);
        expect(JSON.stringify(body).includes("hunter2")).toBe(false);
      }
    }
  });
  it("dashboard readableError (board, memory) and actionErrorMessage (access)", async () => {
    const board = await import("../lib/dash/board");
    const mem = await import("../lib/dash/memory");
    const access = await import("../lib/dash/access");
    for (const c of TIER_CODES) {
      for (const e of [...cases(c), { code: "P0001", message: `${c}:${leak}` }]) {
        const b = board.readableError(e);
        const a = access.actionErrorMessage(e);
        const m = mem.readableError(e);
        expect([b.status, a.status]).toEqual([422, 422]);
        for (const msg of [b.message, a.message, m]) {
          expect(msg).toContain(TIER_MESSAGES[c]);
          expect(msg.includes("0912345678") || msg.includes("hunter2") || msg.includes("Nguyễn")).toBe(false);
        }
      }
    }
  });
});
