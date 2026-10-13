import { buildMatrix, toAuditView } from "../../../lib/dash/access";
import { requireAdmin } from "../../../lib/dash/session";
import { listAudit, listIdentities, listProjects } from "../../../lib/roles";
import { AccessView } from "./AccessView";
import "./access.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Access" };

export default async function AccessPage() {
  await requireAdmin();
  // Any failure (e.g. migration 20261007000002 not applied) is rendered by ./error.tsx.
  const [identities, projects, audit] = await Promise.all([listIdentities(), listProjects(), listAudit(30)]);
  return <AccessView model={buildMatrix(identities, projects)} rows={toAuditView(audit)} />;
}
