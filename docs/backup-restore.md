# Backup and restore

Nightly GitHub Actions job `.github/workflows/backup.yml` (`db-backup`) runs at 19:00 UTC.
It dumps schema `public` of your Supabase project with `pg_dump -Fc --no-owner --no-privileges`
(postgresql-client-17, matches the server's Postgres 17), encrypts it with GPG AES256 (symmetric), and uploads
artifact `db-backup-YYYY-MM-DD` (file `backup.dump.gpg`). Artifacts are kept 30 days. The job fails if the dump
is empty or has no public tables.

## Secrets

| Secret | Where |
|---|---|
| `BACKUP_PASSPHRASE` | GitHub repo secret, plus a copy in your password manager (and optionally a git-ignored local file, mode 600) |
| `SUPABASE_DB_URL` | GitHub repo secret. Session pooler URL: `postgresql://postgres.<project-ref>:<url-encoded db password>@<pooler-host>:5432/postgres?sslmode=require` (Supabase dashboard -> Connect -> Session pooler) |

Without the passphrase the backups cannot be decrypted. Keep a copy in your password manager.

## Run a backup now

```bash
gh workflow run backup.yml --repo <owner>/agency-board
gh run list --workflow backup.yml --repo <owner>/agency-board --limit 3
```

## Download

```bash
gh run list --workflow backup.yml --repo <owner>/agency-board --limit 5   # pick a run id
gh run download <run-id> --repo <owner>/agency-board --dir /tmp/hub-restore
# -> /tmp/hub-restore/db-backup-YYYY-MM-DD/backup.dump.gpg
```

## Decrypt

```bash
# BACKUP_PASSPHRASE must be in your environment (read it from your password manager; do not put it on the command line)
printf '%s' "$BACKUP_PASSPHRASE" \
  | gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
        --decrypt -o /tmp/hub-restore/backup.dump /tmp/hub-restore/db-backup-*/backup.dump.gpg
pg_restore -l /tmp/hub-restore/backup.dump | head    # sanity check: lists TABLE public ...
```

## Restore

The dump contains schema `public` only (tables, functions, triggers, RLS policies, data). Extensions
(`vector`, `pgcrypto`, ...) live outside `public`, so create them first on a fresh project.

1. Target: a fresh Supabase project (preferred), or the existing one after accepting data loss.
2. Get the target's session pooler URL (Dashboard -> Connect -> Session pooler), as `TARGET_DB_URL`.
3. Fresh project only: create the extensions (same as the migration header):
   ```bash
   psql "$TARGET_DB_URL" -c 'create extension if not exists vector with schema extensions;
     create extension if not exists unaccent with schema extensions;
     create extension if not exists pgcrypto with schema extensions;'
   ```
4. Restore (use pg_restore 17+; Homebrew: `/opt/homebrew/opt/libpq/bin/pg_restore`):
   ```bash
   # fresh project: public schema already exists and is empty
   pg_restore -d "$TARGET_DB_URL" --no-owner --no-privileges --clean --if-exists \
     --single-transaction /tmp/hub-restore/backup.dump
   ```
   `--clean --if-exists` drops and recreates objects, so it also works on the existing project.
5. Re-apply grants. The dump is taken with `--no-privileges`, so the `service_role` grants are NOT in it.
   Run the revoke/grant block at the end of the migration:
   ```bash
   sed -n '/^revoke all on all tables in schema public from anon/,$p' supabase/migrations/20261007000001_init.sql \
     | psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1
   ```
   Then check: `curl -s https://<app>/api/health`.
6. New project: update `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in your host settings and `.env.local`, redeploy the
   embed function (`supabase functions deploy embed --project-ref <new-ref>`), and update the `SUPABASE_DB_URL` secret.
7. Delete `/tmp/hub-restore` when done (it holds plaintext data).
