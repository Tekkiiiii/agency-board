"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { dismissAlert, trustAlert } from "../../../lib/access";
import { isAgentId } from "../../../lib/config";
import {
  agentAllowedOnOs,
  baseUrlFrom,
  closeAlert,
  CONNECT_AGENTS,
  DEVICE_OS,
  deviceBasics,
  directorToDemote,
  identLabel,
  MACHINE_NAME_RE,
  markAllAlertsRead,
  needsRestrictedWarning,
  parseListenForm,
  type DeviceOs,
} from "../../../lib/dash/devices";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import { setListenMinutes } from "../../../lib/agentSettings";
import { issueConnectCode, revokeDevice, rotateDevice } from "../../../lib/devices";
import { listIdentities, setRole } from "../../../lib/roles";
import { tierHit, tierReadable } from "../../../lib/guard";
import { ApiError, ROLES, type AgentId, type Role } from "../../../lib/types";
import type { ActionState } from "./types";

const PATH = "/dashboard/devices";

// Error codes shown by the page via ?e= (fixed list: never reflects arbitrary text).
export type DeviceErrorCode = "failed" | "not_found" | "confirm_mismatch" | "invalid";

function statusOf(e: unknown): number {
  if (e instanceof ApiError) return e.status;
  return tierHit(e) ? 422 : 500; // §13 / §13.5 DB trigger `<CODE>:<rule>` (e.g. agent_tokens.model, 0004)
}

function logErr(name: string, e: unknown): void {
  const code = e instanceof ApiError ? e.code : ((e as { code?: unknown })?.code ?? (e as Error)?.name ?? "unknown");
  console.error(`[hub] dash ${name} failed`, String(code));
}

// User-facing message: ApiError messages are written for callers (validation, not found); anything else is generic.
function userMessage(e: unknown): string {
  const tier = tierHit(e);
  if (tier) return tierReadable(tier);
  if (e instanceof ApiError && e.status < 500) return e.message;
  return "Something went wrong. Try again; the error code is in the server log.";
}

async function base(): Promise<string> {
  return baseUrlFrom(process.env.AGENCY_BOARD_BASE_URL, await headers());
}

const uuid = z.uuid();

// ---------- add device ----------

const addSchema = z.object({
  machine_name: z.string().trim().regex(MACHINE_NAME_RE, "Machine name: letters, digits, dot, dash or underscore; starts with a letter or digit; max 64."),
  os: z.enum(DEVICE_OS as unknown as [DeviceOs, ...DeviceOs[]]),
  agents: z.array(z.enum(CONNECT_AGENTS as unknown as [AgentId, ...AgentId[]])).min(1, "Pick at least one agent."),
});

export async function addDeviceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = addSchema.safeParse({ machine_name: fd.get("machine_name"), os: fd.get("os"), agents: fd.getAll("agents") });
  if (!parsed.success) {
    await logAdminAction("device_issue_code", 422);
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { machine_name, os, agents } = parsed.data;
  const blocked = agents.filter((a) => !agentAllowedOnOs(a, os));
  if (blocked.length > 0) {
    await logAdminAction("device_issue_code", 422);
    return { ok: false, error: `${blocked.join(", ")} is not available on this OS. Untick it or pick another OS.` };
  }
  try {
    const r = await issueConnectCode({ machineName: machine_name, os, agents }, await base());
    await logAdminAction("device_issue_code", 200);
    revalidatePath(PATH);
    return { ok: true, connect: { ...r, machine: machine_name, os, agents } };
  } catch (e) {
    logErr("device_issue_code", e);
    await logAdminAction("device_issue_code", statusOf(e));
    return { ok: false, error: userMessage(e) };
  }
}

// ---------- rotate (table row or alert card) ----------

export async function rotateDeviceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const id = uuid.safeParse(fd.get("device_id"));
  const alertRaw = fd.get("alert_id");
  const alertId = alertRaw ? uuid.safeParse(alertRaw) : null;
  if (!id.success || (alertId && !alertId.success)) {
    await logAdminAction("device_rotate", 422);
    return { ok: false, error: "Invalid device." };
  }
  try {
    const dev = await deviceBasics(id.data);
    if (!dev) throw new ApiError(404, "NOT_FOUND", "Device not found.");
    const r = await rotateDevice(id.data, await base());
    if (alertId?.success) await closeAlert(alertId.data, "rotated");
    await logAdminAction("device_rotate", 200);
    revalidatePath(PATH);
    return { ok: true, connect: { ...r, machine: dev.machine, os: dev.os, agents: [] } };
  } catch (e) {
    logErr("device_rotate", e);
    await logAdminAction("device_rotate", statusOf(e));
    return { ok: false, error: userMessage(e) };
  }
}

// ---------- ConfirmDialog actions (errors surface via ?e=) ----------

function fail(code: DeviceErrorCode): never {
  redirect(`${PATH}?e=${code}`);
}

// Disable from an alert card: revoke the device and close the alert as 'disabled'.
export async function disableDeviceAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = uuid.safeParse(fd.get("device_id"));
  const alertId = uuid.safeParse(fd.get("alert_id"));
  if (!id.success || !alertId.success) {
    await logAdminAction("device_disable", 422);
    fail("invalid");
  }
  let err: DeviceErrorCode | null = null;
  try {
    await revokeDevice(id.data);
    await closeAlert(alertId.data, "disabled");
    await logAdminAction("device_disable", 200);
  } catch (e) {
    logErr("device_disable", e);
    await logAdminAction("device_disable", statusOf(e));
    err = statusOf(e) === 404 ? "not_found" : "failed";
  }
  revalidatePath(PATH);
  if (err) fail(err);
}

// Revoke from the devices table: typed machine name re-checked here.
export async function revokeDeviceAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = uuid.safeParse(fd.get("device_id"));
  if (!id.success) {
    await logAdminAction("device_revoke", 422);
    fail("invalid");
  }
  let dev: Awaited<ReturnType<typeof deviceBasics>> = null;
  try {
    dev = await deviceBasics(id.data);
  } catch (e) {
    logErr("device_revoke", e);
    await logAdminAction("device_revoke", 500);
    fail("failed");
  }
  if (!dev) {
    await logAdminAction("device_revoke", 404);
    fail("not_found");
  }
  if (String(fd.get("confirm") ?? "") !== dev.machine) {
    await logAdminAction("device_revoke", 422);
    fail("confirm_mismatch");
  }
  let err: DeviceErrorCode | null = null;
  try {
    await revokeDevice(id.data);
    await logAdminAction("device_revoke", 200);
  } catch (e) {
    logErr("device_revoke", e);
    await logAdminAction("device_revoke", statusOf(e));
    err = statusOf(e) === 404 ? "not_found" : "failed";
  }
  revalidatePath(PATH);
  if (err) fail(err);
}

export async function trustAlertAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = uuid.safeParse(fd.get("alert_id"));
  if (!id.success) {
    await logAdminAction("alert_trust", 422);
    fail("invalid");
  }
  let err: DeviceErrorCode | null = null;
  try {
    await trustAlert(id.data);
    await logAdminAction("alert_trust", 200);
  } catch (e) {
    logErr("alert_trust", e);
    await logAdminAction("alert_trust", statusOf(e));
    err = statusOf(e) === 404 ? "not_found" : "failed";
  }
  revalidatePath(PATH);
  if (err) fail(err);
}

// Device-less alerts (auth_burst): nothing to trust or rotate, so they are dismissed.
export async function dismissAlertAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = uuid.safeParse(fd.get("alert_id"));
  if (!id.success) {
    await logAdminAction("alert_dismiss", 422);
    fail("invalid");
  }
  let err: DeviceErrorCode | null = null;
  try {
    await dismissAlert(id.data);
    await logAdminAction("alert_dismiss", 200);
  } catch (e) {
    logErr("alert_dismiss", e);
    await logAdminAction("alert_dismiss", statusOf(e));
    err = statusOf(e) === 404 ? "not_found" : "failed";
  }
  revalidatePath(PATH);
  if (err) fail(err);
}

// Explicit button only: rendering the page never marks alerts read.
export async function markAllReadAction(): Promise<void> {
  await requireAdmin();
  let err = false;
  try {
    await markAllAlertsRead();
    await logAdminAction("alerts_mark_read", 200);
  } catch (e) {
    logErr("alerts_mark_read", e);
    await logAdminAction("alerts_mark_read", statusOf(e));
    err = true;
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard", "layout"); // nav badge
  if (err) fail("failed");
}

// ---------- roles ----------

const roleSchema = z.object({
  agent: z.string().refine(isAgentId, "unknown agent"),
  device_id: z.uuid(),
  role: z.enum(ROLES as unknown as [Role, ...Role[]]),
});

// Re-checks both confirmations server-side: promoting to director must name the identity that is demoted
// right now (stale page -> refuse), and promoting a restricted agent needs the warning acknowledgement.
export async function setRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const p = roleSchema.safeParse({ agent: fd.get("agent"), device_id: fd.get("device_id"), role: fd.get("role") });
  if (!p.success) {
    await logAdminAction("role_set", 422);
    return { ok: false, error: "Invalid role change." };
  }
  const { agent, device_id, role } = p.data;
  try {
    const ids = await listIdentities();
    const me = ids.find((i) => i.agent === agent && i.device_id === device_id);
    if (!me) throw new ApiError(404, "NOT_FOUND", "Identity not found. Refresh the page.");
    if (me.role === role && !me.role_is_default) return { ok: true, message: "No change." };
    if (role === "director") {
      const demote = directorToDemote(ids, { agent, device_id });
      const expected = demote ? identLabel(demote) : "";
      if (String(fd.get("ack_director") ?? "") !== expected) {
        await logAdminAction("role_set", 409);
        return { ok: false, error: "The current director changed since this page loaded. Refresh and try again." };
      }
    }
    if (needsRestrictedWarning(agent, me.role, role) && fd.get("ack_restricted") !== "1") {
      await logAdminAction("role_set", 422);
      return { ok: false, error: "Promoting a restricted agent needs the warning to be confirmed first." };
    }
    const r = await setRole(agent, device_id, role);
    await logAdminAction("role_set", 200);
    revalidatePath(PATH);
    return {
      ok: true,
      message: r.demoted ? `${identLabel(me)} is now ${role}; ${r.demoted} was demoted to lead.` : `${identLabel(me)} is now ${role}.`,
    };
  } catch (e) {
    logErr("role_set", e);
    await logAdminAction("role_set", statusOf(e));
    return { ok: false, error: userMessage(e) };
  }
}

// ---------- listen/wait interval (slider) ----------

// Fixed texts: nothing from the request is echoed back.
const LISTEN_INVALID = "Invalid interval.";
const LISTEN_SAVE_FAILED =
  "Could not save the interval. If migration 20261013000007 has not been applied yet, saving stays unavailable; the error code is in the server log.";

// agent@machine listen/wait check interval, 0..60 minutes, 0 = off. Validated again here: the client range input is a convenience only.
export async function setListenMinutesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireAdmin();
  const p = parseListenForm(fd);
  if (!p) {
    await logAdminAction("listen_minutes_set", 422);
    return { ok: false, error: LISTEN_INVALID };
  }
  try {
    const saved = await setListenMinutes(p.agent, p.device_id, p.minutes);
    await logAdminAction("listen_minutes_set", 200);
    revalidatePath(PATH);
    return { ok: true, message: saved === 0 ? "Saved: off." : `Saved: ${saved} min.` };
  } catch (e) {
    logErr("listen_minutes_set", e);
    await logAdminAction("listen_minutes_set", statusOf(e));
    return { ok: false, error: LISTEN_SAVE_FAILED };
  }
}
