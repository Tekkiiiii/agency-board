// Pure lease-countdown helpers. No imports: shared by the server page, the ticking client component
// and tests (client files may not import from lib/, §16).

/** Milliseconds until the lease expires (negative when expired), or null when there is no valid lease. */
export function leaseRemainingMs(leaseExpiresAt: string | null | undefined, now: number): number | null {
  if (!leaseExpiresAt) return null;
  const at = Date.parse(leaseExpiresAt);
  return Number.isFinite(at) ? at - now : null;
}

/**
 * Countdown text: "09:42" under an hour, "1:02:03" from an hour, "expired" at or past zero.
 * Seconds are rounded up so the display never shows 00:00 while time is still left.
 */
export function formatLease(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "expired";
  const total = Math.ceil(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Screen-reader text for the countdown ("9 minutes 42 seconds left"). */
export function describeLease(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "lease expired";
  const total = Math.ceil(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h && `${h} hour${h === 1 ? "" : "s"}`, m && `${m} minute${m === 1 ? "" : "s"}`, s && `${s} second${s === 1 ? "" : "s"}`].filter(Boolean);
  return `${parts.join(" ")} left on lease`;
}
