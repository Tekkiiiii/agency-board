// Embedding Edge Function: gte-small (384 dims) via Supabase.ai. JWT verification ON at deploy.
// deno-lint-ignore no-explicit-any
declare const Supabase: any;

const session = new Supabase.ai.Session("gte-small");
const MAX_INPUTS = 16;
const MAX_CHARS = 8192;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bad = (message: string) => json({ error: { code: "BAD_REQUEST", message } }, 400);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, 405);

  let body: { input?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("body must be JSON");
  }
  const input = typeof body?.input === "string" ? [body.input] : body?.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_INPUTS) {
    return bad(`input must be a string or 1-${MAX_INPUTS} strings`);
  }
  if (!input.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_CHARS)) {
    return bad(`each input must be a non-empty string <= ${MAX_CHARS} chars`);
  }

  try {
    const embeddings: number[][] = [];
    for (const t of input as string[]) {
      embeddings.push(Array.from(await session.run(t, { mean_pool: true, normalize: true }) as number[]));
    }
    return json({ embeddings, model: "gte-small" });
  } catch {
    return json({ error: { code: "EMBED_FAILED", message: "embedding failed" } }, 500);
  }
});
