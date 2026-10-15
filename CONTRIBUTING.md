# Contributing

Thanks for helping. This project is small and early (v0.1), so keep changes focused.

## Setup

Requirements: Node.js 22+, Docker (or a compatible runtime), the Supabase CLI.

```sh
supabase start                 # local Postgres, auth and edge runtime; applies supabase/migrations
cp .env.example .env.local     # fill SUPABASE_* from `supabase status`; other values can stay as the fake placeholders
npm ci
npm run dev                    # http://localhost:13100
```

See the quickstart in [README.md](README.md) for details.

## Tests

```sh
npm test                       # vitest
npm run typecheck              # tsc --noEmit
```

The tests run against the local Supabase stack, so `supabase start` must be running. URL and keys are read from `supabase status` (or from a git-ignored `.env.test.local`); `.env.local` is never used by the tests. A `SUPABASE_URL` that is not `127.0.0.1`, `localhost` or `::1` is refused before any request is made, unless you set `AGENCY_BOARD_TEST_ALLOW_REMOTE=1` for a disposable hosted project. Never point tests at a project that holds real data. Each run writes rows under its own `test-<runId>-` prefix and removes them afterwards.

If you change a migration, restart with `supabase db reset` and re-run the full suite.

Migration policy: once a version is released, its migrations are immutable. Add a new, additive migration instead (new tables, new columns that are nullable or have a default). Do not drop, rename or change the type of something in the same release as the code that stops using it; destructive changes take two releases (expand, then contract). The reasons are in [README.md](README.md), section Updating. Before the first release tag, migrations may still be edited in place; say so in the PR.

## Style

- TypeScript strict. Relative imports only, no `@/` alias, no file extensions in imports.
- Match the surrounding code. Keep functions small and comments short.
- The JS guard (`lib/guard.ts`) and its SQL twins must stay in step. Change both and update the tests.
- Client components must not import `lib/config.ts` or read `process.env`; pass values as props.
- Do not log request bodies, memory content or tokens. Log codes and ids only.
- Add a dependency only with a reason in the PR description.
- Docs: plain, short sentences. Update [docs/CONTRACT.md](docs/CONTRACT.md) when behaviour changes.

## Pull request checklist

- [ ] `npm test` and `npm run typecheck` pass locally (paste the summary line).
- [ ] New behaviour has a test; a bug fix has a test that fails without the fix.
- [ ] Docs updated (README, `.env.example`, docs/) if you changed behaviour or configuration.
- [ ] No secrets, real tokens, keys, `.env.local`, or personal data in the diff. Test tokens contain `FAKE` or `test`.
- [ ] No real names, company names, customer data or production URLs in code, tests, docs or the PR text. Use placeholders such as `<your-app>.vercel.app`, `<project-ref>`, `laptop`, `work-pc`.
- [ ] I read the full `git diff` before pushing.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
