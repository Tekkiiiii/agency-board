"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { MatrixModel, MatrixRow } from "../../../lib/dash/access";
import { Badge } from "../_components/Badge";
import { Mono } from "../_components/Mono";
import { renameProjectAction, setGrantAction } from "./actions";

type Status = { text: string; tone: "ok" | "error" | "pending" } | null;
type Prompt = { row: MatrixRow; slug: string; name: string } | null;

function cellKey(row: MatrixRow, slug: string): string {
  return `${row.key}|${slug}`;
}
function propChecked(model: MatrixModel, key: string): boolean | undefined {
  for (const r of model.rows) for (const c of r.cells) if (c.key === key) return c.checked;
  return undefined;
}

// The confidential access matrix. Each checkbox submits immediately (optimistic, rolled back on error);
// one shared aria-live line announces the outcome. Ticking a restricted-agent cell opens a warning dialog first.
export function AccessMatrix({ model, restrictedWarning }: { model: MatrixModel; restrictedWarning: string }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const inFlight = useRef(new Set<string>());
  const modelRef = useRef(model);
  const [status, setStatus] = useState<Status>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();

  // Fresh server data replaces an optimistic value once it agrees (or once the request is settled).
  useEffect(() => {
    modelRef.current = model;
    setOverrides((cur) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(cur)) {
        if (inFlight.current.has(k) && propChecked(model, k) !== v) next[k] = v;
        else changed = true;
      }
      return changed ? next : cur;
    });
  }, [model]);

  async function commit(row: MatrixRow, slug: string, granted: boolean, restrictedAck: boolean) {
    const key = cellKey(row, slug);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setOverrides((o) => ({ ...o, [key]: granted }));
    setStatus({ text: `${granted ? "Granting" : "Removing"} ${slug} ${granted ? "to" : "from"} ${row.ident}…`, tone: "pending" });
    let res: Awaited<ReturnType<typeof setGrantAction>>;
    try {
      res = await setGrantAction({ agent: row.agent, device_id: row.device_id, slug, granted, restricted_ack: restrictedAck || undefined });
    } catch {
      res = { ok: false, error: "The request failed. Check your connection and try again." };
    }
    inFlight.current.delete(key);
    if (res.ok) {
      setStatus({ text: granted ? `Granted ${slug} to ${row.ident}` : `Removed ${slug} from ${row.ident}`, tone: "ok" });
      if (propChecked(modelRef.current, key) === granted) setOverrides(({ [key]: _done, ...rest }) => rest);
    } else {
      // Rollback: drop the optimistic value, the server state shows again.
      setOverrides(({ [key]: _failed, ...rest }) => rest);
      setStatus({ text: `Could not ${granted ? "grant" : "remove"} ${slug} for ${row.ident}: ${res.error}`, tone: "error" });
    }
  }

  function onToggle(row: MatrixRow, slug: string, name: string, next: boolean) {
    if (row.isRestricted && next) {
      setPrompt({ row, slug, name });
      dialogRef.current?.showModal();
      return;
    }
    void commit(row, slug, next, false);
  }

  function closePrompt() {
    dialogRef.current?.close();
  }

  function confirmRestricted(e: FormEvent) {
    e.preventDefault();
    const p = prompt;
    closePrompt();
    if (p) void commit(p.row, p.slug, true, true);
  }

  return (
    <div className="hub-access">
      <div className="hub-table-wrap hub-matrix-wrap">
        <table className="hub-table hub-matrix">
          <caption className="hub-sr-only">
            Confidential project access. One row per identity, one column per confidential project. A ticked box means the identity
            holds a grant for that project.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="hub-matrix__corner">
                Identity
              </th>
              {model.columns.map((c) => (
                <th scope="col" key={c.slug} className="hub-matrix__col">
                  <ColumnHead slug={c.slug} name={c.name} grantCount={c.grantCount} onStatus={setStatus} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.key} className={row.revoked ? "hub-matrix__row--revoked" : undefined}>
                <th scope="row" className="hub-matrix__ident">
                  <span className="hub-matrix__identline">
                    <Mono className="hub-matrix__identname">{row.ident}</Mono>
                    <Badge variant="role">{row.role}</Badge>
                    {row.revoked && (
                      <Badge variant="status" tone="neutral">
                        revoked
                      </Badge>
                    )}
                  </span>
                  {row.isRestricted && <span className="hub-matrix__note">Read cap: assigned projects only</span>}
                </th>
                {row.cells.map((cell) => {
                  const col = model.columns.find((c) => c.slug === cell.slug);
                  const key = cell.key;
                  const checked = key in overrides ? overrides[key] : cell.checked;
                  const busy = inFlight.current.has(key);
                  const label = `${col?.name ?? cell.slug} (${cell.slug}) for ${row.ident}`;
                  return (
                    <td key={key} className="hub-align-center hub-matrix__cell">
                      <input
                        type="checkbox"
                        className="hub-matrix__check"
                        checked={checked}
                        aria-label={label}
                        aria-busy={busy || undefined}
                        disabled={busy}
                        onChange={(e) => onToggle(row, cell.slug, col?.name ?? cell.slug, e.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p
        className={`hub-access__status${status ? ` hub-access__status--${status.tone}` : ""}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status?.text ?? "Changes save as soon as you tick or untick a box."}
      </p>

      <dialog
        ref={dialogRef}
        className="hub-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        onClose={() => setPrompt(null)}
        onClick={(e) => {
          if (e.target === dialogRef.current) closePrompt();
        }}
      >
        <form className="hub-dialog__form" onSubmit={confirmRestricted}>
          <h2 id={`${id}-title`} className="hub-dialog__title">
            {prompt ? (
              <>
                Grant {prompt.name} to <Mono>{prompt.row.ident}</Mono>?
              </>
            ) : (
              "Grant to restricted agent?"
            )}
          </h2>
          <div id={`${id}-desc`} className="hub-dialog__desc">
            <div className="hub-notice hub-warnbox" role="note">
              <p>
                <strong>{restrictedWarning}</strong>
              </p>
              <p>
                Because of the read cap, this grant only takes effect for projects the agent is assigned work in: it can read{" "}
                <Mono>project/{prompt?.slug ?? "<slug>"}/*</Mono> only while a task there is handed to it or claimed by it, and it can
                still only write to <Mono>shared/inbox</Mono>.
              </p>
            </div>
          </div>
          <div className="hub-dialog__actions">
            <button type="button" className="hub-btn hub-btn--secondary hub-btn--md" onClick={closePrompt} autoFocus>
              Cancel
            </button>
            <button type="submit" className="hub-btn hub-btn--primary hub-btn--md">
              Grant to restricted agent
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

// Column header: project name, slug, grant count, inline rename (slug is immutable, §12).
function ColumnHead({
  slug,
  name,
  grantCount,
  onStatus,
}: {
  slug: string;
  name: string;
  grantCount: number;
  onStatus: (s: Status) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const inputId = useId();

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = value.trim();
    if (!next || next === name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    onStatus({ text: `Renaming ${slug}…`, tone: "pending" });
    let res: Awaited<ReturnType<typeof renameProjectAction>>;
    try {
      res = await renameProjectAction({ slug, name: next });
    } catch {
      res = { ok: false, error: "The request failed. Try again." };
    }
    setSaving(false);
    if (res.ok) {
      setEditing(false);
      onStatus({ text: `Renamed ${slug} to ${next}`, tone: "ok" });
    } else {
      onStatus({ text: `Could not rename ${slug}: ${res.error}`, tone: "error" });
    }
  }

  if (editing) {
    return (
      <form className="hub-matrix__rename" onSubmit={save}>
        <label htmlFor={inputId} className="hub-sr-only">
          New name for {slug}
        </label>
        <input
          id={inputId}
          className="hub-input hub-matrix__rename-input"
          value={value}
          maxLength={80}
          required
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setValue(name);
              setEditing(false);
            }
          }}
        />
        <span className="hub-matrix__rename-actions">
          <button type="submit" className="hub-btn hub-btn--secondary hub-btn--sm" disabled={saving} aria-busy={saving || undefined}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="hub-btn hub-btn--ghost hub-btn--sm"
            onClick={() => {
              setValue(name);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </span>
      </form>
    );
  }

  return (
    <div className="hub-matrix__head">
      <span className="hub-matrix__name">{name}</span>
      <span className="hub-matrix__meta">
        <Mono>{slug}</Mono>
        <span aria-hidden="true">·</span>
        <span>{grantCount} granted</span>
      </span>
      <button
        type="button"
        className="hub-linkbtn hub-matrix__renamebtn"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
        aria-label={`Rename ${name} (${slug})`}
      >
        Rename
      </button>
    </div>
  );
}
