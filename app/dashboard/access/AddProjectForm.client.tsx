"use client";

import { useId, useState, type FormEvent } from "react";
import { createProjectAction } from "./actions";

const SLUG_PATTERN = "[a-z0-9-]{1,40}";

// Add a confidential project. Server re-validates slug ^[a-z0-9-]{1,40}$ and name 1-80.
export function AddProjectForm() {
  const id = useId();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    let res: Awaited<ReturnType<typeof createProjectAction>>;
    try {
      res = await createProjectAction({ slug, name });
    } catch {
      res = { ok: false, error: "The request failed. Try again." };
    }
    setSaving(false);
    if (res.ok) {
      setResult({ ok: true, text: `Created ${slug}. Nobody has access until you tick a box.` });
      setSlug("");
      setName("");
    } else {
      setResult({ ok: false, text: res.error });
    }
  }

  return (
    <form className="hub-access-add" onSubmit={submit}>
      <div className="hub-field">
        <label htmlFor={`${id}-slug`} className="hub-label">
          Slug
        </label>
        <input
          id={`${id}-slug`}
          className="hub-input hub-mono"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          pattern={SLUG_PATTERN}
          maxLength={40}
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="acme-bank"
          aria-describedby={`${id}-slug-hint`}
        />
        <span id={`${id}-slug-hint`} className="hub-hint">
          a-z, 0-9 and -, up to 40. Cannot be changed later.
        </span>
      </div>
      <div className="hub-field">
        <label htmlFor={`${id}-name`} className="hub-label">
          Name
        </label>
        <input
          id={`${id}-name`}
          className="hub-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          autoComplete="off"
          placeholder="Acme Bank"
        />
        <span className="hub-hint">Display name, 1-80 characters.</span>
      </div>
      <div className="hub-access-add__submit">
        <button type="submit" className="hub-btn hub-btn--primary hub-btn--md" disabled={saving} aria-busy={saving || undefined}>
          {saving ? "Adding…" : "Add confidential project"}
        </button>
      </div>
      <p
        className={`hub-access-add__result${result ? (result.ok ? " hub-access__status--ok" : " hub-access__status--error") : ""}`}
        role="status"
        aria-live="polite"
      >
        {result?.text ?? ""}
      </p>
    </form>
  );
}
