"use client";

import { RouteError } from "../_components/client/RouteError";
import "./kill-switch.css";

export default function KillSwitchError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteError
      title="Kill switch"
      subtitle="Emergency stops for every agent. Each change takes effect on the agents' next request."
      what="current flags"
      error={error}
      reset={reset}
      message={
        <p>
          The dashboard could not read <span className="hub-mono">system_flags</span>, so the current state of Pause dispatch and Freeze
          writes is unknown. Nothing was changed. Retry, or use <span className="hub-mono">scripts/admin.mjs flags</span> from a terminal.
        </p>
      }
    />
  );
}
