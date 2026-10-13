import type { ReactNode } from "react";

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="hub-empty" role="status">
      <p className="hub-empty__title">{title}</p>
      {body && <p className="hub-empty__body">{body}</p>}
      {action && <div className="hub-empty__action">{action}</div>}
    </div>
  );
}
