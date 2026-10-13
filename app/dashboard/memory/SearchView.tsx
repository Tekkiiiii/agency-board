import Link from "next/link";
import { filterOptions, parseFilters, preview, searchMemories, type MemoryRow } from "../../../lib/dash/memory";
import { Badge } from "../_components/Badge";
import { buttonClass } from "../_components/Button";
import { Card } from "../_components/Card";
import { DataTable, type Column } from "../_components/DataTable";
import { EmptyState } from "../_components/EmptyState";
import { Mono } from "../_components/Mono";
import { TimeAgo } from "../_components/TimeAgo";
import { MemoryMarkers } from "./Markers";

type SP = Record<string, string | string[] | undefined>;

export async function SearchView({ sp }: { sp: SP }) {
  const f = parseFilters(sp);
  const [res, opts] = await Promise.all([searchMemories(f), filterOptions()]);
  const filtered = !!(f.q || f.namespace || f.author || f.machine);

  const columns: Column<MemoryRow>[] = [
    {
      key: "memory",
      header: "Memory",
      width: "46%",
      render: (m) => (
        <div className="mem-cell">
          <Link href={`/dashboard/memory?id=${m.id}`} className="mem-slug hub-mono">
            {m.slug}
          </Link>
          <p className="mem-preview">{preview(m.content)}</p>
          <MemoryMarkers m={m} />
        </div>
      ),
    },
    {
      key: "namespace",
      header: "Namespace",
      render: (m) => (
        <div className="mem-stack">
          <Mono>{m.namespace}</Mono>
          {m.confSlug && <Badge variant="status" tone="info">confidential · {m.confSlug}</Badge>}
        </div>
      ),
    },
    {
      key: "author",
      header: "Author",
      hideNarrow: true,
      render: (m) => (
        <Mono>
          {m.author_agent}@{m.author_device ?? "unknown"}
        </Mono>
      ),
    },
    {
      key: "time",
      header: "Created / updated",
      hideNarrow: true,
      render: (m) => (
        <div className="mem-stack mem-times">
          <span>
            <TimeAgo at={m.created_at} />
          </span>
          {m.updated_at && (
            <span className="hub-muted">
              upd. <TimeAgo at={m.updated_at} />
            </span>
          )}
        </div>
      ),
    },
  ];
  if (res.mode === "search") {
    columns.push({
      key: "score",
      header: "Score",
      align: "right",
      mono: true,
      hideNarrow: true,
      render: (m) => (typeof m.score === "number" ? m.score.toFixed(3) : "—"),
    });
  }

  const title = res.mode === "search" ? "Search results" : "Newest memories";
  const subtitle =
    res.mode === "search"
      ? `${res.rows.length} match${res.rows.length === 1 ? "" : "es"} · hybrid ${res.ftsOnly ? "(full-text only: embedding unavailable)" : "vector + full-text"}`
      : `Latest ${res.rows.length} not retired, newest first`;

  return (
    <>
      <form className="mem-search" method="get" action="/dashboard/memory" role="search" aria-label="Search memories">
        <div className="hub-field mem-search__q">
          <label htmlFor="mem-q" className="hub-label">
            Search
          </label>
          <input id="mem-q" name="q" type="search" className="hub-input" defaultValue={f.q} placeholder="What do the agents know about…" maxLength={1000} />
        </div>
        <div className="hub-field">
          <label htmlFor="mem-ns" className="hub-label">
            Namespace
          </label>
          <input
            id="mem-ns"
            name="namespace"
            className="hub-input mem-mono-input"
            defaultValue={f.namespace}
            placeholder="project/name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={res.invalidNamespace || undefined}
            aria-describedby={res.invalidNamespace ? "mem-ns-err" : undefined}
          />
        </div>
        <div className="hub-field">
          <label htmlFor="mem-author" className="hub-label">
            Author
          </label>
          <select id="mem-author" name="author" className="hub-select" defaultValue={f.author}>
            <option value="">Any agent</option>
            {opts.authors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="hub-field">
          <label htmlFor="mem-machine" className="hub-label">
            Machine
          </label>
          <select id="mem-machine" name="machine" className="hub-select" defaultValue={f.machine}>
            <option value="">Any machine</option>
            {opts.machines.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="mem-search__buttons">
          <button type="submit" className={buttonClass("primary", "md")}>
            Search
          </button>
          {filtered && (
            <Link href="/dashboard/memory" className={buttonClass("ghost", "md")}>
              Clear
            </Link>
          )}
        </div>
        {res.invalidNamespace && (
          <p id="mem-ns-err" className="hub-notice hub-notice--danger mem-search__err" role="alert">
            Namespace filter ignored: use lowercase segments like <span className="hub-mono">project/name</span>.
          </p>
        )}
      </form>

      <Card title={title} subtitle={subtitle} flush>
        <DataTable
          caption={title}
          columns={columns}
          rows={res.rows}
          rowKey={(m) => m.id}
          rowClassName={(m) => (m.flags.includes("instruction-like") ? "mem-row--flagged" : undefined)}
          empty={
            <div className="mem-empty-pad">
              <EmptyState
                title={filtered ? "No memories match" : "No memories yet"}
                body={
                  filtered
                    ? "Try a broader query, or clear the namespace and author filters."
                    : <>When an agent calls <Mono>remember</Mono>, the memory shows up here.</>
                }
              />
            </div>
          }
        />
      </Card>
    </>
  );
}
