import { WORKER_MJS } from "../../lib/scripts/workerMjs";

export const dynamic = "force-dynamic";

// Public like /connect.sh: the worker source holds no secrets (base URL + token live in ~/.agency-board).
export function GET(): Response {
  return new Response(WORKER_MJS, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}
