"use server";

import { revalidatePath } from "next/cache";
import {
  actionErrorMessage,
  flagConfirmOk,
  flagConfirmWord,
  flagInputSchema,
  formFields,
  parseWith,
  revokeConfirmOk,
  revokeInputSchema,
} from "../../../lib/dash/access";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import { revokeAgent } from "../../../lib/devices";
import { setFlags } from "../../../lib/flags";

export type KillResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/dashboard/kill-switch";

// `on` is the desired state (explicit), `confirm` the typed word — both re-checked here.
export async function setFlagAction(fd: FormData): Promise<KillResult> {
  await requireAdmin();
  const p = parseWith(flagInputSchema, formFields(fd));
  if (!p.ok) {
    await logAdminAction("kill.flag", 422);
    return { ok: false, error: p.error };
  }
  const { flag, on, confirm } = p.value;
  if (!flagConfirmOk(flag, on, confirm)) {
    await logAdminAction("kill.flag", 422);
    return { ok: false, error: `Not changed: type ${flagConfirmWord(flag, on)} exactly to confirm.` };
  }
  try {
    const flags = await setFlags(flag === "dispatch" ? { dispatchPaused: on } : { writesFrozen: on });
    await logAdminAction(`kill.${flag}.${on ? "on" : "off"}`, 200);
    revalidatePath(PATH);
    const message =
      flag === "dispatch"
        ? flags.dispatchPaused
          ? "Dispatch paused. Agents now get 423 on claim and empty task lists."
          : "Dispatch resumed."
        : flags.writesFrozen
          ? "Writes frozen. Agents now get 423 on every write."
          : "Writes unfrozen.";
    return { ok: true, message };
  } catch (e) {
    const m = actionErrorMessage(e);
    await logAdminAction("kill.flag", m.status);
    return { ok: false, error: m.message };
  }
}

export async function revokeAgentAction(fd: FormData): Promise<KillResult> {
  await requireAdmin();
  const p = parseWith(revokeInputSchema, formFields(fd));
  if (!p.ok) {
    await logAdminAction("kill.revoke", 422);
    return { ok: false, error: p.error };
  }
  const { agent, confirm } = p.value;
  if (!revokeConfirmOk(agent, confirm)) {
    await logAdminAction("kill.revoke", 422);
    return { ok: false, error: `Not revoked: type ${agent} exactly to confirm.` };
  }
  try {
    const n = await revokeAgent(agent);
    await logAdminAction("kill.revoke", 200);
    revalidatePath("/dashboard", "layout");
    return {
      ok: true,
      message:
        n === 0
          ? `No active ${agent} tokens to revoke.`
          : `Revoked ${n} ${agent} token${n === 1 ? "" : "s"}. Their next request gets 401 REVOKED.`,
    };
  } catch (e) {
    const m = actionErrorMessage(e);
    await logAdminAction("kill.revoke", m.status);
    return { ok: false, error: m.message };
  }
}
