"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  approveInboxItem,
  editMemory,
  readableError,
  rejectInboxItem,
  removeAutoLink,
  retireMemory,
  setPinned,
} from "../../../lib/dash/memory";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import { NAMESPACE_RE } from "../../../lib/scopes";
import { tierHit } from "../../../lib/guard";
import { ApiError } from "../../../lib/types";
import type { ActionState } from "./types";

const PATH = "/dashboard/memory";
const id = z.string().uuid();

function statusOf(e: unknown): number {
  if (e instanceof ApiError) return e.status;
  if (e instanceof z.ZodError) return 422;
  if (tierHit(e)) return 422; // §13 / §13.5 DB trigger `<CODE>:<rule>` (all 5 tier codes)
  return 500;
}

// requireAdmin -> zod parse -> lib call -> log -> revalidate. Errors become a readable, content-free message.
async function act(name: string, fn: () => Promise<string>): Promise<NonNullable<ActionState>> {
  try {
    const message = await fn();
    await logAdminAction(name, 200);
    revalidatePath(PATH);
    return { ok: true, message };
  } catch (e) {
    const status = statusOf(e);
    if (status >= 500) console.error("[hub] dash action failed", name, String((e as { code?: unknown })?.code ?? "unknown"));
    await logAdminAction(name, status);
    return { ok: false, message: readableError(e) };
  }
}

const editSchema = z.object({ id, content: z.string().min(1).max(8192) });

export async function editMemoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  let newId: string | null = null;
  const res = await act("memory_edit", async () => {
    const p = editSchema.parse({ id: fd.get("id"), content: fd.get("content") });
    const r = await editMemory(p);
    newId = r.id;
    return `Saved as ${r.slug}${r.embedded ? "" : " (embedding pending; backfilled by the daily job)"}.`;
  });
  if (res.ok && newId) redirect(`${PATH}?id=${newId}&done=edited`);
  return res;
}

export async function retireMemoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  return act("memory_retire", async () => {
    const p = z.object({ id }).parse({ id: fd.get("id") });
    return (await retireMemory(p.id)) ? "Memory retired." : "Memory was already retired.";
  });
}

export async function pinMemoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  return act("memory_pin", async () => {
    const p = z.object({ id, pinned: z.enum(["true", "false"]) }).parse({ id: fd.get("id"), pinned: fd.get("pinned") });
    await setPinned(p.id, p.pinned === "true");
    return p.pinned === "true" ? "Pinned." : "Unpinned.";
  });
}

export async function removeAutoLinkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  return act("memory_unlink", async () => {
    const p = z.object({ linkId: z.coerce.number().int().positive() }).parse({ linkId: fd.get("linkId") });
    await removeAutoLink(p.linkId);
    return "Auto link removed.";
  });
}

const nsOverride = z
  .string()
  .trim()
  .max(100)
  .transform((s) => s.toLowerCase())
  .refine((s) => s === "" || NAMESPACE_RE.test(s), "Namespace must look like project/name (lowercase, digits, dashes)");

export async function approveInboxAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  return act("inbox_approve", async () => {
    const p = z.object({ id, namespace: nsOverride }).parse({ id: fd.get("id"), namespace: fd.get("namespace") ?? "" });
    const r = await approveInboxItem(p.id, p.namespace || undefined);
    return `Approved into ${r.namespace} as ${r.slug}.`;
  });
}

export async function rejectInboxAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  return act("inbox_reject", async () => {
    const p = z.object({ id }).parse({ id: fd.get("id") });
    await rejectInboxItem(p.id);
    return "Rejected.";
  });
}
