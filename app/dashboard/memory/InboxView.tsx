import { listInbox } from "../../../lib/dash/memory";
import { Badge } from "../_components/Badge";
import { Card } from "../_components/Card";
import { EmptyState } from "../_components/EmptyState";
import { Mono } from "../_components/Mono";
import { TimeAgo } from "../_components/TimeAgo";
import { InboxReview } from "./MemoryActions.client";

// Pending shared/inbox rows (restricted, inbox-only writers). Content is untrusted text written
// by an agent: rendered as escaped plain text, never as markup.
export async function InboxView() {
  const items = await listInbox();
  if (!items.length) {
    return (
      <Card>
        <EmptyState title="Inbox is clear" body="Nothing is waiting for review. Restricted (inbox-only) agents land their memories here first." />
      </Card>
    );
  }
  return (
    <section className="mem-inbox" aria-label="Pending inbox items">
      <p className="hub-muted mem-inbox__count">
        {items.length} pending, oldest first. Approving copies the memory into the target namespace; the confidential routing guard applies.
      </p>
      {items.map((m) => {
        const flagged = m.flags.includes("instruction-like");
        return (
          <Card
            key={m.id}
            accent={!flagged}
            tone={flagged ? "warn" : undefined}
            headingLevel={2}
            title={<span className="hub-mono mem-detail__slug">{m.slug}</span>}
            subtitle={
              <span className="mem-detail__sub">
                <Mono>
                  {m.author_agent}@{m.author_device ?? "unknown"}
                </Mono>
                <span className="hub-muted">
                  <TimeAgo at={m.created_at} />
                </span>
              </span>
            }
          >
            <div className="mem-inbox__meta">
              <span>
                <span className="hub-muted">Wants to go to </span>
                {m.target_namespace ? <Mono>{m.target_namespace}</Mono> : <span className="hub-muted">no target (set one below)</span>}
              </span>
              {m.flags.map((f) => (
                <Badge key={f} variant="status" tone={f === "instruction-like" ? "warn" : "neutral"}>
                  {f}
                </Badge>
              ))}
            </div>
            {flagged && (
              <p className="mem-inbox__warn">
                <strong>Instruction-like content.</strong> This text reads like commands aimed at an agent. Approve only if it is genuine
                knowledge.
              </p>
            )}
            <pre className="mem-content mem-content--inbox">{m.content}</pre>
            <InboxReview id={m.id} target={m.target_namespace} />
          </Card>
        );
      })}
    </section>
  );
}
