// scripts/migrate.mjs: the build-time migration runner behind `prebuild` (in-app Update button).
// Local stack only: every DB test runs against a THROWAWAY database (CREATE DATABASE migtest_<rand>, force-dropped in
// afterAll) on the local Postgres, with fixture migration dirs under a temp dir. Fake passwords only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { isLocalUrl } from "./db-guard";

// `pg` ships no types and the script is plain .mjs: load both untyped (a variable specifier keeps tsc out of it).
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const SCRIPT = join(process.cwd(), "scripts", "migrate.mjs");
const REAL_DIR = join(process.cwd(), "supabase", "migrations");
const BUNDLED_CA = join(process.cwd(), "scripts", "certs", "supabase-ca.pem");

type Result = { exitCode: number; applied: number; skipped?: string; failed?: string };
type Mod = {
  runMigrations(o: Record<string, unknown>): Promise<Result>;
  buildConnectionConfig(dbUrl: string, env: Record<string, string | undefined>, bundledCaPath?: string): Record<string, any>;
  loadBundledCa(path?: string): string;
};
async function load(): Promise<Mod> { return (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Mod; }

// Same probe style as tests/global-setup.ts; SUPABASE_DB_URL wins when set.
function probeDbUrl(): string {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const attempts: [string, string[]][] = [["supabase", ["status", "-o", "env"]], ["npx", ["--no-install", "supabase", "status", "-o", "env"]]];
  let last: unknown;
  for (const [cmd, args] of attempts) {
    try {
      const url = parseEnv(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 })).DB_URL;
      if (url) return url;
    } catch (e) { last = e; }
  }
  throw new Error(`\`supabase status\` failed: ${(last as Error)?.message?.split("\n")[0] ?? last}`);
}

function withDb(adminUrl: string, db: string): string { const u = new URL(adminUrl); u.pathname = `/${db}`; return u.toString(); }

let adminUrl = "";
let dbName = "";
let dbUrl = "";
let tmp = "";
let seq = 0;

/** Fresh fixture dir: files = { "20300101000001_a.sql": "sql..." }. */
function fixture(files: Record<string, string>): string {
  const dir = join(tmp, `fx${++seq}`);
  mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function capture() {
  const lines: string[] = [];
  const log = (m: unknown) => { lines.push(String(m)); };
  return { lines, log, logError: log };
}

async function query(sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try { return (await c.query(sql, params)).rows as any[]; } finally { await c.end(); }
}

/** Empty the throwaway DB between tests so each starts from nothing. */
async function resetDb() {
  await query("drop schema if exists supabase_migrations cascade; drop schema public cascade; create schema public;");
}

beforeAll(async () => {
  adminUrl = probeDbUrl();
  // Local stack only, same rule as tests/db-guard.ts (this DB URL is a postgresql:// one, so check the host directly).
  if (!isLocalUrl(adminUrl.replace(/^postgres(ql)?:/, "http:"))) throw new Error("migrate-script tests only run against the local database");
  tmp = mkdtempSync(join(tmpdir(), "migrate-script-"));
  dbName = `migtest_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`create database ${dbName}`); } finally { await admin.end(); }
  dbUrl = withDb(adminUrl, dbName);
});

afterAll(async () => {
  if (dbName) {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try { await admin.query(`drop database if exists ${dbName} with (force)`); } finally { await admin.end(); }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("skip rules", () => {
  it("skips when AGENCY_BOARD_DB_URL is unset: log line, exit 0, no connection attempted", async () => {
    const { runMigrations } = await load();
    const out = capture();
    const createClient = () => { throw new Error("must not connect"); };
    const r = await runMigrations({ env: {}, dir: fixture({}), createClient, ...out });
    expect(r.exitCode).toBe(0);
    expect(r.applied).toBe(0);
    expect(out.lines).toEqual(["migrate: AGENCY_BOARD_DB_URL not set, skipping"]);
  });

  it("skips on VERCEL_ENV=preview and says why, no connection attempted", async () => {
    const { runMigrations } = await load();
    const out = capture();
    const createClient = () => { throw new Error("must not connect"); };
    const env = { AGENCY_BOARD_DB_URL: dbUrl, VERCEL_ENV: "preview" };
    const r = await runMigrations({ env, dir: fixture({ "20300101000001_a.sql": "select 1;" }), createClient, ...out });
    expect(r.exitCode).toBe(0);
    expect(out.lines.join("\n")).toMatch(/migrate: skipping.*VERCEL_ENV=preview/);
    expect(out.lines.join("\n")).not.toContain(dbUrl);
  });

  it("also skips on VERCEL_ENV=development", async () => {
    const { runMigrations } = await load();
    const r = await runMigrations({ env: { AGENCY_BOARD_DB_URL: dbUrl, VERCEL_ENV: "development" }, dir: fixture({}), createClient: () => { throw new Error("no"); }, ...capture() });
    expect(r.exitCode).toBe(0);
    expect(r.skipped).toBeTruthy();
  });

  it("runs when VERCEL_ENV=production", async () => {
    await resetDb();
    const { runMigrations } = await load();
    const dir = fixture({ "20300101000001_a.sql": "create table public.p_t(id int);" });
    const r = await runMigrations({ env: { AGENCY_BOARD_DB_URL: dbUrl, VERCEL_ENV: "production" }, dir, ...capture() });
    expect(r).toMatchObject({ exitCode: 0, applied: 1 });
  });

  it("CLI: unset DB URL prints the skip line and exits 0", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.AGENCY_BOARD_DB_URL;
    delete env.VERCEL_ENV;
    const p = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    expect(p.status).toBe(0);
    expect(p.stdout.trim()).toBe("migrate: AGENCY_BOARD_DB_URL not set, skipping");
  });

  it("CLI: VERCEL_ENV=preview skips without touching the (unreachable) DB", () => {
    const env = { ...process.env, AGENCY_BOARD_DB_URL: "postgresql://postgres:FAKEpw-preview-123@127.0.0.1:1/postgres", VERCEL_ENV: "preview" };
    const p = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(/skipping/);
    expect(p.stdout + p.stderr).not.toContain("FAKEpw-preview-123");
  });
});

describe("applying migrations", () => {
  it("applies pending migrations in filename order and records them like the Supabase CLI", async () => {
    await resetDb();
    const { runMigrations } = await load();
    const dir = fixture({
      "20300101000003_third.sql": "insert into public.mig_order(n) values (3);",
      "20300101000001_first.sql": "create table public.mig_order(n int);\ninsert into public.mig_order(n) values (1);",
      "20300101000002_second.sql": "insert into public.mig_order(n) values (2);",
      "README.md": "not a migration",
      "notes.sql": "this file has no version prefix and must be ignored",
    });
    const out = capture();
    const r = await runMigrations({ dbUrl, dir, env: {}, ...out });
    expect(r).toMatchObject({ exitCode: 0, applied: 3 });
    expect(out.lines.join("\n")).toMatch(/applied 3 migration/);
    expect((await query("select n from public.mig_order order by ctid")).map((x) => x.n)).toEqual([1, 2, 3]);
    const rows = await query("select version, name, statements from supabase_migrations.schema_migrations order by version");
    expect(rows.map((x) => [x.version, x.name])).toEqual([
      ["20300101000001", "first"],
      ["20300101000002", "second"],
      ["20300101000003", "third"],
    ]);
    expect(rows[0].statements.join("\n")).toContain("create table public.mig_order");
    const cols = await query("select column_name, data_type from information_schema.columns where table_schema='supabase_migrations' and table_name='schema_migrations' order by ordinal_position");
    expect(cols.map((c) => `${c.column_name}:${c.data_type}`)).toEqual(["version:text", "statements:ARRAY", "name:text"]);
    const pk = await query("select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='supabase_migrations.schema_migrations'::regclass and i.indisprimary");
    expect(pk.map((x) => x.attname)).toEqual(["version"]);
  });

  it("is idempotent: a second run applies 0", async () => {
    await resetDb();
    const { runMigrations } = await load();
    const dir = fixture({ "20300101000001_a.sql": "create table public.idem_t(id int);", "20300101000002_b.sql": "alter table public.idem_t add column x int;" });
    expect(await runMigrations({ dbUrl, dir, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 2 });
    const out = capture();
    expect(await runMigrations({ dbUrl, dir, env: {}, ...out })).toMatchObject({ exitCode: 0, applied: 0 });
    expect(out.lines.join("\n")).toMatch(/up to date|0 migration|nothing to apply/i);
    expect(await query("select count(*)::int as n from supabase_migrations.schema_migrations")).toEqual([{ n: 2 }]);
  });

  it("respects rows pre-seeded the way the Supabase CLI writes them (not re-run), applies only newer ones", async () => {
    await resetDb();
    await query("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);");
    await query("insert into supabase_migrations.schema_migrations(version, statements, name) values ('20300101000001', array['create table public.cli_t(id int)'], 'cli_made')");
    await query("create table public.cli_t(id int)");
    const { runMigrations } = await load();
    // 0001 would fail if re-run (table exists, no IF NOT EXISTS): it must be skipped on the strength of the seeded row.
    const dir = fixture({ "20300101000001_cli_made.sql": "create table public.cli_t(id int);", "20300101000002_new.sql": "alter table public.cli_t add column y int;" });
    const out = capture();
    expect(await runMigrations({ dbUrl, dir, env: {}, ...out })).toMatchObject({ exitCode: 0, applied: 1 });
    expect((await query("select version from supabase_migrations.schema_migrations order by 1")).map((x) => x.version)).toEqual(["20300101000001", "20300101000002"]);
    expect((await query("select column_name from information_schema.columns where table_name='cli_t' order by 1")).map((x) => x.column_name)).toEqual(["id", "y"]);
  });

  it("accepts additive IF NOT EXISTS migrations on top of existing objects", async () => {
    await resetDb();
    await query("create table public.add_t(id int)");
    const { runMigrations } = await load();
    const dir = fixture({
      "20300101000001_add.sql": "create table if not exists public.add_t(id int);\nalter table public.add_t add column if not exists note text;\ncreate index if not exists add_t_note on public.add_t(note);",
    });
    expect(await runMigrations({ dbUrl, dir, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 1 });
    expect(await runMigrations({ dbUrl, dir, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 0 });
  });

  it("a failing migration rolls back only itself; earlier ones stay, later ones do not run, exit non-zero", async () => {
    await resetDb();
    const { runMigrations } = await load();
    const dir = fixture({
      "20300101000001_ok.sql": "create table public.f_ok(id int);",
      "20300101000002_bad.sql": "create table public.f_half(id int);\ninsert into public.f_ok(nope) values (1);",
      "20300101000003_never.sql": "create table public.f_never(id int);",
    });
    const out = capture();
    const r = await runMigrations({ dbUrl, dir, env: {}, ...out });
    expect(r.exitCode).toBe(1);
    expect(r.failed).toBe("20300101000002_bad.sql");
    expect(out.lines.join("\n")).toMatch(/^migrate: FAILED 20300101000002_bad\.sql: .*nope/m);
    expect((await query("select version from supabase_migrations.schema_migrations order by 1")).map((x) => x.version)).toEqual(["20300101000001"]);
    expect((await query("select to_regclass('public.f_ok') as a, to_regclass('public.f_half') as b, to_regclass('public.f_never') as c"))[0]).toEqual({ a: "f_ok", b: null, c: null });
    // Fixing the bad one lets a rerun finish what is left.
    writeFileSync(join(dir, "20300101000002_bad.sql"), "create table public.f_half(id int);");
    expect(await runMigrations({ dbUrl, dir, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 2 });
  });

  it("serialises concurrent runs with the advisory lock: each migration applied exactly once", async () => {
    await resetDb();
    const { runMigrations } = await load();
    // No IF NOT EXISTS and a pg_sleep so the runs would collide (error) without the lock.
    const dir = fixture({
      "20300101000001_a.sql": "create table public.conc_a(id int);\nselect pg_sleep(0.4);",
      "20300101000002_b.sql": "create table public.conc_b(id int);\nselect pg_sleep(0.4);",
    });
    const [r1, r2] = await Promise.all([
      runMigrations({ dbUrl, dir, env: {}, ...capture() }),
      runMigrations({ dbUrl, dir, env: {}, ...capture() }),
    ]);
    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(r1.applied + r2.applied).toBe(2);
    expect(await query("select count(*)::int as n from supabase_migrations.schema_migrations")).toEqual([{ n: 2 }]);
  });

  it("releases the advisory lock when it finishes (a failed run does not wedge the next one)", async () => {
    await resetDb();
    const { runMigrations } = await load();
    const bad = fixture({ "20300101000001_bad.sql": "select nope_does_not_exist();" });
    expect((await runMigrations({ dbUrl, dir: bad, env: {}, ...capture() })).exitCode).toBe(1);
    const good = fixture({ "20300101000001_good.sql": "select 1;" });
    expect(await runMigrations({ dbUrl, dir: good, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 1 });
  });
});

describe("never leaks the DB URL or password", () => {
  const PW = "FAKEpw-Sup3r-Secret-9";

  it("connection failure (closed port): FAILED line, exit 1, no password or URL anywhere", async () => {
    const { runMigrations } = await load();
    const url = `postgresql://postgres:${PW}@127.0.0.1:1/postgres`;
    const out = capture();
    const r = await runMigrations({ dbUrl: url, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    expect(r.exitCode).toBe(1);
    const all = out.lines.join("\n");
    expect(all).toMatch(/^migrate: FAILED/m);
    expect(all).not.toContain(PW);
    expect(all).not.toContain(url);
    expect(all).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("unresolvable host: no password or URL in output", async () => {
    const { runMigrations } = await load();
    const url = `postgresql://postgres.abcdefgh:${PW}@db.invalid-host-for-test.invalid:5432/postgres`;
    const out = capture();
    const r = await runMigrations({ dbUrl: url, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    expect(r.exitCode).toBe(1);
    expect(out.lines.join("\n")).not.toContain(PW);
  });

  it("unresolvable host: the host (Supabase project ref) is not written to the log either", async () => {
    const { runMigrations } = await load();
    const host = "db.abcdefghijklmnopqrst.invalid";
    const url = `postgresql://postgres:${PW}@${host}:5432/postgres`;
    const out = capture();
    const r = await runMigrations({ dbUrl: url, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    expect(r.exitCode).toBe(1);
    const all = out.lines.join("\n");
    expect(all).toMatch(/^migrate: FAILED/m);
    expect(all).not.toContain(host);
  });

  it("scrubs the host from a driver error that echoes it (ENOTFOUND shape)", async () => {
    const { runMigrations } = await load();
    const host = "db.abcdefghijklmnopqrst.supabase.co";
    const url = `postgresql://postgres:${PW}@${host}:5432/postgres`;
    const out = capture();
    const createClient = () => ({
      on() {},
      async connect() { throw new Error(`getaddrinfo ENOTFOUND ${host}`); },
      async query() { return { rows: [] }; },
      async end() {},
    });
    const r = await runMigrations({ dbUrl: url, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, createClient, ...out });
    expect(r.exitCode).toBe(1);
    const all = out.lines.join("\n");
    expect(all).toContain("ENOTFOUND");
    expect(all).not.toContain(host);
  });

  it("scrubs a pooler username (postgres.<project-ref>) raw and decoded, but leaves the plain postgres user alone", async () => {
    const { runMigrations } = await load();
    const run = async (user: string, echoed: string) => {
      const url = `postgresql://${user}:${PW}@aws-0-eu.pooler.example.net:5432/postgres`;
      const out = capture();
      const createClient = () => ({
        on() {},
        async connect() { throw new Error(`password authentication failed for user "${echoed}"`); },
        async query() { return { rows: [] }; },
        async end() {},
      });
      await runMigrations({ dbUrl: url, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, createClient, ...out });
      return out.lines.join("\n");
    };
    const pooled = await run("postgres.abcdefghijklmnopqrst", "postgres.abcdefghijklmnopqrst");
    expect(pooled).toContain("password authentication failed");
    expect(pooled).not.toContain("abcdefghijklmnopqrst");
    const encoded = await run("postgres.ab%2Dcdefghijklmnopqrst", "postgres.ab-cdefghijklmnopqrst");
    expect(encoded).not.toContain("cdefghijklmnopqrst");
    expect(await run("postgres", "postgres")).toContain('user "postgres"');
  });

  it("a malformed URL fails with a generic message that does not echo it", async () => {
    const { runMigrations } = await load();
    const bad = `not a url but has ${PW} in it`;
    const out = capture();
    const r = await runMigrations({ dbUrl: bad, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    expect(r.exitCode).toBe(1);
    expect(out.lines.join("\n")).toMatch(/^migrate: FAILED/m);
    expect(out.lines.join("\n")).not.toContain(PW);
    expect(out.lines.join("\n")).not.toContain(bad);
  });

  it("a wrong scheme is rejected without echoing the URL", async () => {
    const { runMigrations } = await load();
    const bad = `mysql://root:${PW}@127.0.0.1:3306/x`;
    const out = capture();
    const r = await runMigrations({ dbUrl: bad, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    expect(r.exitCode).toBe(1);
    expect(out.lines.join("\n")).not.toContain(PW);
  });

  it("wrong password against the real local server: no password in output", async () => {
    const { runMigrations } = await load();
    const u = new URL(dbUrl);
    u.password = PW;
    const out = capture();
    const r = await runMigrations({ dbUrl: u.toString(), dir: fixture({ "20300101000001_a.sql": "select 1;" }), env: {}, ...out });
    // If this local server is trust-auth the connection succeeds; the leak assertion holds either way.
    if (r.exitCode !== 0) expect(out.lines.join("\n")).toMatch(/^migrate: FAILED/m);
    expect(out.lines.join("\n")).not.toContain(PW);
  });

  it("an error whose text contains the URL and password is scrubbed before logging", async () => {
    await resetDb();
    const { runMigrations } = await load();
    // The SQL itself makes Postgres echo the real URL and password back inside the error message.
    const secretUrl = dbUrl;
    const realPw = new URL(dbUrl).password;
    const dir = fixture({ "20300101000001_leak.sql": `do $$ begin raise exception 'boom % and pw=%', '${secretUrl}', '${realPw}'; end $$;` });
    const out = capture();
    const r = await runMigrations({ dbUrl, dir, env: {}, ...out });
    expect(r.exitCode).toBe(1);
    const all = out.lines.join("\n");
    expect(all).toMatch(/^migrate: FAILED 20300101000001_leak\.sql: boom/m);
    expect(all).not.toContain(secretUrl);
    if (realPw.length >= 4) expect(all).not.toContain(realPw);
  });

  it("CLI against a closed port: stdout and stderr carry neither password nor URL", () => {
    const url = `postgresql://postgres:${PW}@127.0.0.1:1/postgres`;
    const env: NodeJS.ProcessEnv = { ...process.env, AGENCY_BOARD_DB_URL: url };
    delete env.VERCEL_ENV;
    const p = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    expect(p.status).toBe(1);
    expect(p.stdout + p.stderr).toMatch(/migrate: FAILED/);
    expect(p.stdout + p.stderr).not.toContain(PW);
    expect(p.stdout + p.stderr).not.toContain(url);
  });
});

describe("TLS option building (no remote connection is made)", () => {
  it("local hosts get no TLS", async () => {
    const { buildConnectionConfig } = await load();
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const cfg = buildConnectionConfig(`postgresql://u:p@${host}:5432/db`, {});
      expect(cfg.ssl).toBeFalsy();
    }
  });

  const REMOTE = "postgresql://u:p@db.example.com:5432/db";
  const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";

  it("the bundled PEM holds exactly the two Supabase roots, pinned by fingerprint, subject and validity, none expired", () => {
    const text = readFileSync(BUNDLED_CA, "utf8");
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    expect(blocks).toHaveLength(2);
    expect(text.indexOf("-----BEGIN CERTIFICATE-----")).toBeGreaterThan(0); // the leading comment block is ignored by the TLS stack
    expect(text).not.toMatch(/PRIVATE KEY/);
    const [c2021, c2025] = blocks.map((b) => new X509Certificate(b));
    expect(c2021.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
    expect(c2025.fingerprint256).toBe("5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2");
    for (const c of [c2021, c2025]) {
      expect(c.subject).toContain("CN=Supabase Root 2021 CA");
      expect(c.subject).toContain("O=Supabase Inc");
      expect(c.subject).toBe(c.issuer); // self-signed roots
      expect(c.ca).toBe(true);
      expect(new Date(c.validFrom).getTime()).toBeLessThan(Date.now());
      expect(new Date(c.validTo).getTime()).toBeGreaterThan(Date.now());
    }
    expect(new Date(c2021.validFrom).toISOString()).toBe("2021-04-28T10:56:53.000Z");
    expect(new Date(c2021.validTo).toISOString()).toBe("2031-04-26T10:56:53.000Z");
    expect(new Date(c2025.validFrom).toISOString()).toBe("2025-09-03T08:01:25.000Z");
    expect(new Date(c2025.validTo).toISOString()).toBe("2035-09-01T08:01:25.000Z");
    expect(() => tls.createSecureContext({ ca: text })).not.toThrow();
  });

  it("remote host, no override: verified against the bundled Supabase PEM, whole text", async () => {
    const { buildConnectionConfig } = await load();
    const cfg = buildConnectionConfig(REMOTE, {});
    expect(cfg.ssl).toEqual({ ca: readFileSync(BUNDLED_CA, "utf8"), rejectUnauthorized: true });
  });

  it("no URL sslmode value changes the TLS decision for a remote host", async () => {
    const { buildConnectionConfig } = await load();
    const want = buildConnectionConfig(REMOTE, {}).ssl;
    for (const q of ["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"]) {
      const cfg = buildConnectionConfig(`${REMOTE}?sslmode=${q}&ssl=false`, {});
      expect(cfg.ssl).toEqual(want);
      expect(cfg.connectionString).toBeUndefined();
    }
  });

  it("local hosts still get no TLS, with or without an override", async () => {
    const { buildConnectionConfig } = await load();
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(buildConnectionConfig(`postgresql://u:p@${host}:5432/db`, { AGENCY_BOARD_DB_SSL_CA: FAKE_PEM }).ssl).toBeFalsy();
    }
  });

  it("AGENCY_BOARD_DB_SSL_CA replaces the bundle entirely (not additive)", async () => {
    const { buildConnectionConfig } = await load();
    const cfg = buildConnectionConfig(REMOTE, { AGENCY_BOARD_DB_SSL_CA: `  ${FAKE_PEM}\n\n` });
    expect(cfg.ssl).toEqual({ ca: FAKE_PEM, rejectUnauthorized: true });
    expect(cfg.ssl.ca).not.toContain("Supabase");
  });

  it("a whitespace-only override counts as unset", async () => {
    const { buildConnectionConfig } = await load();
    const want = buildConnectionConfig(REMOTE, {}).ssl;
    for (const v of ["", "   ", "\n\t \n"]) expect(buildConnectionConfig(REMOTE, { AGENCY_BOARD_DB_SSL_CA: v }).ssl).toEqual(want);
  });

  it("a one-line override with literal backslash-n sequences is turned into real newlines", async () => {
    const { buildConnectionConfig } = await load();
    const oneLine = FAKE_PEM.replace(/\n/g, "\\n");
    expect(oneLine).not.toContain("\n");
    expect(buildConnectionConfig(REMOTE, { AGENCY_BOARD_DB_SSL_CA: oneLine }).ssl.ca).toBe(FAKE_PEM);
  });

  it("an override that holds no certificate fails closed with a message that names the variable and never echoes it", async () => {
    const { buildConnectionConfig, runMigrations } = await load();
    const garbage = "SECRETISH-not-a-pem-value-12345";
    let msg = "";
    try { buildConnectionConfig(REMOTE, { AGENCY_BOARD_DB_SSL_CA: garbage }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("AGENCY_BOARD_DB_SSL_CA");
    expect(msg).toMatch(/BEGIN CERTIFICATE/);
    expect(msg).not.toContain(garbage);

    const out = capture();
    const createClient = () => { throw new Error("must not connect"); };
    const r = await runMigrations({
      dbUrl: "postgresql://u:pw-FAKE-1@db.example.com:5432/db", dir: fixture({ "20300101000001_a.sql": "select 1;" }),
      env: { AGENCY_BOARD_DB_SSL_CA: garbage }, createClient, ...out,
    });
    expect(r.exitCode).toBe(1);
    expect(r.applied).toBe(0);
    const all = out.lines.join("\n");
    expect(all).toContain("AGENCY_BOARD_DB_SSL_CA");
    expect(all).not.toContain(garbage);
    expect(all).not.toContain("pw-FAKE-1");
  });

  it("a missing, empty or certificate-less bundled file fails closed; there is no unverified fallback", async () => {
    const { buildConnectionConfig, loadBundledCa } = await load();
    const empty = join(tmp, "empty.pem");
    const noCert = join(tmp, "nocert.pem");
    writeFileSync(empty, "");
    writeFileSync(noCert, "# only a comment\n");
    for (const bad of [join(tmp, "does-not-exist.pem"), empty, noCert]) {
      expect(() => loadBundledCa(bad)).toThrow(/bundled/i);
      expect(() => buildConnectionConfig(REMOTE, {}, bad)).toThrow(/bundled/i);
    }
    // the override wins over a broken bundle (the bundle is not read at all)
    expect(buildConnectionConfig(REMOTE, { AGENCY_BOARD_DB_SSL_CA: FAKE_PEM }, join(tmp, "does-not-exist.pem")).ssl.ca).toBe(FAKE_PEM);
    expect(loadBundledCa()).toBe(readFileSync(BUNDLED_CA, "utf8"));
  });

  it("no code path turns verification off: the script never sets rejectUnauthorized to anything but true", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const uses = src.match(/rejectUnauthorized[^\n]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).not.toMatch(/rejectUnauthorized\s*[:=]\s*(false|0|!|env|process)/);
    expect(src).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(src).not.toMatch(/without certificate verification/i);
  });

  it("decodes percent-encoded user, password and database", async () => {
    const { buildConnectionConfig } = await load();
    const cfg = buildConnectionConfig("postgresql://us%40er:p%2Fw%3Ad@db.example.com:6543/my%20db", {});
    expect(cfg).toMatchObject({ user: "us@er", password: "p/w:d", host: "db.example.com", port: 6543, database: "my db" });
  });

  it("an unencoded or encoded '@' in the password parses (userinfo ends at the last '@')", async () => {
    const { buildConnectionConfig } = await load();
    expect(buildConnectionConfig("postgresql://postgres:p%40ss@db.example.com:5432/postgres", {})).toMatchObject({ user: "postgres", password: "p@ss", host: "db.example.com" });
    expect(buildConnectionConfig("postgresql://postgres:p@ss@db.example.com:5432/postgres", {})).toMatchObject({ user: "postgres", password: "p@ss", host: "db.example.com" });
  });

  it("rejects non-postgres schemes and garbage with a generic error", async () => {
    const { buildConnectionConfig } = await load();
    expect(() => buildConnectionConfig("mysql://u:p@h/db", {})).toThrow(/postgresql:\/\//);
    expect(() => buildConnectionConfig("garbage-with-FAKEsecret", {})).toThrow(/not a valid connection URL/);
    try { buildConnectionConfig("garbage-with-FAKEsecret", {}); } catch (e) { expect((e as Error).message).not.toContain("FAKEsecret"); }
  });
});

describe("real repo migrations", () => {
  it("file names match ^\\d{14}_.*\\.sql$ with unique versions", () => {
    const files = readdirSync(REAL_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{14}_.*\.sql$/);
    const versions = files.map((f) => f.slice(0, 14));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("apply cleanly to a fresh database through the runner (supabase image prerequisites created first)", async () => {
    await resetDb();
    // A bare CREATE DATABASE lacks what the supabase image provisions in its `postgres` database: the `extensions`
    // schema the first migration installs into. Roles (anon, authenticated, service_role) are cluster-wide and exist.
    await query("create schema if not exists extensions");
    const { runMigrations } = await load();
    const files = readdirSync(REAL_DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f));
    const out = capture();
    const r = await runMigrations({ dbUrl, dir: REAL_DIR, env: {}, ...out });
    expect(out.lines.join("\n")).not.toMatch(/FAILED/);
    expect(r).toMatchObject({ exitCode: 0, applied: files.length });
    expect(await runMigrations({ dbUrl, dir: REAL_DIR, env: {}, ...capture() })).toMatchObject({ exitCode: 0, applied: 0 });
  });
});

// Real handshakes: node:tls plus the real pg client against a fake Postgres that answers SSLRequest, upgrades to TLS and
// then rejects the startup packet with an auth-class ErrorResponse. A TLS failure therefore surfaces before any auth step,
// and a TLS success surfaces as the auth error. Certificates are generated per run with the openssl CLI in a temp dir.
function opensslOk(): boolean {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS_OPENSSL = opensslOk();
const HOST = "db.example.test";

function openssl(cwd: string, args: string[]) { execFileSync("openssl", args, { cwd, stdio: "ignore" }); }
/** Throwaway CA; returns its cert PEM. */
function makeCa(dir: string, name: string): string {
  openssl(dir, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`,
    "-subj", `/CN=Throwaway ${name}`, "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  return readFileSync(join(dir, `${name}.crt`), "utf8");
}
/** Server cert for `dns` signed by CA `ca`; `window` makes it expired when openssl supports -not_after. */
function makeServerCert(dir: string, ca: string, name: string, dns: string, window?: [string, string]): { key: string; cert: string } {
  openssl(dir, ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${dns}`]);
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=DNS:${dns}\nbasicConstraints=CA:FALSE\n`);
  const args = ["x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-extfile", `${name}.ext`];
  if (window) args.push("-not_before", window[0], "-not_after", window[1]); else args.push("-days", "2");
  openssl(dir, args);
  return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.crt`), "utf8") };
}

function pgError(msg: string): Buffer {
  const body = Buffer.concat([Buffer.from("SFATAL\0"), Buffer.from("VFATAL\0"), Buffer.from("C28000\0"), Buffer.from(`M${msg}\0`), Buffer.from([0])]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

/** Fake Postgres: 'S' to the SSLRequest, TLS upgrade with the given identity, then an auth-class error for the startup packet. */
async function fakePostgres(identity: { key: string; cert: string }): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on("error", () => {});
    raw.once("data", (first: Buffer) => {
      if (first.length !== 8 || first.readInt32BE(4) !== 80877103) { raw.destroy(); return; }
      raw.write("S");
      const secure = new tls.TLSSocket(raw, { isServer: true, key: identity.key, cert: identity.cert });
      secure.on("error", () => {}); // a client that rejects our certificate aborts the handshake: expected
      secure.once("data", () => { secure.end(pgError("fake server: authentication refused")); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

describe.skipIf(!HAS_OPENSSL)("TLS verification, real handshakes against a throwaway CA (openssl CLI on PATH)", () => {
  const DB_URL = `postgresql://hs-user-FAKE:hs-pass-FAKE-9@${HOST}:5432/db`;
  let dir = "";
  let caA = "";
  let caB = "";
  let good: { key: string; cert: string };
  let otherName: { key: string; cert: string };
  let underB: { key: string; cert: string };
  let expired: { key: string; cert: string } | null = null;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-tls-"));
    caA = makeCa(dir, "caA");
    caB = makeCa(dir, "caB");
    good = makeServerCert(dir, "caA", "good", HOST);
    otherName = makeServerCert(dir, "caA", "othername", "other.example.test");
    underB = makeServerCert(dir, "caB", "underb", HOST);
    try { expired = makeServerCert(dir, "caA", "expired", HOST, ["20200101000000Z", "20200102000000Z"]); } catch { expired = null; }
  });
  afterAll(async () => {
    for (const c of closers) await c();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function attempt(identity: { key: string; cert: string }, env: Record<string, string | undefined>) {
    const { runMigrations } = await load();
    const server = await fakePostgres(identity);
    closers.push(server.close);
    const out = capture();
    const createClient = (config: Record<string, any>) =>
      new Client({ ...config, host: "127.0.0.1", port: server.port, ssl: { ...config.ssl, servername: HOST } });
    const r = await runMigrations({ dbUrl: DB_URL, dir: fixture({ "20300101000001_a.sql": "select 1;" }), env, createClient, ...out });
    const all = out.lines.join("\n");
    expect(all).not.toContain("hs-pass-FAKE-9");
    expect(all).not.toContain("hs-user-FAKE");
    expect(all).not.toContain(HOST);
    return { r, all };
  }

  function expectTlsFailure(res: { r: Result; all: string }, anchor: RegExp) {
    expect(res.r).toMatchObject({ exitCode: 1, applied: 0 });
    expect(res.all).toMatch(/^migrate: FAILED connecting to the database: TLS certificate verification failed \([A-Z_]+\)\./m);
    expect(res.all).toMatch(anchor);
    expect(res.all).toContain("AGENCY_BOARD_DB_SSL_CA");
    expect(res.all).toContain("Verification cannot be turned off.");
    expect(res.all).not.toContain("fake server");
  }

  it("default env (bundled Supabase CA) rejects a server certificate from another CA", async () => {
    const res = await attempt(good, {});
    expectTlsFailure(res, /not signed by the bundled Supabase CA/);
    expect(res.all).toContain("migrate: verifying the database certificate against the bundled Supabase CA");
    expect(res.all).not.toMatch(/without certificate verification/);
  });

  it("override = the throwaway CA: TLS verifies, the failure is the auth error, not the TLS message", async () => {
    const res = await attempt(good, { AGENCY_BOARD_DB_SSL_CA: caA });
    expect(res.r).toMatchObject({ exitCode: 1, applied: 0, failed: "connecting to the database" });
    expect(res.all).toContain("fake server: authentication refused");
    expect(res.all).not.toContain("TLS certificate verification failed");
    expect(res.all).toContain("migrate: verifying the database certificate against AGENCY_BOARD_DB_SSL_CA");
  });

  it("a comment block before the first BEGIN line does not stop the CA from working (same shape as the bundled file)", async () => {
    const res = await attempt(good, { AGENCY_BOARD_DB_SSL_CA: `# header comment\n# more text\n${caA}` });
    expect(res.all).toContain("fake server: authentication refused");
    expect(res.all).not.toContain("TLS certificate verification failed");
  });

  it("right CA but a certificate for a different host name: reported as a TLS failure", async () => {
    const res = await attempt(otherName, { AGENCY_BOARD_DB_SSL_CA: caA });
    expectTlsFailure(res, /not signed by the CA in AGENCY_BOARD_DB_SSL_CA, or the host name does not match/);
    expect(res.all).toContain("(ERR_TLS_CERT_ALTNAME_INVALID)");
  });

  it("override CA that did not sign the server certificate: fails closed", async () => {
    const res = await attempt(underB, { AGENCY_BOARD_DB_SSL_CA: caA });
    expectTlsFailure(res, /not signed by the CA in AGENCY_BOARD_DB_SSL_CA/);
  });

  it("an expired server certificate fails closed even under the right CA", async (ctx) => {
    if (!expired) ctx.skip(); // this openssl cannot back-date a certificate (-not_before/-not_after)
    const res = await attempt(expired!, { AGENCY_BOARD_DB_SSL_CA: caA });
    expectTlsFailure(res, /AGENCY_BOARD_DB_SSL_CA/);
    expect(res.all).toContain("(CERT_HAS_EXPIRED)");
  });

  it("the override is not additive: with the bundle replaced by CA-B, a CA-A server is rejected", async () => {
    const res = await attempt(good, { AGENCY_BOARD_DB_SSL_CA: caB });
    expectTlsFailure(res, /not signed by the CA in AGENCY_BOARD_DB_SSL_CA/);
  });
});
