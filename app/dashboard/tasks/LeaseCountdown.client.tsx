"use client";

import { useEffect, useState } from "react";
import { formatFull } from "../_components/time";
import { describeLease, formatLease, leaseRemainingMs } from "./lease";

// Ticks every second from lease_expires_at. First render uses the server's clock (serverNow) so
// server and client markup match; the browser clock takes over after mount.
export function LeaseCountdown({ leaseExpiresAt, serverNow, tz }: { leaseExpiresAt: string; serverNow: number; tz: string }) {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remaining = leaseRemainingMs(leaseExpiresAt, now);
  if (remaining === null) return null;
  const expired = remaining <= 0;
  return (
    <span className={`tb-lease${expired ? " tb-lease--expired" : ""}`} title={`Lease ends ${formatFull(new Date(leaseExpiresAt), tz)}`}>
      {expired ? (
        <span className="hub-badge hub-badge--status hub-tone-warn">Lease expired</span>
      ) : (
        <>
          <span className="tb-lease__label">lease</span>
          <span className="hub-mono" aria-hidden="true">
            {formatLease(remaining)}
          </span>
          <span className="hub-sr-only">{describeLease(remaining)}</span>
        </>
      )}
    </span>
  );
}
