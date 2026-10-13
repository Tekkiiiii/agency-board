import { TIMEZONE } from "../../../lib/config";
import Link from "next/link";
import { displayTaskTitle } from "../../../lib/display";
import { liveIdentities, loadFleet, type FleetRow } from "../../../lib/dash/fleet";
import { requireAdmin } from "../../../lib/dash/session";
import { Badge, Card, DataTable, EmptyState, Mono, PageHeader, StatusDot, TimeAgo, type Column } from "../_components";
import "../overview.css";
import "./fleet.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet" };

const STATUS = {
  online: { dot: "online", label: "Online" },
  offline: { dot: "offline", label: "Offline" },
  revoked: { dot: "unknown", label: "No live token" },
} as const;

function Scope({ r }: { r: FleetRow }) {
  const s = r.scope;
  return (
    <div className="fl-scope">
      <p>
        <span className="fl-scope__k">Read</span> <span className="hub-mono">{s.read}</span>
        {s.plusAssigned && <span className="hub-muted"> + assigned projects</span>}
      </p>
      <p>
        <span className="fl-scope__k">Write</span> <span className="hub-mono">{s.write}</span>
        {s.inboxOnly && <span className="hub-muted"> (inbox only)</span>}
      </p>
      <p>
        <span className="fl-scope__k">Grants</span>{" "}
        {s.grants.length ? (
          s.grants.map((g) => (
            <Badge key={g} variant="status" tone="info">
              {g}
            </Badge>
          ))
        ) : (
          <span className="hub-muted">—</span>
        )}
      </p>
    </div>
  );
}

const columns: Column<FleetRow>[] = [
  {
    key: "agent",
    header: "Agent",
    width: "18%",
    render: (r) => (
      <span className="fl-agent">
        <StatusDot status={STATUS[r.status].dot} label={STATUS[r.status].label} />
        <Mono>{r.ident}</Mono>
      </span>
    ),
  },
  {
    key: "role",
    header: "Role",
    render: (r) => (
      <span className="fl-role">
        <Badge variant="role">{r.role}</Badge>
        {r.role_is_default && <span className="hub-muted fl-small">default</span>}
      </span>
    ),
  },
  {
    key: "task",
    header: "Current task",
    render: (r) =>
      r.task_title ? (
        <span className="fl-clip" title={displayTaskTitle(r.task_title)}>
          {displayTaskTitle(r.task_title)}
        </span>
      ) : r.current_task_id ? (
        <span className="hub-muted">Working</span>
      ) : (
        <span className="hub-muted">Idle</span>
      ),
  },
  { key: "model", header: "Model", mono: true, render: (r) => r.model ?? <span className="hub-muted">—</span>, hideNarrow: true },
  {
    key: "note",
    header: "Status note",
    hideNarrow: true,
    render: (r) =>
      r.status_note ? (
        <span className="fl-clip" title={r.status_note}>
          {r.status_note}
        </span>
      ) : (
        <span className="hub-muted">—</span>
      ),
  },
  { key: "seen", header: "Last seen", render: (r) => <TimeAgo at={r.last_seen} empty="never" /> },
  { key: "scope", header: "Scope", width: "26%", hideNarrow: true, render: (r) => <Scope r={r} /> },
];

export default async function FleetPage() {
  await requireAdmin();
  const rows = await loadFleet();
  const live = liveIdentities(rows);
  const online = live.filter((r) => r.status === "online").length;
  const machines = new Set(live.map((r) => r.device_id)).size;

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Fleet" subtitle="Every agent identity, its role, and what it is doing." />
      <Card
        title="Identities"
        subtitle={
          rows.length
            ? `${online} online · ${live.length - online} offline · ${machines} ${machines === 1 ? "machine" : "machines"}`
            : undefined
        }
        actions={<Link href="/dashboard/devices">Manage devices and roles</Link>}
        flush
        className="fl-card"
      >
        <DataTable
          caption="Agent identities (agent@machine). Online means a heartbeat or request in the last 5 minutes."
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.agent}|${r.device_id}`}
          rowHeader
          stack
          rowClassName={(r) => (r.status === "revoked" ? "fl-row--revoked" : undefined)}
          empty={
            <div className="ov-pad">
              <EmptyState
                title="No agents connected"
                body="Identities appear after a machine connects with a connect code."
                action={<Link href="/dashboard/devices">Go to Devices</Link>}
              />
            </div>
          }
        />
      </Card>
    </>
  );
}
