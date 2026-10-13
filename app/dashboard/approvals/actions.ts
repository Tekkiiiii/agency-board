"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { readableError } from "../../../lib/dash/board";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import * as H from "../../../lib/handlers";

export type ApprovalActionResult = { ok: boolean; message: string } | null;

const decideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  answer: z
    .string()
    .max(2000)
    .transform((s) => s.trim())
    .optional(),
});

// Approve / deny a pending approval. H.approvalDecide applies the confidential tier guard (§13: PII never, confidential contracts only on confidential tasks) to the
// answer; its 422 and the 409 "already decided" race come back as readable messages.
export async function decideAction(_prev: ApprovalActionResult, fd: FormData): Promise<ApprovalActionResult> {
  await requireAdmin();
  try {
    const raw = fd.get("answer");
    const p = decideSchema.parse({
      id: fd.get("id"),
      decision: fd.get("decision"),
      answer: typeof raw === "string" && raw.trim() !== "" ? raw : undefined,
    });
    await H.approvalDecide({ id: p.id, decision: p.decision, ...(p.answer ? { answer: p.answer } : {}) }, { actor: "owner" });
    await logAdminAction("approval_decide", 200);
    revalidatePath("/dashboard/approvals");
    revalidatePath("/dashboard");
    return { ok: true, message: p.decision === "approved" ? "Approved." : "Denied." };
  } catch (e) {
    const { status, message } = readableError(e);
    if (status >= 500) console.error("[hub] dash action failed", "approval_decide", String((e as { code?: unknown })?.code ?? "unknown"));
    await logAdminAction("approval_decide", status);
    return { ok: false, message };
  }
}
