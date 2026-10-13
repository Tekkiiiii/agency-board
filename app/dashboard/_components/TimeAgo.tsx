import { TIMEZONE } from "../../../lib/config";
import { formatFull, relative, toDate } from "./time";

// Server-rendered relative time ("5m ago") with the exact timestamp (configured timezone, AGENCY_BOARD_TIMEZONE) as tooltip.
// Refreshes with the page (AutoRefresh), so no client ticking per cell.
export function TimeAgo({ at, empty = "—" }: { at: string | number | Date | null | undefined; empty?: string }) {
  const d = toDate(at);
  // "never" is a time value (mono, like the rest of the column); a bare "—" stays plain muted.
  if (!d) return <span className={empty === "—" ? "hub-muted" : "hub-time hub-muted"}>{empty}</span>;
  const full = formatFull(d, TIMEZONE);
  return (
    <time className="hub-time" dateTime={d.toISOString()} title={full}>
      {relative(d, new Date(), TIMEZONE)}
    </time>
  );
}
