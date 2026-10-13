import { TIMEZONE } from "../../../lib/config";
import { flagConfirmWord } from "../../../lib/dash/access";
import { requireAdmin } from "../../../lib/dash/session";
import { getFlags } from "../../../lib/flags";
import { AGENTS } from "../../../lib/types";
import { Badge, Card, Mono, PageHeader } from "../_components";
import { FlagControl, RevokeControl } from "./KillSwitch.client";
import "./kill-switch.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Kill switch" };

export default async function KillSwitchPage() {
  await requireAdmin();
  const flags = await getFlags(); // failure -> ./error.tsx
  const anyOn = flags.dispatchPaused || flags.writesFrozen;

  return (
    <>
      <PageHeader tz={TIMEZONE} title="Kill switch" subtitle="Emergency stops for every agent. Each change takes effect on the agents' next request." />

      <div className={`hub-kill__banner${anyOn ? " hub-kill__banner--on" : ""}`} role="status">
        {anyOn ? (
          <>
            <strong>Emergency stop active:</strong>{" "}
            {[flags.dispatchPaused && "dispatch is paused", flags.writesFrozen && "writes are frozen"].filter(Boolean).join(" and ")}.
          </>
        ) : (
          <>All systems running. Nothing is paused or frozen.</>
        )}
      </div>

      <div className="hub-kill__grid">
        <Card
          title="Pause dispatch"
          tone={flags.dispatchPaused ? "danger" : undefined}
          className="hub-kill__card"
          actions={
            <Badge variant="status" tone={flags.dispatchPaused ? "danger" : "ok"}>
              {flags.dispatchPaused ? "Paused" : "Running"}
            </Badge>
          }
        >
          <p className="hub-kill__explain">
            Agents see an empty task list (<Mono>dispatch_paused: true</Mono>) and claiming a task returns <Mono>423</Mono>. Memory reads
            and writes keep working.
          </p>
          <FlagControl
            flag="dispatch"
            active={flags.dispatchPaused}
            word={flagConfirmWord("dispatch", !flags.dispatchPaused)}
            onLabel="Pause dispatch"
            offLabel="Resume dispatch"
            dialogTitle={flags.dispatchPaused ? "Resume dispatch?" : "Pause dispatch for every agent?"}
            dialogBody={
              flags.dispatchPaused
                ? "Agents will see open tasks again and can claim them on their next request."
                : "No agent can pick up new work: task lists come back empty and claims return 423 until you resume."
            }
          />
        </Card>

        <Card
          title="Freeze writes"
          tone={flags.writesFrozen ? "danger" : undefined}
          className="hub-kill__card"
          actions={
            <Badge variant="status" tone={flags.writesFrozen ? "danger" : "ok"}>
              {flags.writesFrozen ? "Frozen" : "Writable"}
            </Badge>
          }
        >
          <p className="hub-kill__explain">
            Every write (remember, forget, post, update, complete, handoff, approvals) returns <Mono>423</Mono>. Agents can still read
            and recall.
          </p>
          <FlagControl
            flag="writes"
            active={flags.writesFrozen}
            word={flagConfirmWord("writes", !flags.writesFrozen)}
            onLabel="Freeze writes"
            offLabel="Unfreeze writes"
            dialogTitle={flags.writesFrozen ? "Unfreeze writes?" : "Freeze writes for every agent?"}
            dialogBody={
              flags.writesFrozen
                ? "Agents will be able to write memories and update tasks again on their next request."
                : "Nothing can be saved or changed by any agent until you unfreeze. Reads keep working."
            }
          />
        </Card>
      </div>

      <Card title="Revoke one agent" className="hub-kill__card hub-kill__card--revoke">
        <p className="hub-kill__explain">
          Revokes every active token of one agent on every machine. Its next request returns <Mono>401 REVOKED</Mono>; reconnecting
          the device from Devices issues a new token.
        </p>
        <RevokeControl agents={AGENTS} />
      </Card>
    </>
  );
}
