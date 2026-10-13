import type { ReactNode } from "react";
import type { MemoryRow } from "../../../lib/dash/memory";
import { Badge } from "../_components/Badge";

// Status markers for a memory: retired, pinned, review status, flags (instruction-like = warn).
// No red here: red is reserved for danger (§17).
export function MemoryMarkers({ m }: { m: Pick<MemoryRow, "pinned" | "review_status" | "flags" | "deleted_at" | "superseded"> }) {
  const items: ReactNode[] = [];
  if (m.deleted_at) items.push(<Badge key="del" variant="status" tone="neutral">retired</Badge>);
  if (m.superseded) items.push(<Badge key="sup" variant="status" tone="neutral">superseded</Badge>);
  if (m.pinned) items.push(<Badge key="pin" variant="status" tone="info">pinned</Badge>);
  if (m.review_status) {
    const tone = m.review_status === "approved" ? "ok" : m.review_status === "pending" ? "warn" : "neutral";
    items.push(
      <Badge key="rev" variant="status" tone={tone}>
        {m.review_status}
      </Badge>,
    );
  }
  for (const f of m.flags) {
    items.push(
      <Badge key={`f-${f}`} variant="status" tone={f === "instruction-like" ? "warn" : "neutral"}>
        {f}
      </Badge>,
    );
  }
  if (!items.length) return null;
  return <div className="mem-markers">{items}</div>;
}
