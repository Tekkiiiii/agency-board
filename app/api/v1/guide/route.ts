import { z } from "zod";
import { guideJson, guideText, publicBase, youOf, youText } from "../../../../lib/guide";
import { enforce, json, setRoute, withAgent } from "../../../../lib/request";

// GET /api/v1/guide (agent token): full guide + per-caller `you` block (resolved per request from ctx, §11).
// Static segment: takes precedence over app/api/v1/[...path].
export const dynamic = "force-dynamic";

const querySchema = z.object({ format: z.enum(["json", "text"]).default("json") });

export function GET(req: Request): Promise<Response> {
  return withAgent(req, "rest:guide", async (ctx) => {
    setRoute("rest:guide");
    await enforce(ctx, "read");
    const { format } = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const you = youOf(ctx);
    if (format === "text") {
      return new Response(guideText({ base: publicBase(req) }) + youText(you), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return json({ ...guideJson(), you });
  });
}
