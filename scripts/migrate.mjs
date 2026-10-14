#!/usr/bin/env node
// agency-board build-time migration runner (Node 20+, ESM; only dependency: pg). Wired as `prebuild`, so
// `npm run build` on Vercel applies pending supabase/migrations/*.sql to the production database BEFORE `next build`.
// A failed migration exits 1: the build stops, nothing deploys, and the previous version keeps serving.
//
//   AGENCY_BOARD_DB_URL      Postgres connection string (Supabase: Project Settings > Database > Connection string,
//                            use the direct or session-pooler URL, not the transaction pooler: migrations need a
//                            session for the advisory lock). Unset = this script does nothing.
//   AGENCY_BOARD_DB_SSL_CA   optional PEM of the CA that signed the server certificate. For every non-local host the
//                            server certificate is ALWAYS verified: against Supabase's public root CAs bundled in
//                            scripts/certs/supabase-ca.pem by default, or against this PEM when set (it replaces the
//                            bundle). Needed only for a non-Supabase host or a custom domain. Verification cannot be
//                            turned off by any setting.
//   VERCEL_ENV               set by Vercel. Anything but "production" (preview, development) skips: previews must
//                            never touch the production database. Unset (local, CI) runs.
//
// Bookkeeping is the Supabase CLI's own (supabase_migrations.schema_migrations: version text pk, statements text[],
// name text), so `supabase db push` and this script can be mixed on one database without re-running anything.
// Each pending migration runs in its own transaction together with its bookkeeping row. The DB URL, the password and
// the driver's connection details are never printed: all error text is scrubbed first.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, "..", "supabase", "migrations");
const BUNDLED_CA_PATH = join(HERE, "certs", "supabase-ca.pem");
const CERT_MARKER = "-----BEGIN CERTIFICATE-----";
// Node/OpenSSL error codes that mean "the server certificate was not accepted" (as opposed to refused auth, DNS, timeout...).
const CERT_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const NAME_RE = /^(\d{14})_(.*)\.sql$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// Arbitrary constant; every runner of this script takes the same session-level advisory lock.
const LOCK_KEY = "7295210344";

/** Replace every secret (and any leftover postgres:// URL) in text with ***. */
function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const s of [...secrets].filter((x) => typeof x === "string" && x.length > 0).sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, "***");
}

/**
 * Strings that must never reach a log line for this URL: the URL itself, the password in raw, decoded and encoded form,
 * the host (a Supabase host is db.<project-ref>.supabase.co, and a pg error such as ENOTFOUND echoes it) and a username
 * other than plain "postgres" (pooler usernames are postgres.<project-ref>). Local hosts are not secret and stay readable.
 */
function secretsOf(dbUrl) {
  const secrets = [dbUrl];
  try {
    const u = new URL(dbUrl);
    secrets.push(u.password, safeDecode(u.password), encodeURIComponent(safeDecode(u.password)));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!LOCAL_HOSTS.has(host)) secrets.push(u.hostname, host);
    const user = safeDecode(u.username);
    if (user.length >= 3 && user !== "postgres") secrets.push(u.username, user, encodeURIComponent(user));
  } catch { /* not a URL: the raw string is the only secret we know */ }
  return secrets;
}

function isCertError(e) {
  const code = e?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) && (CERT_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_CERT"));
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * pg client config from the URL, as discrete fields (never `connectionString`): a `?sslmode=` in the URL can then
 * not override the TLS decision below, and pg never holds the whole URL to echo in an error.
 * Throws a generic error (no URL text) when the URL is not usable.
 */
export function buildConnectionConfig(dbUrl, env = process.env, bundledCaPath = BUNDLED_CA_PATH) {
  let u;
  try { u = new URL(dbUrl); } catch { throw new Error("AGENCY_BOARD_DB_URL is not a valid connection URL"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("AGENCY_BOARD_DB_URL must start with postgresql://");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("AGENCY_BOARD_DB_URL has no host");
  const user = safeDecode(u.username);
  const config = {
    host,
    port: u.port ? Number(u.port) : 5432,
    user,
    password: safeDecode(u.password),
    database: safeDecode(u.pathname.replace(/^\//, "")) || user || "postgres",
    application_name: "agency-board-migrate",
    connectionTimeoutMillis: 30_000,
  };
  if (LOCAL_HOSTS.has(host)) return config; // local stack / docker: no TLS
  // Any other host: TLS is always on and the server certificate is always verified (rejectUnauthorized:true). The trust
  // anchor is AGENCY_BOARD_DB_SSL_CA when set (it replaces the bundle), else the Supabase roots bundled in the repo
  // (Supabase's chain is not in Node's trust store). A missing or unusable anchor throws: there is no unverified
  // fallback and no setting that turns verification off, so an on-path attacker cannot terminate TLS and run SQL as the
  // database owner. Not even `?sslmode=` in the URL is read.
  config.ssl = { ca: overrideCa(env) ?? loadBundledCa(bundledCaPath), rejectUnauthorized: true };
  return config;
}

/**
 * The AGENCY_BOARD_DB_SSL_CA override, normalised: trimmed, whitespace-only counts as unset (null), literal two-character
 * "\n" sequences become newlines when the value has no real newline (one-line env values). Throws, without echoing the
 * value, when it holds no certificate: a typo must not silently fall back to another trust anchor.
 */
function overrideCa(env) {
  let ca = env.AGENCY_BOARD_DB_SSL_CA?.trim();
  if (!ca) return null;
  if (!ca.includes("\n") && ca.includes("\\n")) ca = ca.replace(/\\n/g, "\n");
  if (!ca.includes(CERT_MARKER)) throw new Error(`AGENCY_BOARD_DB_SSL_CA does not contain a PEM certificate (expected ${CERT_MARKER}); unset it to use the bundled Supabase CA`);
  return ca;
}

/** The bundled Supabase root CAs (PEM text, comment header included). Throws when unreadable: never falls back to unverified. */
export function loadBundledCa(path = BUNDLED_CA_PATH) {
  let pem;
  try { pem = readFileSync(path, "utf8"); } catch { throw new Error("the bundled Supabase CA certificate file (scripts/certs/supabase-ca.pem) could not be read; restore it from the repository"); }
  if (!pem.includes(CERT_MARKER)) throw new Error("the bundled Supabase CA certificate file (scripts/certs/supabase-ca.pem) contains no certificate; restore it from the repository");
  return pem;
}

/**
 * @param {object} [o]
 * @param {string} [o.dbUrl]   defaults to env.AGENCY_BOARD_DB_URL
 * @param {string} [o.dir]     migrations directory, defaults to <repo>/supabase/migrations
 * @param {Record<string, string|undefined>} [o.env]
 * @param {(line: string) => void} [o.log]
 * @param {(line: string) => void} [o.logError]  failures; the CLI sends these to stderr
 * @param {(config: object) => any} [o.createClient]  injectable for tests
 * @returns {Promise<{exitCode: number, applied: number, skipped?: string, failed?: string}>}
 */
export async function runMigrations({
  dbUrl,
  dir = DEFAULT_DIR,
  env = process.env,
  log = console.log,
  logError = console.error,
  createClient = (config) => new pg.Client(config),
} = {}) {
  const url = (dbUrl ?? env.AGENCY_BOARD_DB_URL ?? "").trim();
  if (!url) {
    log("migrate: AGENCY_BOARD_DB_URL not set, skipping");
    return { exitCode: 0, applied: 0, skipped: "no-db-url" };
  }
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") {
    log(`migrate: skipping (VERCEL_ENV=${env.VERCEL_ENV}); only production builds migrate the database`);
    return { exitCode: 0, applied: 0, skipped: `vercel-env-${env.VERCEL_ENV}` };
  }

  const secrets = secretsOf(url);
  const fail = (what, err) => {
    logError(`migrate: FAILED ${what}: ${scrub(err?.message ?? err, secrets)}`);
    return { exitCode: 1, applied: 0, failed: what };
  };

  let config;
  try { config = buildConnectionConfig(url, env); } catch (e) { return fail("connection setup", e); }

  let files;
  try {
    files = readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
  } catch (e) {
    return fail(`reading ${dir}`, e);
  }
  if (!files.length) {
    log("migrate: no migration files found, nothing to apply");
    return { exitCode: 0, applied: 0 };
  }
  const anchor = config.ssl ? (env.AGENCY_BOARD_DB_SSL_CA?.trim() ? "AGENCY_BOARD_DB_SSL_CA" : "the bundled Supabase CA") : "";
  if (anchor) log(`migrate: verifying the database certificate against ${anchor}`);

  const client = createClient(config);
  client.on?.("error", () => { /* idle-connection errors surface on the next query; never crash with the driver's text */ });
  let connected = false;
  let applied = 0;
  let current = "connecting to the database";
  try {
    await client.connect();
    connected = true;

    // One runner at a time (two deploys, or a deploy and `supabase db push`, cannot interleave). Taken before the
    // bookkeeping DDL so two first-ever runs cannot race on CREATE SCHEMA. Session-level: released on end().
    current = "taking the migration lock";
    await client.query("select pg_advisory_lock($1::bigint)", [LOCK_KEY]);

    current = "preparing supabase_migrations.schema_migrations";
    await client.query("create schema if not exists supabase_migrations");
    await client.query(
      "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)",
    );
    current = "reading supabase_migrations.schema_migrations";
    const done = new Set((await client.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));

    const pending = files.filter((f) => !done.has(f.slice(0, 14)));
    for (const file of pending) {
      current = file;
      const [, version, name] = file.match(NAME_RE);
      const sql = readFileSync(join(dir, file), "utf8");
      log(`migrate: applying ${file}`);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)", [version, [sql], name]);
        await client.query("commit");
      } catch (e) {
        try { await client.query("rollback"); } catch { /* connection already gone: the server rolled back */ }
        throw e;
      }
      applied++;
    }
    log(applied ? `migrate: applied ${applied} migration(s)` : "migrate: up to date, 0 migrations to apply");
    return { exitCode: 0, applied };
  } catch (e) {
    if (!connected && isCertError(e)) {
      // Built from the error code only: the driver text (ERR_TLS_CERT_ALTNAME_INVALID) carries the host name.
      logError(
        `migrate: FAILED ${current}: TLS certificate verification failed (${e.code}). The database certificate is not signed by ` +
          `${anchor === "AGENCY_BOARD_DB_SSL_CA" ? "the CA in AGENCY_BOARD_DB_SSL_CA" : "the bundled Supabase CA"}, or the host name does not match it. ` +
          "If your database is not hosted on Supabase (or uses a custom domain), set AGENCY_BOARD_DB_SSL_CA to your provider's CA certificate (PEM). " +
          "Verification cannot be turned off.",
      );
      return { exitCode: 1, applied, failed: current };
    }
    return { ...fail(current, e), applied };
  } finally {
    if (connected) {
      try { await client.query("select pg_advisory_unlock($1::bigint)", [LOCK_KEY]); } catch { /* released with the session anyway */ }
    }
    try { await client.end(); } catch { /* ignore */ }
  }
}

// CLI: only when executed directly (node scripts/migrate.mjs / npm prebuild), not when imported by tests.
function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const result = await runMigrations();
  process.exitCode = result.exitCode;
}
