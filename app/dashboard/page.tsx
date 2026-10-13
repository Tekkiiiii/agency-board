import { TIMEZONE } from "../../lib/config";
import Link from "next/link";
import type { ReactNode } from "react";
import { displayTaskTitle } from "../../lib/display";
import { liveIdentities, loadOverview, type BoardTask, type FleetRow, type RedAlert, type Section } from "../../lib/dash/fleet";
import { alertRuleText, alertSentence } from "../../lib/dash/devices";
import { requireAdmin } from "../../lib/dash/session";
import type { TaskStatus } from "../../lib/types";
import { Badge, Card, DataTable, EmptyState, ErrorState, Mono, PageHeader, StatusDot, TimeAgo, type Column } from "./_components";
import { decideApprovalAction, disableAlertAction, rotateAlertAction, trustAlertAction } from "./actions";
import { AlertList, ApprovalActions, type AlertItem } from "./needs-you.client";
import "./overview.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

const FLEET_TOP = 8;
const nf = new Intl.NumberFormat("en-US");

const STATUS_LABEL: Record<TaskStatus, string> = { open: "Open", claimed: "Claimed", blocked: "Blocked", done: "Done", failed: "Failed", cancelled: "Cancelled" };

function SectionError({ what, code }: { what: string; code: string }) {
  return <ErrorState className="ov-section-error" title={`${what} unavailable`} message="The rest of the page is live." reference={code} />;
}

function Stat({ label, s, render, href }: { label: string; s: Section<number> | Section<string>; render?: (v: number | string) => ReactNode; href?: string }) {
  const value = s.ok ? (render ? render(s.data) : typeof s.data === "number" ? nf.format(s.data) : s.data) : "—";
  return (
    <div className="ov-stat">
      <dt className="ov-stat__label">{href ? <Link href={href}>{label}</Link> : label}</dt>
      <dd className="ov-stat__value" title={s.ok ? undefined : `Could not load (${s.code})`}>
        {value}
        {!s.ok && <span className="ov-stat__unavailable">unavailable</span>}
      </dd>
    </div>
  );
}

function map<T, U>(s: Section<T>, f: (v: T) => U): Section<U> {
  return s.ok ? { ok: true, data: f(s.data) } : s;
}

export default async function OverviewPage() {
  await requireAdmin();
  const o = await loadOverview();

  const online = map(o.fleet, (f) => `${f.online}/${f.live}`);
  const pendingApprovals = map(o.approvals, (a) => a.total);
  const needsTotal =
    (o.approvals.ok ? o.approvals.data.total : 0) + (o.inbox.ok ? o.inbox.data : 0) + (o.alerts.ok ? o.alerts.data.total : 0);

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Overview" subtitle="Your agents, shared memory, and work in progress." />

      <dl className="ov-stats hub-card" aria-label="Summary">
        <Stat label="Agents online" s={online} href="/dashboard/fleet" />
        <Stat label="Tasks claimed now" s={o.claimedNow} href="/dashboard/tasks" />
        <Stat label="Pending approvals" s={pendingApprovals} href="/dashboard/approvals" />
        <Stat label="Memories" s={o.memories} href="/dashboard/memory" />
      </dl>

      <div className="ov-grid">
        <FleetSummary s={o.fleet} />
        <Card
          accent
          className="ov-needs-card"
          title={
            <span className="ov-title-count">
              Needs you <Badge variant="count" count={needsTotal} label="items need you" />
            </span>
          }
        >
          <NeedsYou o={o} total={needsTotal} />
        </Card>
      </div>

      <TaskBoard s={o.board} />
    </>
  );
}

function FleetSummary({ s }: { s: Section<{ rows: FleetRow[]; live: number; online: number }> }) {
  if (!s.ok) {
    return (
      <Card title="Fleet">
        <SectionError what="Fleet" code={s.code} />
      </Card>
    );
  }
  const live = liveIdentities(s.data.rows);
  const rows = live.slice(0, FLEET_TOP);
  const machines = new Set(live.map((r) => r.device_id)).size;
  const cols: Column<FleetRow>[] = [
    {
      key: "agent",
      header: "Agent",
      render: (r) => (
        <span className="ov-agent">
          <StatusDot status={r.status === "online" ? "online" : "offline"} />
          <Mono>{r.ident}</Mono>
        </span>
      ),
    },
    { key: "role", header: "Role", render: (r) => <Badge variant="role">{r.role}</Badge>, hideNarrow: true },
    {
      key: "task",
      header: "Current task",
      render: (r) => (r.task_title ? <span className="ov-clip">{displayTaskTitle(r.task_title)}</span> : <span className="hub-muted">Idle</span>),
      hideNarrow: true,
    },
    { key: "model", header: "Model", mono: true, render: (r) => r.model ?? <span className="hub-muted">—</span>, hideNarrow: true },
    { key: "seen", header: "Last seen", render: (r) => <TimeAgo at={r.last_seen} empty="never" /> },
  ];
  return (
    <Card
      title="Fleet"
      subtitle={live.length ? `${live.length} ${live.length === 1 ? "agent" : "agents"} across ${machines} ${machines === 1 ? "machine" : "machines"}` : undefined}
      actions={<Link href="/dashboard/fleet">View fleet</Link>}
      flush
    >
      <DataTable
        caption="Most recently active agents"
        columns={cols}
        rows={rows}
        rowKey={(r) => `${r.agent}|${r.device_id}`}
        rowHeader
        empty={
          <div className="ov-pad">
            <EmptyState title="No agents connected" body="Connect a machine from Devices to see its agents here." />
          </div>
        }
      />
      {live.length > 0 && (
        <p className="ov-foot">
          <span>
            {s.data.online} online · {live.length - s.data.online} offline
          </span>
          {live.length > FLEET_TOP && <Link href="/dashboard/fleet">+{live.length - FLEET_TOP} more</Link>}
        </p>
      )}
    </Card>
  );
}

function alertBody(a: RedAlert): ReactNode {
  const who = a.agent && a.machine ? `${a.agent}@${a.machine}` : (a.machine ?? a.agent);
  return (
    <div className="ov-need__text">
      <p className="ov-need__kind ov-need__kind--danger">Security alert</p>
      <p className="ov-need__title">
        {/* one alert-kind copy map (lib/dash/devices), shared with the Devices page */}
        {who && a.rule !== "auth_burst" ? (
          <>
            <Mono>{who}</Mono> {alertRuleText(a.rule, a.value)}
          </>
        ) : (
          alertSentence(a.rule, a.value, null)
        )}
      </p>
      <p className="ov-need__meta">
        {a.token_prefix && (
          <>
            Token <Mono>{a.token_prefix}…</Mono> ·{" "}
          </>
        )}
        <TimeAgo at={a.created_at} />
      </p>
    </div>
  );
}

function NeedsYou({ o, total }: { o: Awaited<ReturnType<typeof loadOverview>>; total: number }) {
  const errors = [
    !o.approvals.ok && <SectionError key="a" what="Approvals" code={o.approvals.code} />,
    !o.inbox.ok && <SectionError key="i" what="Agent inbox" code={o.inbox.code} />,
    !o.alerts.ok && <SectionError key="r" what="Alerts" code={o.alerts.code} />,
  ].filter(Boolean);
  const approvals = o.approvals.ok ? o.approvals.data : null;
  const alerts = o.alerts.ok ? o.alerts.data : null;
  const inbox = o.inbox.ok ? o.inbox.data : 0;
  const alertItems: AlertItem[] = (alerts?.rows ?? []).map((a) => ({
    id: a.id,
    machine: a.machine,
    hasDevice: !!a.device_id,
    body: alertBody(a),
  }));

  return (
    <div className="ov-needs-body">
      {errors}
      {total === 0 && errors.length === 0 && (
        <EmptyState title="Nothing needs you" body="No pending approvals, inbox items or red alerts." />
      )}

      {approvals && approvals.rows.length > 0 && (
        <ul className="ov-needs" aria-label="Pending approvals">
          {approvals.rows.map((a) => (
            <li key={a.id} className="ov-need">
              <div className="ov-need__text">
                <p className="ov-need__kind">Approval required</p>
                <p className="ov-need__title ov-need__question">{a.question}</p>
                <p className="ov-need__meta">
                  <Mono>{a.requested_by}</Mono> · <TimeAgo at={a.created_at} />
                  {a.task_title && (
                    <>
                      {" "}
                      · task <span className="ov-clip">{displayTaskTitle(a.task_title)}</span>
                    </>
                  )}
                </p>
              </div>
              <ApprovalActions id={a.id} question={a.question.slice(0, 80)} action={decideApprovalAction} />
            </li>
          ))}
        </ul>
      )}
      {approvals && approvals.total > approvals.rows.length && (
        <p className="ov-more">
          <Link href="/dashboard/approvals">All {approvals.total} pending approvals</Link>
        </p>
      )}

      {inbox > 0 && (
        <Link href="/dashboard/memory?tab=inbox" className="ov-inbox">
          <Badge variant="count" count={inbox} label="inbox items" />
          <span>
            Agent inbox: {inbox} {inbox === 1 ? "memory" : "memories"} waiting for review
          </span>
          <span aria-hidden="true">→</span>
        </Link>
      )}

      <AlertList items={alertItems} rotate={rotateAlertAction} disable={disableAlertAction} trust={trustAlertAction} />
      {alerts && alerts.total > alerts.rows.length && (
        <p className="ov-more">
          <Link href="/dashboard/devices">All {alerts.total} red alerts</Link>
        </p>
      )}
    </div>
  );
}

function leaseText(t: BoardTask): ReactNode {
  if (t.status !== "claimed" || !t.lease_expires_at) return null;
  const expired = Date.parse(t.lease_expires_at) < Date.now();
  return expired ? (
    <Badge variant="status" tone="warn">
      lease expired
    </Badge>
  ) : (
    <span>
      lease ends <TimeAgo at={t.lease_expires_at} />
    </span>
  );
}

function TaskBoard({ s }: { s: Section<{ counts: Record<TaskStatus, number>; newest: BoardTask[] }> }) {
  return (
    <Card title="Task board" actions={<Link href="/dashboard/tasks">View all tasks</Link>}>
      {!s.ok ? (
        <SectionError what="Tasks" code={s.code} />
      ) : (
        <div className="ov-board">
          <dl className="ov-board__counts" aria-label="Tasks by status">
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((st) => (
              <div key={st} className={`ov-count ov-count--${st}`} data-nonzero={s.data.counts[st] > 0 ? "" : undefined}>
                <dt>{STATUS_LABEL[st]}</dt>
                <dd>{nf.format(s.data.counts[st])}</dd>
              </div>
            ))}
          </dl>
          <div className="ov-board__newest">
            <h3 className="ov-subhead">Newest open, claimed and blocked</h3>
            {s.data.newest.length === 0 ? (
              <EmptyState title="No open tasks" body="Tasks posted by agents show up here until they are done." />
            ) : (
              <ul className="ov-tasks">
                {s.data.newest.map((t) => (
                  <li key={t.id} className="ov-task">
                    <div className="ov-task__main">
                      <p className="ov-task__title">{displayTaskTitle(t.title)}</p>
                      <p className="ov-task__meta">
                        <Mono>{t.namespace}</Mono> · <TimeAgo at={t.created_at} />
                      </p>
                    </div>
                    <div className="ov-task__side">
                      <Badge variant="status" tone={t.status === "claimed" ? "info" : t.status === "blocked" ? "warn" : "neutral"}>
                        {STATUS_LABEL[t.status]}
                      </Badge>
                      {t.status === "claimed" && t.claimed_by_agent && <Mono>{t.claimed_by_agent}</Mono>}
                      {(t.status === "open" || t.status === "blocked") && t.handoff_to && (
                        <span>
                          for <Mono>{t.handoff_to}</Mono>
                        </span>
                      )}
                      {leaseText(t)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
