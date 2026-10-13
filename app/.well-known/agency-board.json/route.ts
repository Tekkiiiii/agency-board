import { publicBase, wellKnown } from "../../../lib/guide";

// Public, no token: REDACTED guide JSON + entry points (revision 2026-10-07-agent-guide.md ADDENDUM).
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return Response.json(wellKnown(publicBase(req)), { headers: { "cache-control": "public, max-age=300" } });
}
