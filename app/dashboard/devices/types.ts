import type { AgentId } from "../../../lib/types";

// Shared between actions.ts (server) and *.client.tsx (types only).
export interface ConnectResult {
  code: string;
  expiresAt: string;
  commands: { mac: string; windows: string };
  machine: string;
  os: "mac" | "windows" | "linux" | null;
  agents: AgentId[];
}

export interface ActionState {
  ok: boolean;
  error?: string;
  message?: string;
  connect?: ConnectResult;
}

export const INITIAL_STATE: ActionState = { ok: false };
