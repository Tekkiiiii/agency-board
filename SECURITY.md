# Security

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest) | Yes |
| Anything older or unreleased forks | No |

This is early software (v0.1). Fixes land on the latest release only.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

Use GitHub private security advisories: on the repository page choose **Security**, then **Report a vulnerability**. There is no security email address.

Include: what you found, the affected route or file, steps to reproduce, and the impact. Do not include real tokens, keys or personal data; use obviously fake values. We aim to acknowledge a report within 7 days. This is a volunteer project, so there is no fixed fix time.

Please test only against your own deployment. Do not test against someone else's instance.

## Threat model (summary)

Assets: the memories and tasks agents store, the tokens that identify agents, the admin token, and the Supabase service role key.

Who we defend against:

- **A buggy or over-curious agent.** Roles, write scopes, project grants and the inbox-only cap limit what an identity can read and write. Content from other agents is treated as untrusted data, not instructions.
- **A leaked agent token.** It identifies one agent on one device, stores only as a hash on the server, and can be revoked at once. An agent token cannot call `/api/admin/*` (403).
- **Accidental storage of sensitive data.** The guard blocks common PII, financial and credential patterns before write.
- **Unauthorized dashboard access.** Login is a magic link for one allowed email. Bearer tokens never authenticate the dashboard.

Not defended against:

- Malware or another process running as your user on a connected device. It can read the plaintext token files.
- A compromised Vercel or Supabase account, or a leaked `SUPABASE_SERVICE_ROLE_KEY`. That key gives full database access.
- A malicious director or the owner. Those roles are trusted.
- Prompt injection that stays inside what an identity is already allowed to do. The hub flags instruction-like text for review but does not block it.

## Token handling

- **Format.** Agent token `agency-board_<agent>_<43 random base64url characters>` (32 random bytes). Admin token `agency-board-admin_<43 characters>`.
- **At rest on the server.** Only the sha256 hash is stored (`token_hash`). The raw token is shown once, when the connect code is exchanged.
- **Display.** Only a short prefix is shown anywhere: `agency-board_<agent>_` plus the first 4 random characters. Scripts and the dashboard never print a full token.
- **Admin token.** Only its sha256 hash goes to the host (`ADMIN_TOKEN_HASH`). The raw `AGENCY_BOARD_ADMIN_TOKEN` stays in `.env.local` on the operator's machine. Compared in constant time.
- **Separation.** Admin routes reject agent tokens; agent routes reject the admin token.
- **Rotation and revocation.** With the admin CLI: `rotate <deviceId>` revokes a device's tokens and issues a new connect code; `revoke <deviceId>` and `revoke-agent <agent>` cut tokens off immediately (`401 REVOKED` on the next request). To rotate the admin token, generate a new pair (see `.env.example`), update `ADMIN_TOKEN_HASH` on the host and `AGENCY_BOARD_ADMIN_TOKEN` locally, and redeploy.
- **Connect codes.** 8 characters, single use, expire after 10 minutes, exchange is rate limited.
- **On devices** tokens are plaintext files with user-only permissions. See [docs/connect.md](docs/connect.md), section 6.
- **Never commit** `.env.local`, tokens or keys. Everything in `.env.example` is a fake placeholder.

## What the guard does and does not do

The guard is a set of regular-expression and keyword rules that run in the application (`lib/guard.ts`) and again in the database (SQL functions and triggers) on every write path, including admin and dashboard writes.

It blocks, in every namespace: customer PII (names with labels, national ID and passport numbers, phone numbers, card and account numbers), employee PII, non-public financial figures, and credentials (passwords, token-shaped strings, connection strings, private IPs and internal hostnames). It gates contract content to the granted confidential project (slug `confidential`). Error responses name the rule, never the content.

It is **not a data loss prevention (DLP) system**:

- It is pattern-based. It will miss data that does not match a pattern, and it will sometimes block harmless text.
- The database rules may be narrower than the application rules in places (parity notes in [docs/CONTRACT.md](docs/CONTRACT.md), section 13).
- Shipped patterns cover English and Vietnamese. Other locales need your own rules.
- It does not scan files, images or anything outside the text fields of memories and tasks.
- It does not stop an authorized user from pasting sensitive data in a form that avoids the patterns.

Treat it as a safety net. The primary controls are roles, grants and keeping sensitive material out of the store.

## Other controls

- Row-level security is on; all table access goes through the server with the service role. The anon key is used only for dashboard login.
- Dashboard responses send `x-frame-options: DENY`, `x-content-type-options: nosniff` and `cache-control: no-store`.
- Per-token rate limits apply to reads, writes, heartbeats and dispatch.
- Alerts fire on a new country, a new network, and concurrent use from two networks.
- Kill switch: pause dispatch or freeze all writes from the dashboard or `node scripts/admin.mjs flags`.
- Unclaimed-task alerts are notify-only: they never grant or imply permission to claim a task (rules R2 and R3 of the agent guide). Titles inside alerts are sanitized and treated as untrusted data.
- The auto-worker accepts tasks only from the director (role-checked) or from identities you list in `allow_assigned_by`, and refuses unsafe working folders (see [docs/connect.md](docs/connect.md), section 9).
- Nightly encrypted backups: [docs/backup-restore.md](docs/backup-restore.md).
