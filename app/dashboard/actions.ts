"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { trustAlert } from "../../lib/access";
import { db } from "../../lib/db";
import { alertDevice, markAlert } from "../../lib/dash/fleet";
import { logAdminAction } from "../../lib/dash/log";
import { requireAdmin } from "../../lib/dash/session";
import { revokeDevice, rotateDevice } from "../../lib/devices";
import * as H from "../../lib/handlers";
import { errorResponse } from "../../lib/request";

// Overview "Needs you" inline actions (§16): requireAdmin -> zod -> lib -> logAdminAction -> revalidatePath.
// Every action returns a result instead of throwing so the panel can show the error inline.

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };
export type RotateResult =
  | { ok: true; machine: string; code: string; expiresAt: string; commands: { mac: string; windows: string } }
  | { ok: false; message: string };

const idForm = z.object({ id: z.uuid() });
const decisionForm = z.object({ id: z.uuid(), decision: z.enum(["approved", "denied"]) });
const disableForm = z.object({ id: z.uuid(), confirm: z.string().max(200) });

// Maps any thrown error to (status, safe message) via the API error mapper; never echoes content.
async function failure(name: string, e: unknown): Promise<{ ok: false; message: string }> {
  const res = errorResponse(e);
  let message = "Something went wrong. Try again.";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (res.status < 500 && body.error?.message) message = body.error.message;
  } catch {
    // keep the generic message
  }
  await logAdminAction(name, res.status);
  return { ok: false, message };
}

function refresh(): void {
  revalidatePath("/dashboard", "layout"); // nav badges + overview + sub-pages
}

async function baseUrl(): Promise<string> {
  const env = process.env.AGENCY_BOARD_BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:13100";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function decideApprovalAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireAdmin();
  const name = "approval_decide";
  try {
    const p = decisionForm.parse({ id: fd.get("id"), decision: fd.get("decision") });
    await H.approvalDecide({ id: p.id, decision: p.decision }, { actor: "owner" });
    await logAdminAction(name, 200);
    refresh();
    return { ok: true, message: p.decision === "approved" ? "Approved" : "Denied" };
  } catch (e) {
    return failure(name, e);
  }
}

export async function trustAlertAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  await requireAdmin();
  const name = "alert_trust";
  try {
    const { id } = idForm.parse({ id: fd.get("id") });
    await trustAlert(id);
    await logAdminAction(name, 200);
    refresh();
    return { ok: true, message: "Trusted" };
  } catch (e) {
    return failure(name, e);
  }
}

// Revokes the alert's device (all its tokens) and closes the alert as 'disabled'.
// Typed confirmation = the device's machine name, re-checked here against the DB.
export async function disableAlertAction(fd: FormData): Promise<ActionResult> {
  await requireAdmin();
  const name = "alert_disable";
  try {
    const p = disableForm.parse({ id: fd.get("id"), confirm: fd.get("confirm") ?? "" });
    const deviceId = await alertDevice(p.id);
    if (!deviceId) return { ok: false, message: "This alert is not tied to a device." };
    const dev = await db().from("devices").select("machine_name").eq("id", deviceId).maybeSingle();
    if (dev.error) throw dev.error;
    const machine = (dev.data as { machine_name: string } | null)?.machine_name;
    if (!machine || p.confirm.trim() !== machine) {
      await logAdminAction(name, 422);
      return { ok: false, message: "Confirmation did not match the machine name. Nothing was changed." };
    }
    await revokeDevice(deviceId);
    await markAlert(p.id, "disabled");
    await logAdminAction(name, 200);
    refresh();
    return { ok: true, message: `${machine} disabled` };
  } catch (e) {
    return failure(name, e);
  }
}

// Revokes the device's tokens and issues a fresh connect code; the alert closes as 'rotated'.
export async function rotateAlertAction(fd: FormData): Promise<RotateResult> {
  await requireAdmin();
  const name = "alert_rotate";
  try {
    const { id } = idForm.parse({ id: fd.get("id") });
    const deviceId = await alertDevice(id);
    if (!deviceId) return { ok: false, message: "This alert is not tied to a device." };
    const r = await rotateDevice(deviceId, await baseUrl());
    await markAlert(id, "rotated");
    const dev = await db().from("devices").select("machine_name").eq("id", deviceId).maybeSingle();
    await logAdminAction(name, 200);
    refresh();
    return {
      ok: true,
      machine: (dev.data as { machine_name: string } | null)?.machine_name ?? "",
      code: r.code,
      expiresAt: r.expiresAt,
      commands: r.commands,
    };
  } catch (e) {
    return failure(name, e);
  }
}
