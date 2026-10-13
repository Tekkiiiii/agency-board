import { TIMEZONE } from "../../../lib/config";
import type { ReactNode } from "react";
import Link from "next/link";
import { getMemoryDetail, type LinkView, type MemoryRow } from "../../../lib/dash/memory";
import { Badge } from "../_components/Badge";
import { Card } from "../_components/Card";
import { EmptyState } from "../_components/EmptyState";
import { Mono } from "../_components/Mono";
import { TimeAgo } from "../_components/TimeAgo";
import { formatFull, toDate } from "../_components/time";
import { MemoryMarkers } from "./Markers";
import { EditForm, PinButton, RemoveLinkButton, RetireButton } from "./MemoryActions.client";

const RELATION_LABEL: Record<string, string> = {
  supersedes: "Supersedes",
  part_of: "Part of",
  about_project: "About project",
  relates_to: "Relates to",
};

function Back() {
  return (
    <Link href="/dashboard/memory" className="mem-back">
      ← All memories
    </Link>
  );
}

function Full({ at }: { at: string | null }) {
  const d = toDate(at);
  if (!d) return <span className="hub-muted">—</span>;
  return (
    <span>
      <TimeAgo at={d} /> <span className="hub-mono hub-muted mem-full-time">{formatFull(d, TIMEZONE)}</span>
    </span>
  );
}

function Provenance({ m }: { m: MemoryRow }) {
  const rows: Array<[string, ReactNode]> = [
    ["ID", <Mono key="id">{m.id}</Mono>],
    ["Namespace", <Mono key="ns">{m.namespace}</Mono>],
    [
      "Author",
      <Mono key="a">
        {m.author_agent}@{m.author_device ?? "unknown"}
      </Mono>,
    ],
    ["Created", <Full key="c" at={m.created_at} />],
    ["Updated", <Full key="u" at={m.updated_at} />],
    ["Approved by", m.approved_by ? <Mono key="ab">{m.approved_by}</Mono> : <span className="hub-muted">—</span>],
    ["Review status", m.review_status ?? <span className="hub-muted">— (not reviewed)</span>],
    ["Target namespace", m.target_namespace ? <Mono key="t">{m.target_namespace}</Mono> : <span className="hub-muted">—</span>],
    ["Tags", m.tags.length ? <Mono key="tg">{m.tags.join(", ")}</Mono> : <span className="hub-muted">—</span>],
    ["Embedding", m.embed_model ? <Mono key="e">{m.embed_model}</Mono> : <span className="hub-muted">none yet (backfilled daily)</span>],
  ];
  if (m.deleted_at) rows.push(["Retired", <Full key="d" at={m.deleted_at} />]);
  return (
    <dl className="mem-prov">
      {rows.map(([k, v]) => (
        <div key={k} className="mem-prov__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function LinkItem({ l }: { l: LinkView }) {
  const label = l.other ? `${l.other.namespace}:${l.other.slug}` : l.dangling ? `${l.dangling.namespace ?? "?"}:${l.dangling.slug}` : "unknown";
  return (
    <li className="mem-link">
      <div className="mem-link__target">
        {l.other ? (
          <Link href={`/dashboard/memory?id=${l.other.id}`} className="hub-mono mem-link__slug">
            {l.other.slug}
          </Link>
        ) : (
          <span className="hub-mono mem-link__slug hub-muted" title="Dangling: the target slug has not been written yet">
            {l.dangling?.slug ?? "unknown"}
          </span>
        )}
        <span className="hub-mono hub-muted mem-link__ns">{l.other?.namespace ?? l.dangling?.namespace ?? ""}</span>
        {l.other?.deleted && <Badge variant="status">retired</Badge>}
        {l.other?.confSlug && <Badge variant="status" tone="info">confidential · {l.other.confSlug}</Badge>}
        {!l.other && <Badge variant="status">dangling</Badge>}
      </div>
      <div className="mem-link__meta">
        {l.auto ? (
          <Badge variant="status" tone="info">
            auto{typeof l.score === "number" ? ` · ${l.score.toFixed(2)}` : ""}
          </Badge>
        ) : (
          <Badge variant="status">explicit · {l.createdBy}</Badge>
        )}
        {l.auto && <RemoveLinkButton linkId={l.linkId} label={label} />}
      </div>
    </li>
  );
}

function LinkList({ title, items }: { title: string; items: LinkView[] }) {
  if (!items.length) return null;
  return (
    <div className="mem-linkgroup__side">
      <h4 className="mem-linkgroup__dir">
        {title} <span className="hub-muted">({items.length})</span>
      </h4>
      <ul className="mem-links">
        {items.map((l) => (
          <LinkItem key={l.linkId} l={l} />
        ))}
      </ul>
    </div>
  );
}

export async function DetailView({ id, done }: { id: string; done: string }) {
  const d = await getMemoryDetail(id);
  if (!d) {
    return (
      <>
        <Back />
        <Card>
          <EmptyState title="Memory not found" body="It may have been deleted, or the link is wrong." />
        </Card>
      </>
    );
  }
  const m = d.memory;
  const supersededBy = d.links.find((g) => g.relation === "supersedes")?.in.filter((l) => l.other && !l.other.deleted) ?? [];
  const linkCount = d.links.reduce((n, g) => n + g.in.length + g.out.length, 0);
  const editable = !m.deleted_at && m.namespace !== "shared/inbox";

  return (
    <>
      <Back />
      {done === "edited" && (
        <p className="hub-notice hub-notice--ok" role="status">
          Saved. This is the new version; it supersedes the one you edited.
        </p>
      )}
      {supersededBy.length > 0 && (
        <p className="hub-notice" role="note">
          Superseded by{" "}
          {supersededBy.map((l, i) => (
            <span key={l.linkId}>
              {i > 0 && ", "}
              <Link href={`/dashboard/memory?id=${l.other!.id}`} className="hub-mono">
                {l.other!.slug}
              </Link>
            </span>
          ))}
          . Agents no longer see this version in recall.
        </p>
      )}

      <Card
        title={<span className="hub-mono mem-detail__slug">{m.slug}</span>}
        subtitle={
          <span className="mem-detail__sub">
            <Mono>{m.namespace}</Mono>
            {m.confSlug && <Badge variant="status" tone="info">confidential · {m.confSlug}</Badge>}
          </span>
        }
        actions={
          editable ? (
            <>
              <PinButton id={m.id} pinned={m.pinned} />
              <RetireButton id={m.id} slug={m.slug} />
            </>
          ) : undefined
        }
      >
        <MemoryMarkers m={m} />
        <pre className="mem-content">{m.content}</pre>
        {editable && (
          <details className="mem-editbox">
            <summary className="mem-editbox__summary">Edit content</summary>
            <EditForm id={m.id} initial={m.content} />
          </details>
        )}
        {m.namespace === "shared/inbox" && !m.deleted_at && (
          <p className="hub-hint">
            Inbox items are reviewed on the <Link href="/dashboard/memory?tab=inbox">Inbox tab</Link>.
          </p>
        )}
      </Card>

      <div className="mem-detail-grid">
        <Card title="Provenance" headingLevel={2}>
          <Provenance m={m} />
        </Card>
        <Card title="Linked memories" subtitle={`${linkCount} link${linkCount === 1 ? "" : "s"}`}>
          {d.links.length === 0 ? (
            <EmptyState title="No links" body="Explicit [[slug]] links and automatic similarity links appear here." />
          ) : (
            <div className="mem-linkgroups">
              {d.links.map((g) => (
                <section key={g.relation} className="mem-linkgroup" aria-label={RELATION_LABEL[g.relation] ?? g.relation}>
                  <h3 className="mem-linkgroup__title">{RELATION_LABEL[g.relation] ?? g.relation}</h3>
                  <LinkList title="Outgoing" items={g.out} />
                  <LinkList title="Incoming" items={g.in} />
                </section>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
