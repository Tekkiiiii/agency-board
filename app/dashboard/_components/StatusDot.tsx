export type DotStatus = "online" | "idle" | "offline" | "warn" | "unknown";

const TEXT: Record<DotStatus, string> = { online: "Online", idle: "Idle", offline: "Offline", warn: "Attention", unknown: "Unknown" };

// Colour is never the only signal: the label is always in the accessible name (visible if showLabel).
export function StatusDot({ status, label, showLabel }: { status: DotStatus; label?: string; showLabel?: boolean }) {
  const text = label ?? TEXT[status];
  return (
    <span className="hub-dot-wrap" title={text}>
      <span className={`hub-dot hub-dot--${status}`} aria-hidden="true" />
      <span className={showLabel ? "hub-dot__label" : "hub-sr-only"}>{text}</span>
    </span>
  );
}
