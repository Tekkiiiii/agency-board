import { CONNECT_PS1 } from "../../lib/scripts/connectPs1";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const base = (process.env.AGENCY_BOARD_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  return new Response(CONNECT_PS1.replaceAll("__AGENCY_BOARD_BASE_URL__", base), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
