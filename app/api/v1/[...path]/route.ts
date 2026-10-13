import * as H from "../../../../lib/handlers";
import { errorResponse, json, setRoute, withAgent } from "../../../../lib/request";
import { ApiError, type AgentCtx } from "../../../../lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Op = (ctx: AgentCtx, input: unknown) => Promise<unknown>;
type Src = "body" | "query" | "none";

// [method, path pattern, op name, handler, input source]. First match wins (search before :id).
const ROUTES: Array<[string, string, string, Op, Src]> = [
  ["POST", "memories", "remember", H.remember, "body"],
  ["GET", "memories/search", "recall", H.recall, "query"],
  ["GET", "memories/:id", "get_memory", H.getMemory, "none"],
  ["DELETE", "memories/:id", "forget", H.forget, "none"],
  ["GET", "memories/:id/neighbors", "get_neighbors", H.getNeighbors, "query"],
  ["POST", "tasks", "post_task", H.postTask, "body"],
  ["GET", "tasks", "list_tasks", H.listTasks, "query"],
  ["POST", "tasks/:id/claim", "claim_task", H.claimTask, "none"],
  ["PATCH", "tasks/:id", "update_task", H.updateTask, "body"],
  ["POST", "tasks/:id/complete", "complete_task", H.completeTask, "body"],
  ["POST", "tasks/:id/ack", "ack_task", H.ackTask, "none"],
  ["POST", "tasks/:id/handoff", "handoff", H.handoff, "body"],
  ["POST", "heartbeat", "heartbeat", H.heartbeat, "body"],
  ["POST", "approvals", "request_approval", H.requestApproval, "body"],
  ["GET", "approvals/:id", "get_approval", H.getApproval, "none"],
  ["GET", "reviews", "list_reviews", H.listReviews, "none"],
  ["POST", "reviews/:id", "review", H.review, "body"],
  ["GET", "inbox", "inbox", H.inbox, "query"],
];

function match(pattern: string, parts: string[]): Record<string, string> | null {
  const segs = pattern.split("/");
  if (segs.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(":")) params[segs[i].slice(1)] = parts[i];
    else if (segs[i] !== parts[i]) return null;
  }
  return params;
}

// Query strings are strings; the shared zod schemas expect numbers/booleans.
const NUM = new Set(["limit", "depth"]);
const BOOL = new Set(["neighbors", "mine"]);
function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    if (NUM.has(k)) out[k] = v === "" ? undefined : Number(v);
    else if (BOOL.has(k)) out[k] = v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : v;
    else out[k] = v;
  }
  return out;
}

async function bodyInput(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ApiError(422, "VALIDATION", "Body must be a JSON object");
}

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  for (const [method, pattern, name, op, src] of ROUTES) {
    if (method !== req.method) continue;
    const p = match(pattern, path);
    if (!p) continue;
    const route = `rest:${name}`;
    return withAgent(req, route, async (ctx) => {
      setRoute(route);
      const base = src === "body" ? await bodyInput(req) : src === "query" ? queryInput(new URL(req.url)) : {};
      const data = await op(ctx, { ...base, ...p }); // path params win over body
      if (name === "inbox" && base.format === "text") {
        // SessionStart hook prints this verbatim into the agent's context (§15).
        return new Response(H.inboxText(data as Parameters<typeof H.inboxText>[0]), {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return json(data);
    });
  }
  return errorResponse(new ApiError(404, "NOT_FOUND", "No such route"));
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
