import { TIMEZONE } from "../../../lib/config";
import Link from "next/link";
import { displayTaskTitle } from "../../../lib/display";
import { confidentialLabel, loadApprovals, type ApprovalRow } from "../../../lib/dash/board";
import { requireAdmin } from "../../../lib/dash/session";
import { Badge, type BadgeTone } from "../_components/Badge";
import { Card } from "../_components/Card";
import { DataTable, type Column } from "../_components/DataTable";
import { EmptyState } from "../_components/EmptyState";
import { ErrorState } from "../_components/ErrorState";
import { Mono } from "../_components/Mono";
import { PageHeader } from "../_components/PageHeader";
import { TimeAgo } from "../_components/TimeAgo";
import { ApprovalForm } from "./ApprovalForm.client";
import "./approvals.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals" };

const DECIDED_TONE: Record<string, BadgeTone> = { approved: "ok", denied: "danger", expired: "neutral" };

function TaskLink({ row }: { row: ApprovalRow }) {
  if (!row.task_id) return <span className="hub-muted">No linked task</span>;
  return (
    <Link href={`/dashboard/tasks?task=${row.task_id}`} className="ap-task">
      {row.task_title ? displayTaskTitle(row.task_title) : "Task (deleted)"}
    </Link>
  );
}

export default async function ApprovalsPage() {
  await requireAdmin();
  const { pending, decided, confidential } = await loadApprovals();

  const columns: Column<ApprovalRow>[] = [
    {
      key: "status",
      header: "Status",
      width: "112px",
      render: (r) => (
        <Badge variant="status" tone={DECIDED_TONE[r.status] ?? "neutral"}>
          {r.status}
        </Badge>
      ),
    },
    { key: "question", header: "Question", render: (r) => <span className="ap-clip" title={r.question}>{r.question}</span> },
    {
      key: "answer",
      header: "Answer",
      render: (r) => (r.answer ? <span className="ap-clip" title={r.answer}>{r.answer}</span> : <span className="hub-muted">—</span>),
    },
    { key: "by", header: "Requested by", mono: true, hideNarrow: true, render: (r) => r.requested_by },
    { key: "task", header: "Task", hideNarrow: true, render: (r) => <TaskLink row={r} /> },
    {
      key: "decided_by",
      header: "Decided by",
      mono: true,
      hideNarrow: true,
      render: (r) => (r.decided_by ? r.decided_by : <span className="hub-muted">—</span>),
    },
    { key: "decided", header: "Decided", width: "120px", render: (r) => <TimeAgo at={r.decided_at} /> },
  ];

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Approvals" subtitle="Questions your agents are blocked on. Oldest first." />

      {confidential === null && (
        <ErrorState
          title="Confidential project badges unavailable"
          message="The roles and grants migration is not applied yet. Approvals still load; only the confidential labels are missing."
        />
      )}

      <Card
        accent={pending.length > 0}
        title={
          <span className="ap-title">
            Pending <Badge variant="count" count={pending.length} label="pending approvals" />
          </span>
        }
        subtitle={pending.length > 0 ? "Approve or deny. An answer is sent back to the agent that asked." : undefined}
      >
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting on you" body={<>When an agent calls <Mono>request_approval</Mono>, the question shows up here.</>} />
        ) : (
          <ul className="ap-list">
            {pending.map((a) => {
              const conf = a.task_namespace ? confidentialLabel(a.task_namespace, confidential) : null;
              return (
                <li key={a.id} className="ap-item">
                  <div className="ap-item__head">
                    <p className="ap-question">{a.question}</p>
                    <p className="ap-meta">
                      <Mono>{a.requested_by}</Mono>
                      <span aria-hidden="true">·</span>
                      <span>
                        asked <TimeAgo at={a.created_at} />
                      </span>
                      <span aria-hidden="true">·</span>
                      <TaskLink row={a} />
                      {conf && (
                        <Badge variant="status" tone="warn">
                          {conf}
                        </Badge>
                      )}
                    </p>
                  </div>
                  <ApprovalForm id={a.id} options={a.options} question={a.question} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Decided" subtitle="Last 50, newest first." flush>
        <DataTable
          caption="Decided approvals"
          columns={columns}
          rows={decided}
          rowKey={(r) => r.id}
          empty={
            <div className="ap-empty">
              <EmptyState title="No decisions yet" body="Approved and denied requests are listed here." />
            </div>
          }
        />
      </Card>
    </>
  );
}
