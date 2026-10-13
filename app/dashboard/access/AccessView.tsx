import { TIMEZONE } from "../../../lib/config";
import { RESTRICTED_WARNING, type AuditView, type MatrixModel } from "../../../lib/dash/access";
import { Badge, Card, DataTable, EmptyState, Mono, PageHeader, TimeAgo, type BadgeTone } from "../_components";
import { AccessMatrix } from "./AccessMatrix.client";
import { AddProjectForm } from "./AddProjectForm.client";

const ACTION_TONE: Record<string, BadgeTone> = {
  grant: "ok",
  revoke: "neutral",
  role_set: "info",
  project_create: "neutral",
  project_rename: "neutral",
};

// Server-rendered body of /dashboard/access (data fetched by page.tsx).
export function AccessView({ model, rows }: { model: MatrixModel; rows: AuditView[] }) {
  return (
    <>
      <PageHeader tz={TIMEZONE} title="Access" subtitle="Who can see each confidential project. Every box starts unticked." />

      <section className="hub-access-rule" aria-labelledby="hub-access-rule-title">
        <h2 id="hub-access-rule-title" className="hub-access-rule__title">
          How access works
        </h2>
        <ul className="hub-access-rule__list">
          <li>
            An agent can read or write a confidential project only if its <strong>role permits it AND its box is ticked here</strong>.
          </li>
          <li>Every agent, including the director, starts unticked. Without a tick the project is invisible to it.</li>
          <li>Changes apply on the agent&apos;s next request. Every change is recorded in the audit list below.</li>
        </ul>
      </section>

      <Card
        title="Confidential projects"
        subtitle={`${model.rows.length} ${model.rows.length === 1 ? "identity" : "identities"} · ${model.columns.length} ${
          model.columns.length === 1 ? "project" : "projects"
        }`}
        flush
      >
        {model.rows.length === 0 ? (
          <div className="hub-access-pad">
            <EmptyState
              title="No identities yet"
              body="Identities appear here once an agent connects a device (or has a role set). Connect one from Devices."
            />
          </div>
        ) : model.columns.length === 0 ? (
          <div className="hub-access-pad">
            <EmptyState title="No confidential projects" body="Add one below. Its memories stay hidden from every agent until you tick a box." />
          </div>
        ) : (
          <AccessMatrix model={model} restrictedWarning={RESTRICTED_WARNING} />
        )}
      </Card>

      <Card title="Add confidential project" subtitle="Makes an existing or future project namespace confidential.">
        <p className="hub-access-explain">
          Every memory and task already under <Mono>project/&lt;slug&gt;</Mono> becomes hidden from all agents the moment you add the
          project, until you grant it to them here.
        </p>
        <AddProjectForm />
      </Card>

      <Card title="Recent changes" subtitle="Last 30 grant, role and project changes." flush className="hub-access-audit">
        <DataTable<AuditView>
          caption="Recent access changes, newest first"
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <div className="hub-access-pad">
              <EmptyState title="No changes yet" body="Grants, role changes and project edits will be listed here." />
            </div>
          }
          columns={[
            { key: "at", header: "Time", render: (r) => <TimeAgo at={r.at} />, width: "120px" },
            {
              key: "action",
              header: "Action",
              render: (r) => (
                <Badge variant="status" tone={ACTION_TONE[r.action] ?? "neutral"}>
                  {r.action.replace("_", " ")}
                </Badge>
              ),
              width: "140px",
            },
            { key: "target", header: "Target", render: (r) => r.target || "—", mono: true },
            { key: "detail", header: "Detail", render: (r) => r.detail || "—", hideNarrow: true },
          ]}
        />
      </Card>
    </>
  );
}
