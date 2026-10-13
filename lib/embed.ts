export const EMBED_MODEL = "gte-small";

const BATCH = 16;
const MAX_CHARS = 8192;
const TIMEOUT_MS = 20_000; // edge function cold start (§15)

// Returns one 384-dim vector per input, or null on ANY failure (never throws).
// Callers store the row without an embedding and backfill later.
export async function embed(texts: string[]): Promise<number[][] | null> {
  try {
    if (texts.length === 0) return [];
    const base = process.env.SUPABASE_URL;
    const url = process.env.EMBED_URL || (base ? `${base}/functions/v1/embed` : "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      // ponytail: truncate rather than reject; the function caps each input at 8192 chars.
      const input = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_CHARS));
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { embeddings?: unknown };
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== input.length) return null;
      out.push(...(j.embeddings as number[][]));
    }
    return out;
  } catch {
    return null;
  }
}
