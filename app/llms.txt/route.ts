import { guideText, publicBase } from "../../lib/guide";

// Public, no token (revision 2026-10-07-agent-guide.md ADDENDUM): REDACTED guide (no identities, confidential slugs,
// grants or confidential-project wording). The full guide + your rights: GET /api/v1/guide with an agent token.
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return new Response(guideText({ public: true, base: publicBase(req) }), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
