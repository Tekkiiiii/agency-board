import type { AgentId } from "../types";

// Client-safe listen/wait slider helpers: NO server imports (this file is bundled into devices.client.tsx; lib/agentSettings
// pulls in the service-role db client). The numbers mirror lib/agentSettings LISTEN_* and are pinned equal by tests/dash-listen.test.ts.
export const UI_MIN = 0;
export const UI_MAX = 60;
export const UI_DEFAULT = 30;

/** Agents whose machines run the hooks behind /listen and /wait. Hermes and grok have no hooks, so no slider. */
export const LISTEN_AGENTS: readonly AgentId[] = ["claude", "codex"] as const;

export function hasListenSlider(agent: string): boolean {
  return (LISTEN_AGENTS as readonly string[]).includes(agent);
}

/** Live label next to the slider: "Off" at 0, otherwise "N min". */
export function listenLabel(minutes: number): string {
  return minutes === 0 ? "Off" : `${minutes} min`;
}

/** Slider input value -> integer 0..60. Non-numeric input falls back to the default. */
export function sliderMinutes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return UI_DEFAULT;
  return Math.min(UI_MAX, Math.max(UI_MIN, Math.round(n)));
}

/** Same key shape as listListenMinutes. */
export function listenKey(agent: string, deviceId: string): string {
  return `${agent}:${deviceId}`;
}
