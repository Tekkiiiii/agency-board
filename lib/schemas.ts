import { z } from "zod";
import { AGENTS, isAgentId } from "./config";
import { NAMESPACE_RE, SLUG_RE } from "./scopes";

// Shared by MCP (inputSchema) and REST (handlers parse their own input).
// Handlers call `.parse()`; ZodError -> 422 VALIDATION via lib/request.ts errorResponse.

const ns = z.string().regex(NAMESPACE_RE, "namespace must match ^[a-z0-9-]+(/[a-z0-9-]+)*$ (max 100)");
// Scope pattern used as a filter: '*', 'a/b' or 'a/*'.
const nsPattern = z.string().max(102).regex(/^(\*|[a-z0-9-]+(\/[a-z0-9-]+)*(\/\*)?)$/, "namespace filter must be '*', 'a/b' or 'a/*'");
const slug = z.string().regex(SLUG_RE, "slug must match ^_?[a-z0-9-]{1,80}$");
const id = z.uuid();
const agent = z.string().refine(isAgentId, { message: `agent must be one of ${AGENTS.join("|")}` });
// Dispatch target: an AgentId or one identity agent@machine (§15).
export const TARGET_RE = new RegExp(`^(${AGENTS.join("|")})(@[A-Za-z0-9._-]{1,80})?$`);
const target = z.string().regex(TARGET_RE, `target must be an agent (${AGENTS.join("|")}) or agent@machine`);
const role = z.enum(["director", "lead", "member"]);
const projectSlug = z.string().regex(/^[a-z0-9-]{1,40}$/, "project slug must match ^[a-z0-9-]{1,40}$");
const projectName = z.string().trim().min(1).max(80);
const tag = z.string().min(1).max(50);
const json = z.unknown(); // any JSON value; stored as jsonb

export const rememberSchema = z.object({
  namespace: ns.describe("Target namespace, e.g. shared/notes or project/agency-board"),
  content: z.string().min(1).max(8192).describe("Memory text. [[slug]] or [[namespace:slug]] creates links."),
  slug: slug.optional().describe("Stable per-namespace slug; default derived from the first line"),
  tags: z.array(tag).max(20).optional(),
  links: z
    .array(z.object({ slug, namespace: ns.optional(), relation: z.enum(["relates_to", "part_of", "about_project"]).default("relates_to") }))
    .max(20)
    .optional(),
  supersedes: id.optional().describe("id of an older memory this one replaces (hides it from recall)"),
  confidential: z
    .boolean()
    .optional()
    .describe("true for confidential contract content; requires a confidential project namespace such as project/confidential"),
});

export const recallSchema = z.object({
  q: z.string().min(1).max(1000).describe("What to search for"),
  namespace: nsPattern.optional().describe("Narrow to a namespace or pattern like project/*"),
  limit: z.number().int().min(1).max(20).default(8),
  neighbors: z.boolean().default(true).describe("Include up to 5 linked memories per hit"),
});

export const idSchema = z.object({ id });

export const neighborsSchema = z.object({
  id,
  depth: z.number().int().min(1).max(2).default(1),
  relation: z.enum(["relates_to", "supersedes", "part_of", "about_project"]).optional(),
});

export const postTaskSchema = z.object({
  namespace: ns,
  title: z.string().min(1).max(200),
  body: z.string().max(4096).optional(),
  handoff_to: target.optional().describe("Only this agent (or agent@machine) may claim it"),
});

export const listTasksSchema = z.object({
  status: z.enum(["open", "claimed", "blocked", "done", "failed", "cancelled"]).optional().describe("Default: open + claimed + blocked"),
  namespace: nsPattern.optional(),
  mine: z.boolean().default(false).describe("Only tasks handed off to me or claimed by me"),
});

export const updateTaskSchema = z.object({
  id,
  status: z.enum(["failed", "open", "blocked"]).optional().describe("'open' releases the claim; 'failed' ends it; 'blocked' (note required) routes it back to `to` (default assigned_by)"),
  note: z.string().max(2000).optional().describe("Required (min 1) when status=blocked"),
  to: target.optional().describe("status=blocked only: who must unblock it (agent or agent@machine); default the task's assigned_by"),
  result: json.optional(),
}).superRefine((v, c) => {
  if (v.status === "blocked" && !v.note?.trim()) c.addIssue({ code: "custom", path: ["note"], message: "note is required when status is blocked" });
});

export const heartbeatSchema = z.object({
  task_id: id.optional(),
  model: z.string().max(100).optional(),
  status_note: z.string().max(500).optional(),
});

export const completeTaskSchema = z.object({
  id,
  completion_key: z.string().min(8).max(100).describe("Idempotency key; replaying the same key returns the stored result"),
  result: json.optional(),
  status: z.enum(["done", "failed"]).default("done"),
  notify: target.optional().describe("Also close the loop: put the finished task in this agent or agent@machine's inbox (cleared by ack_task or claim)"),
  note: z.string().max(2000).optional().describe("Short note stored on the task event"),
});

export const ackTaskSchema = z.object({ id });

export const handoffSchema = z.object({ id, to: target.describe("agent or agent@machine"), note: z.string().min(1).max(2000) });

export const requestApprovalSchema = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
  task_id: id.optional(),
});

export const inboxSchema = z.object({ format: z.enum(["json", "text"]).default("json") });

export const listReviewsSchema = z.object({});

export const reviewSchema = z.object({
  kind: z.enum(["inbox", "approval"]),
  id,
  decision: z.enum(["approve", "reject", "approved", "denied"]).describe("approve|reject (inbox) or approved|denied (approval); either pair works for both"),
  namespace: ns.optional().describe("inbox approve: target namespace (default: the requested one)"),
  answer: z.string().max(2000).optional().describe("approval answer"),
});

// ---- admin ----
export const connectCodeSchema = z.object({
  machine_name: z.string().min(1).max(64),
  agents: z.array(agent).min(1),
  os: z.enum(["mac", "windows", "linux"]).optional(),
});
export const flagsSchema = z.object({ dispatch_paused: z.boolean().optional(), writes_frozen: z.boolean().optional() });
export const inboxApproveSchema = z.object({ id, namespace: ns.optional() });
export const approvalDecideSchema = z.object({ id, decision: z.enum(["approved", "denied"]), answer: z.string().max(2000).optional() });
export const backfillSchema = z.object({ limit: z.number().int().min(1).max(64).default(32) });
export const agentParamSchema = z.object({ agent });
export const setRoleSchema = z.object({ agent, device_id: id, role });
export const createProjectSchema = z.object({ slug: projectSlug, name: projectName });
export const renameProjectSchema = z.object({ slug: projectSlug, name: projectName });
export const setGrantSchema = z.object({ agent, device_id: id, project: projectSlug, granted: z.boolean() });
export const auditSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
