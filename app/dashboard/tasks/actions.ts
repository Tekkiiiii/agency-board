"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cancelTask, readableError, reassignTargets, reassignTask, retryTask } from "../../../lib/dash/board";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";

// Admin task mutations (§18 B-BOARD). requireAdmin -> zod -> lib -> logAdminAction -> revalidatePath.
// Every action returns a user-visible result instead of throwing, so 404/409/422 show inline.

export type TaskActionResult = { ok: boolean; message: string } | null;

const idSchema = z.object({ id: z.string().uuid() });
const reassignSchema = z.object({ id: z.string().uuid(), target: z.string().min(1).max(100) });

async function run(name: string, fn: () => Promise<string>): Promise<TaskActionResult> {
  try {
    const message = await fn();
    await logAdminAction(name, 200);
    revalidatePath("/dashboard/tasks");
    revalidatePath("/dashboard");
    return { ok: true, message };
  } catch (e) {
    const { status, message } = readableError(e);
    if (status >= 500) console.error("[hub] dash action failed", name, String((e as { code?: unknown })?.code ?? "unknown"));
    await logAdminAction(name, status);
    return { ok: false, message };
  }
}

export async function reassignAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  await requireAdmin();
  return run("task_reassign", async () => {
    const p = reassignSchema.parse({ id: fd.get("id"), target: fd.get("target") });
    const { targets } = await reassignTargets();
    await reassignTask(p.id, p.target, targets.map((t) => t.value));
    return `Reassigned to ${p.target}. The task is open again.`;
  });
}

export async function cancelAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  await requireAdmin();
  return run("task_cancel", async () => {
    const p = idSchema.parse({ id: fd.get("id") });
    await cancelTask(p.id);
    return "Task cancelled.";
  });
}

export async function retryAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  await requireAdmin();
  return run("task_retry", async () => {
    const p = idSchema.parse({ id: fd.get("id") });
    await retryTask(p.id);
    return "Task reopened. Attempts were kept.";
  });
}
