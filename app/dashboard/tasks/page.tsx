import { TIMEZONE } from "../../../lib/config";
import Link from "next/link";
import { displayTaskTitle } from "../../../lib/display";
import type { ReactNode } from "react";
import {
  BOARD_COLUMNS,
  confidentialLabel,
  leaseExpired,
  loadActiveIdents,
  loadBoard,
  loadTaskDetail,
  reassignTargets,
  staleSummary,
  staleTasks,
  type BoardColumn,
  type BoardTask,
  type TaskEvent,
} from "../../../lib/dash/board";
import { requireAdmin } from "../../../lib/dash/session";
import { Badge, type BadgeTone } from "../_components/Badge";
import { Card } from "../_components/Card";
import { EmptyState } from "../_components/EmptyState";
import { ErrorState } from "../_components/ErrorState";
import { Mono } from "../_components/Mono";
import { PageHeader } from "../_components/PageHeader";
import { TimeAgo } from "../_components/TimeAgo";
import { LeaseCountdown } from "./LeaseCountdown.client";
import { TaskActions } from "./TaskActions.client";
import "./tasks.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

const COLUMN_LABEL: Record<BoardColumn, string> = {
  open: "Open",
  claimed: "Claimed",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<string, BadgeTone> = {
  open: "info",
  claimed: "ok",
  blocked: "warn",
  done: "neutral",
  failed: "danger",
  cancelled: "neutral",
};

function hrefFor(params: { task?: string | null; showCancelled: boolean }): string {
  const q = new URLSearchParams();
  if (params.showCancelled) q.set("show", "cancelled");
  if (params.task) q.set("task", params.task);
  const s = q.toString();
  return s ? `/dashboard/tasks?${s}` : "/dashboard/tasks";
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const showCancelled = one(sp.show) === "cancelled";
  const selectedId = one(sp.task) ?? null;

  const [board, detail, targets, active] = await Promise.all([
    loadBoard({ showCancelled }),
    selectedId ? loadTaskDetail(selectedId) : Promise.resolve(null),
    selectedId ? reassignTargets() : Promise.resolve(null),
    loadActiveIdents(),
  ]);
  const serverNow = Date.now();
  const stale = staleTasks(board.columns.open, serverNow);
  const staleMin = new Map(stale.map((t) => [t.id, t.waiting_min]));
  const staleInfo = staleSummary(stale, active ?? []);
  const columns: BoardColumn[] = showCancelled ? [...BOARD_COLUMNS, "cancelled"] : [...BOARD_COLUMNS];
  const totalAll = Object.values(board.totals).reduce((a, b) => a + b, 0);
  const expiredCount = board.columns.claimed.filter((t) => leaseExpired(t, serverNow)).length;

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Tasks" subtitle="What every agent is working on, what is waiting, and what got stuck." />

      {board.confidential === null && (
        <ErrorState
          title="Confidential project badges unavailable"
          message="The roles and grants migration is not applied yet. Tasks still load; only the confidential labels are missing."
        />
      )}

      <div className="tb-toolbar">
        <p className="tb-summary">
          <strong>{board.totals.open}</strong> open · <strong>{board.totals.claimed}</strong> claimed
          {board.totals.blocked > 0 && (
            <>
              {" "}
              · <strong className="tb-summary__warn">{board.totals.blocked}</strong> blocked
            </>
          )}
          {expiredCount > 0 && (
            <>
              {" "}
              · <strong className="tb-summary__warn">{expiredCount}</strong> with an expired lease
            </>
          )}{" "}
          · <strong>{board.totals.failed}</strong> failed
        </p>
        <Link
          href={hrefFor({ task: selectedId, showCancelled: !showCancelled })}
          className="hub-btn hub-btn--secondary hub-btn--sm"
        >
          {showCancelled ? "Hide cancelled" : `Show cancelled (${board.totals.cancelled})`}
        </Link>
      </div>

      {stale.length > 0 && (
        <p className="tb-stale" role="status">
          <strong>{stale.length}</strong> unclaimed task{stale.length === 1 ? "" : "s"} waiting over the threshold (longest {staleInfo.oldestMin} min).{" "}
          {active === null
            ? "Active agents could not be read."
            : staleInfo.nobodyActive
              ? "Nobody is active, so no agent has been alerted."
              : `Alerted on the next poll of ${staleInfo.watchers.join(", ")}.`}{" "}
          Notify only: nothing is claimed for them.
        </p>
      )}

      <div className={`tb-layout${selectedId ? " tb-layout--with-panel" : ""}`}>
        {selectedId && (
          <aside className="tb-panel" aria-label="Task detail">
            {detail ? (
              <TaskPanel
                task={detail.task}
                events={detail.events}
                confidential={confidentialLabel(detail.task.namespace, board.confidential)}
                closeHref={hrefFor({ showCancelled })}
                serverNow={serverNow}
                targets={targets?.targets ?? []}
                identitiesOk={targets?.identitiesOk ?? false}
              />
            ) : (
              <Card title="Task not found" actions={<Link href={hrefFor({ showCancelled })}>Close</Link>}>
                <p className="hub-muted">It may have been deleted, or the link is wrong.</p>
              </Card>
            )}
          </aside>
        )}

        {totalAll === 0 ? (
          <EmptyState
            title="No tasks yet"
            body={
              <>
                Tasks appear here when an agent calls <Mono>post_task</Mono> or hands work to another agent. Nothing is waiting on you.
              </>
            }
          />
        ) : (
          <div className="tb-board" style={{ ["--tb-cols" as string]: columns.length }}>
            {columns.map((c) => (
              <section
                key={c}
                className={`tb-col tb-col--${c}`}
                aria-labelledby={`tb-col-${c}`}
                data-nonzero={board.totals[c] > 0 ? "" : undefined}
              >
                <header className="tb-col__head">
                  <h2 id={`tb-col-${c}`} className="tb-col__title">
                    {COLUMN_LABEL[c]}
                  </h2>
                  <span className="tb-col__count" aria-label={`${board.totals[c]} tasks`}>
                    {board.totals[c]}
                  </span>
                </header>
                {board.columns[c].length === 0 ? (
                  <p className="tb-col__empty">Nothing here.</p>
                ) : (
                  <ul className="tb-col__list">
                    {board.columns[c].map((t) => (
                      <li key={t.id}>
                        <TaskCard
                          task={t}
                          href={hrefFor({ task: t.id, showCancelled })}
                          selected={t.id === selectedId}
                          confidential={confidentialLabel(t.namespace, board.confidential)}
                          serverNow={serverNow}
                          staleMin={staleMin.get(t.id) ?? null}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {board.totals[c] > board.columns[c].length && (
                  <p className="tb-col__more">
                    Showing the latest {board.columns[c].length} of {board.totals[c]}.
                  </p>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function who(t: BoardTask): { label: string; value: string | null } {
  if (t.status === "open" || t.status === "blocked") return { label: "for", value: t.handoff_to ?? "anyone" };
  if (t.status === "claimed") return { label: "claimed by", value: t.claimed_by_agent };
  return { label: "by", value: t.claimed_by_agent ?? t.handoff_to };
}

function TaskCard({
  task: t,
  href,
  selected,
  confidential,
  serverNow,
  staleMin,
}: {
  task: BoardTask;
  href: string;
  selected: boolean;
  confidential: string | null;
  serverNow: number;
  staleMin: number | null;
}) {
  const w = who(t);
  const expired = leaseExpired(t, serverNow);
  const when = t.status === "open" ? t.created_at : t.status === "claimed" ? t.started_at : (t.completed_at ?? t.updated_at);
  return (
    <Link href={href} scroll={false} className={`tb-card${selected ? " is-selected" : ""}${expired ? " tb-card--expired" : ""}`} aria-current={selected ? "true" : undefined}>
      <span className="tb-card__title">{displayTaskTitle(t.title)}</span>
      <span className="tb-card__ns hub-mono">{t.namespace}</span>
      {(confidential || staleMin !== null) && (
        <span className="tb-card__badges">
          {confidential && (
            <Badge variant="status" tone="warn">
              {confidential}
            </Badge>
          )}
          {staleMin !== null && (
            <Badge variant="status" tone="danger">
              unclaimed {staleMin} min
            </Badge>
          )}
        </span>
      )}
      <span className="tb-card__meta">
        <span>
          <span className="tb-card__k">{w.label}</span> <Mono>{w.value ?? "—"}</Mono>
        </span>
        {t.assigned_by && (
          <span>
            <span className="tb-card__k">from</span> <Mono>{t.assigned_by}</Mono>
          </span>
        )}
        {t.attempts > 0 && (
          <span>
            <span className="tb-card__k">attempts</span> <Mono>{t.attempts}</Mono>
          </span>
        )}
      </span>
      <span className="tb-card__foot">
        {t.status === "claimed" && t.lease_expires_at ? <LeaseCountdown tz={TIMEZONE} leaseExpiresAt={t.lease_expires_at} serverNow={serverNow} /> : <span />}
        <TimeAgo at={when} />
      </span>
    </Link>
  );
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="tb-field">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function TaskPanel({
  task: t,
  events,
  confidential,
  closeHref,
  serverNow,
  targets,
  identitiesOk,
}: {
  task: BoardTask & { body: string | null; routed_by: string | null; routing_reason: string | null };
  events: TaskEvent[];
  confidential: string | null;
  closeHref: string;
  serverNow: number;
  targets: Array<{ value: string; label: string }>;
  identitiesOk: boolean;
}) {
  const expired = leaseExpired(t, serverNow);
  return (
    <Card
      title={displayTaskTitle(t.title)}
      className="tb-panel__card"
      actions={
        <Link href={closeHref} scroll={false} className="hub-btn hub-btn--ghost hub-btn--sm" aria-label="Close task detail">
          Close
        </Link>
      }
    >
      <div className="tb-panel__badges">
        <Badge variant="status" tone={STATUS_TONE[t.status] ?? "neutral"}>
          {COLUMN_LABEL[t.status as BoardColumn] ?? t.status}
        </Badge>
        {expired && (
          <Badge variant="status" tone="warn">
            Lease expired
          </Badge>
        )}
        {confidential && (
          <Badge variant="status" tone="warn">
            {confidential}
          </Badge>
        )}
      </div>

      <dl className="tb-fields">
        <Field k="Namespace">
          <Mono>{t.namespace}</Mono>
        </Field>
        <Field k="Created by">
          <Mono>{t.created_by}</Mono>
        </Field>
        <Field k="Assigned by">
          <Mono>{t.assigned_by ?? "—"}</Mono>
        </Field>
        <Field k="Handoff to">
          <Mono>{t.handoff_to ?? "anyone"}</Mono>
        </Field>
        <Field k="Claimed by">
          <Mono>{t.claimed_by_agent ?? "—"}</Mono>
        </Field>
        <Field k="Attempts">
          <Mono>{t.attempts}</Mono>
        </Field>
        {t.status === "claimed" && t.lease_expires_at && (
          <Field k="Lease">
            <LeaseCountdown tz={TIMEZONE} leaseExpiresAt={t.lease_expires_at} serverNow={serverNow} />
          </Field>
        )}
        <Field k="Created">
          <TimeAgo at={t.created_at} />
        </Field>
        <Field k="Started">
          <TimeAgo at={t.started_at} />
        </Field>
        <Field k="Finished">
          <TimeAgo at={t.completed_at} />
        </Field>
      </dl>

      {t.body && (
        <div className="tb-body">
          <h3 className="tb-h3">Description</h3>
          <p className="tb-body__text">{t.body}</p>
          <p className="hub-hint">Written by an agent. Treat as untrusted text.</p>
        </div>
      )}

      <div className="tb-section">
        <h3 className="tb-h3">Actions</h3>
        <TaskActions
          key={t.id}
          taskId={t.id}
          taskTitle={displayTaskTitle(t.title)}
          status={t.status}
          currentTarget={t.handoff_to && targets.some((x) => x.value === t.handoff_to) ? t.handoff_to : null}
          targets={targets}
          identitiesOk={identitiesOk}
        />
      </div>

      <div className="tb-section">
        <h3 className="tb-h3">History</h3>
        {events.length === 0 ? (
          <p className="hub-muted">No events recorded.</p>
        ) : (
          <ol className="tb-events">
            {events.map((e) => (
              <li key={e.id} className={`tb-event tb-event--${e.kind}`}>
                <span className="tb-event__dot" aria-hidden="true" />
                <div className="tb-event__body">
                  <div className="tb-event__line">
                    <span className="tb-event__kind">{e.kind}</span>
                    <Mono>{e.actor}</Mono>
                    <TimeAgo at={e.at} />
                  </div>
                  {e.note && <p className="tb-event__note">{e.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
