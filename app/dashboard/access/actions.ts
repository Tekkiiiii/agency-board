"use server";

import { revalidatePath } from "next/cache";
import {
  actionErrorMessage,
  createProjectSchema,
  grantInputSchema,
  grantNeedsRestrictedAck,
  parseWith,
  renameProjectSchema,
} from "../../../lib/dash/access";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import { createProject, renameProject, setGrant } from "../../../lib/roles";

export type ActionResult = { ok: true; changed?: boolean } | { ok: false; error: string };

const PATH = "/dashboard/access";

// One checkbox = one call. `granted` is the desired state, passed explicitly (never derived from a toggle).
export async function setGrantAction(raw: unknown): Promise<ActionResult> {
  await requireAdmin();
  const p = parseWith(grantInputSchema, raw);
  if (!p.ok) {
    await logAdminAction("access.grant", 422);
    return { ok: false, error: p.error };
  }
  if (grantNeedsRestrictedAck(p.value)) {
    await logAdminAction("access.grant", 422);
    return { ok: false, error: "Granting a project to a restricted agent needs the warning to be confirmed first." };
  }
  try {
    const { agent, device_id, slug, granted } = p.value;
    const r = await setGrant(agent, device_id, slug, granted);
    await logAdminAction("access.grant", 200);
    revalidatePath(PATH);
    return { ok: true, changed: r.changed };
  } catch (e) {
    const m = actionErrorMessage(e);
    await logAdminAction("access.grant", m.status);
    return { ok: false, error: m.message };
  }
}

export async function createProjectAction(raw: unknown): Promise<ActionResult> {
  await requireAdmin();
  const p = parseWith(createProjectSchema, raw);
  if (!p.ok) {
    await logAdminAction("access.project_create", 422);
    return { ok: false, error: p.error };
  }
  try {
    await createProject(p.value.slug, p.value.name);
    await logAdminAction("access.project_create", 200);
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    const m = actionErrorMessage(e);
    await logAdminAction("access.project_create", m.status);
    return { ok: false, error: m.message };
  }
}

export async function renameProjectAction(raw: unknown): Promise<ActionResult> {
  await requireAdmin();
  const p = parseWith(renameProjectSchema, raw);
  if (!p.ok) {
    await logAdminAction("access.project_rename", 422);
    return { ok: false, error: p.error };
  }
  try {
    await renameProject(p.value.slug, p.value.name);
    await logAdminAction("access.project_rename", 200);
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    const m = actionErrorMessage(e);
    await logAdminAction("access.project_rename", m.status);
    return { ok: false, error: m.message };
  }
}
