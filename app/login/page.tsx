import type { Metadata } from "next";
import { SubmitButton } from "../dashboard/_components/client/SubmitButton";
import { fontClasses } from "../dashboard/_components/fonts";
import { safeNext } from "../../lib/dash/supabase";
import { requestLink } from "./actions";
import "../dashboard/dashboard.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in · agency-board", robots: { index: false, follow: false } };

const SENT = "If this address is allowed, a sign-in link is on its way.";

const ERRORS: Record<string, { tone: "danger" | "neutral"; text: string }> = {
  denied: { tone: "danger", text: "That account is not allowed to use this dashboard. You have been signed out." },
  link: { tone: "danger", text: "That sign-in link is invalid or has expired. Request a new one." },
  rate: { tone: "danger", text: "Too many attempts. Wait 10 minutes, then try again." },
  invalid: { tone: "danger", text: "Enter a valid email address." },
  error: { tone: "danger", text: "Something went wrong. Try again in a minute." },
  signedout: { tone: "neutral", text: "You are signed out." },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const sent = one("sent") === "1";
  const err = ERRORS[one("e") ?? ""];
  const next = safeNext(one("next"));

  return (
    <div className={`hub-root hub-login ${fontClasses}`}>
      <main className="hub-login__panel">
        <div className="hub-login__brand">
          <span className="hub-brand__name">agency-board</span>
          <span className="hub-brand__sub">Overseer console</span>
        </div>
        <div className="hub-login__card">
          <div>
            <h1 className="hub-login__title">Sign in</h1>
            <p className="hub-login__lede">We email a one-time sign-in link. No password.</p>
          </div>
          {sent && (
            <p className="hub-notice hub-notice--ok" role="status">
              {SENT}
            </p>
          )}
          {!sent && err && (
            <p className={`hub-notice${err.tone === "danger" ? " hub-notice--danger" : ""}`} role={err.tone === "danger" ? "alert" : "status"}>
              {err.text}
            </p>
          )}
          <form action={requestLink} className="hub-login__form">
            <input type="hidden" name="next" value={next} />
            <div className="hub-field">
              <label htmlFor="email" className="hub-label">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                className="hub-input"
                autoComplete="email"
                inputMode="email"
                required
                maxLength={254}
                placeholder="you@example.com"
              />
            </div>
            <SubmitButton variant="primary" pendingLabel="Sending link…">
              Email me a sign-in link
            </SubmitButton>
          </form>
        </div>
        <p className="hub-login__foot">Private dashboard. Agent tokens do not work here.</p>
      </main>
    </div>
  );
}
