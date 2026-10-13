// Display-only helpers for the human dashboard. Pure; never use these on data that
// is stored, returned by the API/MCP, used as a key, or used in a link.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// 8 hex chars, word-bounded, with at least one digit AND one letter (so "deadbeef",
// "facade00"-style words and 8-digit numbers like 20261008 are left alone).
const SHORT = "(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}";
const ID = `(?:${UUID}|${SHORT})`;
const SEP = "(?:\\s*[/,&+]\\s*|\\s+and\\s+)";
// optional "task " / "#" prefix, then one id or a list of ids
const RUN = String.raw`(?:\btask[\s#_-]*|#)?\b${ID}\b(?:${SEP}\b${ID}\b)*`;

const RUN_WITH_VERB = new RegExp(String.raw`${RUN}\s+(?:are|is)\s+`, "gi");
const RUN_RE = new RegExp(RUN, "gi");

/** Remove agent task-id references (UUIDs, 8-hex short ids) from a task title for human display. */
export function displayTaskTitle(title: string): string {
  if (!title) return title;
  const cleaned = title
    .replace(RUN_WITH_VERB, " ")
    .replace(RUN_RE, " ")
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .replace(/\s+([:,;])/g, "$1")
    .replace(/([:,;])(?:\s*[:,;])+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:,;/\-–—]+/, "")
    .replace(/[\s,;:/\-–—]+$/, "")
    .trim();
  return cleaned === "" ? title : cleaned;
}
