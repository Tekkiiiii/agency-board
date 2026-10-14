import type { UpdateStatus } from "../../../lib/update/status";
import { syncUpdateAction } from "../update/actions";
import { ConfirmDialog } from "./client/ConfirmDialog";
import "../update/update.css";

// Admin-only banner above the dashboard pages (the layout already requires an admin session).
//   hidden     renders nothing, not even an empty node
//   setup      an update exists but one-click sync is not configured: a hint and the manual sync link, no button
//   available  notes + migration count + the Update button (confirm dialog) + the release link
// Release notes are untrusted GitHub text: rendered as a React text child inside <pre>, never as HTML or markdown.

function migrationLine(n: number | null): string {
  if (n === null) return "Pending migration count unknown";
  return `${n} database migration${n === 1 ? "" : "s"} will apply during the build`;
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function UpdateBanner({ status }: { status: UpdateStatus }) {
  if (status.state === "hidden") return null;

  if (status.state === "setup") {
    return (
      <section className="hub-update hub-update--hint" role="region" aria-label="Update available">
        <p className="hub-update__hint">
          {`v${status.latest} is available. To enable one-click updates, set AGENCY_BOARD_GITHUB_TOKEN (README, Updating), or sync your fork manually.`}
        </p>
        <p className="hub-update__links">
          <ExternalLink href={status.manualSyncUrl}>Sync your fork on GitHub</ExternalLink>
          <ExternalLink href={status.url}>Release notes</ExternalLink>
        </p>
      </section>
    );
  }

  const migrations = migrationLine(status.migrations);
  const notes = status.notes.trim();
  return (
    <section className="hub-update" role="region" aria-label="Update available">
      <div className="hub-update__head">
        <div className="hub-update__text">
          <p className="hub-update__title">{`Update available: v${status.current} to v${status.latest}`}</p>
          <p className="hub-update__meta">{migrations}.</p>
        </div>
        <div className="hub-update__actions">
          <ConfirmDialog
            triggerLabel="Update"
            triggerVariant="primary"
            triggerSize="md"
            title={`Update to v${status.latest}?`}
            description={
              <>
                <p>{`This updates agency-board from v${status.current} to v${status.latest}. ${migrations}.`}</p>
                <p>This syncs your fork on GitHub; Vercel then redeploys. It can take a minute or two.</p>
              </>
            }
            confirmLabel="Update now"
            pendingLabel="Syncing..."
            action={syncUpdateAction}
          />
        </div>
      </div>
      {notes && (
        <details className="hub-update__notes">
          <summary>Release notes</summary>
          <pre className="hub-update__pre" tabIndex={0}>
            {notes}
          </pre>
        </details>
      )}
      <p className="hub-update__links">
        <ExternalLink href={status.url}>View the release on GitHub</ExternalLink>
        <ExternalLink href={status.manualSyncUrl}>Sync manually instead</ExternalLink>
      </p>
    </section>
  );
}
