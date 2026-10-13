import { DEVICE_AGENTS, isRestricted, TIMEZONE } from "../../../lib/config";
import Link from "next/link";
import { Badge, Card, DataTable, EmptyState, ErrorState, Mono, PageHeader, TimeAgo, type Column } from "../_components";
import { ConfirmDialog } from "../_components/client/ConfirmDialog";
import { SubmitButton } from "../_components/client/SubmitButton";
import {
  directorToDemote,
  identLabel,
  hasListenSlider,
  listenKey,
  loadDevicesPage,
  agentAllowedOnOs,
  loadListenMinutes,
  needsRestrictedWarning,
  RESTRICTED_WARNING,
  type AlertView,
  type DeviceView,
} from "../../../lib/dash/devices";
import { lastSeen } from "../../../lib/dash/fleet";
import { requireAdmin } from "../../../lib/dash/session";
import { listIdentities, type IdentityRow } from "../../../lib/roles";
import { LISTEN_DEFAULT } from "../../../lib/agentSettings";
import { ROLES, type Role } from "../../../lib/types";
import {
  disableDeviceAction,
  dismissAlertAction,
  markAllReadAction,
  revokeDeviceAction,
  trustAlertAction,
  type DeviceErrorCode,
} from "./actions";
import { AddDeviceForm, ListenControl, RoleControl, RotateControl } from "./devices.client";
import "./devices.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Devices" };

const OS_LABEL: Record<string, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

const ERRORS: Record<DeviceErrorCode, string> = {
  failed: "That action failed. Nothing changed; try again.",
  not_found: "That device or alert no longer exists.",
  confirm_mismatch: "The typed machine name did not match, so the device was not revoked.",
  invalid: "That request was not valid.",
};

function errorText(e: unknown): string | null {
  return typeof e === "string" && e in ERRORS ? ERRORS[e as DeviceErrorCode] : null;
}

// Section loads are isolated so one failing query (e.g. migration 20261007000002 not applied yet, which
// breaks identities) shows an inline error card while the rest of the page still works.
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    console.error("[hub] devices page load failed", String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? "unknown"));
    return { ok: false };
  }
}

function LoadError({ what }: { what: string }) {
  return (
    <ErrorState
      title={`${what.charAt(0).toUpperCase()}${what.slice(1)} unavailable`}
      message="If the roles migration (20261007000002) has not been applied yet, this section stays empty until it is. The error code is in the server log. The rest of the page is live."
    />
  );
}

export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const sp = await searchParams;
  const [main, ids] = await Promise.all([settle(loadDevicesPage()), settle(listIdentities())]);
  const notice = errorText(sp.e);
  // Never throws: a missing agent_settings table (migration 20261013000007 not applied) just means every slider shows the default.
  const listen = ids.ok ? await loadListenMinutes(ids.value) : new Map<string, number>();

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Devices" subtitle="Machines, their tokens and alerts, and who may do what." />
      {notice && (
        <p className="hub-notice hub-notice--danger dv-banner" role="alert">
          {notice}{" "}
          <Link href="/dashboard/devices" className="dv-banner__close">
            Dismiss
          </Link>
        </p>
      )}
      {main.ok ? (
        <>
          <AlertsSection alerts={main.value.alerts} />
          <DevicesSection devices={main.value.devices} />
        </>
      ) : (
        <Card title="Devices">
          <LoadError what="devices and alerts" />
        </Card>
      )}
      <Card
        title={<span id="add-device">Add a device</span>}
        subtitle="Issue a single-use connect code (valid 10 minutes), then run the command on that machine."
      >
        <AddDeviceForm
          agents={DEVICE_AGENTS.map((id) => ({ id, restricted: isRestricted(id), windowsBlocked: !agentAllowedOnOs(id, "windows") }))}
        />
      </Card>
      <IdentitiesSection ids={ids.ok ? ids.value : null} listen={listen} />
    </>
  );
}

// ---------- alerts ----------

function AlertsSection({ alerts }: { alerts: AlertView[] }) {
  const unread = alerts.filter((a) => !a.read_at).length;
  // Badge = open HIGH alerts, the same count as the nav Devices badge and the overview "Needs you" card.
  const high = alerts.filter((a) => a.severity === "red").length;
  return (
    <Card
      title={
        <span className="dv-title-count">
          Alerts <Badge variant="count" count={high} label="open high alerts" />
        </span>
      }
      subtitle={alerts.length ? `${alerts.length} open · ${unread} unread` : undefined}
      actions={
        unread > 0 ? (
          <form action={markAllReadAction}>
            <SubmitButton variant="secondary" size="sm" pendingLabel="Marking…">
              Mark all read
            </SubmitButton>
          </form>
        ) : undefined
      }
    >
      {alerts.length === 0 ? (
        <EmptyState title="No open alerts" body="New countries, new networks, alternating networks and sign-in bursts show up here." />
      ) : (
        <ul className="dv-alerts" aria-label="Open alerts">
          {alerts.map((a) => (
            <AlertItem key={a.id} a={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AlertItem({ a }: { a: AlertView }) {
  const red = a.severity === "red";
  return (
    <li className={`dv-alert dv-alert--${red ? "red" : "yellow"}${a.read_at ? "" : " dv-alert--unread"}`}>
      <div className="dv-alert__body">
        <div className="dv-alert__top">
          <Badge variant="status" tone={red ? "danger" : "warn"}>
            {red ? "High" : "Watch"}
          </Badge>
          {!a.read_at && <Badge variant="status">Unread</Badge>}
        </div>
        <p className="dv-alert__text">
          {a.subject && a.rule !== "auth_burst" ? (
            <>
              <Mono>{a.subject}</Mono> {a.rule_text}
            </>
          ) : (
            a.sentence
          )}
        </p>
        <p className="dv-alert__meta">
          {a.machine && (
            <>
              Device <Mono>{a.machine}</Mono>
              <span aria-hidden="true"> · </span>
            </>
          )}
          {a.token_prefix && (
            <>
              Token <Mono>{a.token_prefix}…</Mono>
              <span aria-hidden="true"> · </span>
            </>
          )}
          <TimeAgo at={a.created_at} />
        </p>
      </div>
      <div className="dv-alert__actions">
        {a.device_id && a.machine ? (
          <>
            <RotateControl deviceId={a.device_id} machine={a.machine} alertId={a.id} />
            <ConfirmDialog
              triggerLabel="Disable"
              triggerVariant="danger"
              title={`Disable ${a.machine}?`}
              description={
                <>
                  Revokes the device and every token on it now. Agents on <span className="hub-mono">{a.machine}</span> lose access until you
                  reconnect it with a new code.
                </>
              }
              confirmLabel="Disable device"
              confirmVariant="danger"
              pendingLabel="Disabling…"
              action={disableDeviceAction}
              fields={{ device_id: a.device_id, alert_id: a.id }}
            />
            <ConfirmDialog
              triggerLabel="Trust"
              title="Trust this and close the alert?"
              description={
                a.rule === "new_country"
                  ? `Adds ${a.value} to the known countries for ${a.machine}; future use from there will not alert.`
                  : `Adds the network(s) to the known list for ${a.machine}; future use from them will not alert.`
              }
              confirmLabel="Trust"
              pendingLabel="Saving…"
              action={trustAlertAction}
              fields={{ alert_id: a.id }}
            />
          </>
        ) : (
          <ConfirmDialog
            triggerLabel="Dismiss"
            title="Dismiss this alert?"
            description="Failed sign-ins are not tied to a device, so there is nothing to rotate or trust. Dismissing closes the alert."
            confirmLabel="Dismiss"
            pendingLabel="Dismissing…"
            action={dismissAlertAction}
            fields={{ alert_id: a.id }}
          />
        )}
      </div>
    </li>
  );
}

// ---------- devices ----------

function Chips({ items, mono, empty = "—" }: { items: string[]; mono?: boolean; empty?: string }) {
  if (items.length === 0) return <span className="hub-muted">{empty}</span>;
  const shown = items.slice(0, 3);
  return (
    <span className="dv-chips" title={items.join(", ")}>
      {shown.map((v) => (
        <span key={v} className={`dv-chip${mono ? " hub-mono" : ""}`}>
          {v}
        </span>
      ))}
      {items.length > shown.length && <span className="hub-muted dv-more">+{items.length - shown.length}</span>}
    </span>
  );
}

function DevicesSection({ devices }: { devices: DeviceView[] }) {
  const columns: Column<DeviceView>[] = [
    {
      key: "machine",
      header: "Machine",
      render: (d) => (
        <span className="dv-machine">
          <Mono className="dv-machine__name">{d.machine}</Mono>
          <span className="dv-machine__agents">{d.agents.length ? d.agents.join(" · ") : "no live tokens"}</span>
        </span>
      ),
    },
    { key: "os", header: "OS", render: (d) => (d.os ? OS_LABEL[d.os] : <span className="hub-muted">—</span>) },
    { key: "seen", header: "Last seen", render: (d) => <TimeAgo at={d.last_seen_at} empty="never" /> },
    {
      key: "where",
      header: "Last IP / location",
      label: "Last IP",
      render: (d) =>
        d.last ? (
          <span className="dv-where">
            <Mono>{d.last.ip ?? "—"}</Mono>
            <span className="dv-where__geo">{[d.last.city, d.last.country].filter(Boolean).join(", ") || "—"}</span>
          </span>
        ) : (
          <span className="hub-muted">—</span>
        ),
    },
    { key: "countries", header: "Known countries", hideNarrow: true, render: (d) => <Chips items={d.known_countries} mono /> },
    { key: "networks", header: "Known networks", hideNarrow: true, render: (d) => <Chips items={d.known_networks} mono /> },
    {
      key: "state",
      header: "State",
      render: (d) =>
        d.revoked_at ? (
          <Badge variant="status" tone="danger">
            Revoked
          </Badge>
        ) : (
          <Badge variant="status" tone="ok">
            Active
          </Badge>
        ),
    },
    {
      key: "actions",
      header: <span className="hub-sr-only">Actions</span>,
      align: "right",
      render: (d) => (
        <span className="dv-row-actions">
          <RotateControl deviceId={d.id} machine={d.machine} label={d.revoked_at ? "Reconnect" : "Rotate"} />
          {!d.revoked_at && (
            <ConfirmDialog
              triggerLabel="Revoke"
              triggerVariant="danger"
              title={`Revoke ${d.machine}?`}
              description="Revokes the device and every token on it now. To bring it back, issue a new connect code with the same machine name."
              confirmLabel="Revoke device"
              confirmVariant="danger"
              pendingLabel="Revoking…"
              typedConfirmation={d.machine}
              action={revokeDeviceAction}
              fields={{ device_id: d.id }}
            />
          )}
        </span>
      ),
    },
  ];
  const active = devices.filter((d) => !d.revoked_at).length;
  return (
    <Card title="Devices" subtitle={devices.length ? `${active} active · ${devices.length - active} revoked` : undefined} flush className="dv-tablecard">
      <DataTable
        caption="Connected machines"
        columns={columns}
        rows={devices}
        rowKey={(d) => d.id}
        rowHeader
        rowClassName={(d) => (d.revoked_at ? "dv-row--revoked" : undefined)}
        stack
        empty={
          <EmptyState
            title="No devices yet"
            body="Issue a connect code below and run the command on the machine."
          />
        }
      />
    </Card>
  );
}

// ---------- identities ----------

function IdentitiesSection({ ids, listen }: { ids: IdentityRow[] | null; listen: Map<string, number> }) {
  if (ids === null) {
    return (
      <Card title="Identities and roles">
        <LoadError what="identities and roles" />
      </Card>
    );
  }
  const columns: Column<IdentityRow>[] = [
    {
      key: "ident",
      header: "Identity",
      render: (i) => (
        <span className="dv-ident">
          <Mono>{identLabel(i)}</Mono>
          {i.revoked && <span className="dv-ident__off">revoked</span>}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "260px",
      render: (i) => (
        <RoleControl
          agent={i.agent}
          deviceId={i.device_id}
          ident={identLabel(i)}
          role={i.role}
          roleIsDefault={i.role_is_default}
          demoteLabel={(() => {
            const d = directorToDemote(ids, i);
            return d ? identLabel(d) : null;
          })()}
          restrictedWarnFor={(ROLES as readonly Role[]).filter((r) => needsRestrictedWarning(i.agent, i.role, r))}
          warning={RESTRICTED_WARNING}
        />
      ),
    },
    {
      key: "listen",
      header: "Listen / wait",
      width: "300px",
      render: (i) => {
        if (!hasListenSlider(i.agent)) {
          return (
            <span className="hub-muted" title="This agent has no hooks, so /listen and /wait do not apply">
              <span aria-hidden="true">—</span>
              <span className="hub-sr-only">Not available: this agent has no hooks</span>
            </span>
          );
        }
        const stored = listen.get(listenKey(i.agent, i.device_id));
        return (
          <ListenControl
            agent={i.agent}
            deviceId={i.device_id}
            ident={identLabel(i)}
            minutes={stored ?? LISTEN_DEFAULT}
            isDefault={stored === undefined}
          />
        );
      },
    },
    {
      key: "grants",
      header: "Grants",
      render: (i) =>
        i.grants.length ? (
          <span className="dv-chips">
            {i.grants.map((g) => (
              <Badge key={g} variant="role">
                {g}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="hub-muted">—</span>
        ),
    },
    { key: "token", header: "Token", hideNarrow: true, render: (i) => (i.token_prefix ? <Mono>{i.token_prefix}…</Mono> : <span className="hub-muted">—</span>) },
    { key: "model", header: "Model", hideNarrow: true, render: (i) => (i.model ? <Mono>{i.model}</Mono> : <span className="hub-muted">—</span>) },
    {
      key: "seen",
      header: "Last seen",
      // Same source as Fleet: the later of heartbeat and last token use.
      render: (i) => (
        <span className="dv-seen">
          <TimeAgo at={lastSeen(i)} empty="never" />
          {!i.last_heartbeat_at && i.last_used_at && <span className="dv-seen__note">no heartbeat yet</span>}
        </span>
      ),
    },
  ];
  return (
    <Card
      title="Identities and roles"
      subtitle="One director at a time. Roles set dispatch, review and forget rights; confidential access is on the Access page. Listen / wait: how often a /listen or /wait session checks the board, in minutes (0 = off, default 30)."
      flush
      className="dv-tablecard"
    >
      <DataTable
        caption="Agent identities with role, grants and last seen"
        columns={columns}
        rows={ids}
        rowKey={(i) => `${i.agent}|${i.device_id}`}
        rowHeader
        stack
        empty={<EmptyState title="No identities yet" body="An identity appears once an agent connects with a code." />}
      />
    </Card>
  );
}
