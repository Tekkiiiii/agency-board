// Time helpers shared by server and client components. No config import here: callers pass the IANA
// zone (`tz`, from TIMEZONE in lib/config.ts on the server; props on the client). Undefined = the runtime's own zone.

const dayFmts = new Map<string, Intl.DateTimeFormat>();
const fullFmts = new Map<string, Intl.DateTimeFormat>();
const labelFmts = new Map<string, Intl.DateTimeFormat>();
const key = (tz?: string) => tz ?? "";

function dayFmt(tz?: string): Intl.DateTimeFormat {
  let f = dayFmts.get(key(tz));
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric" });
    dayFmts.set(key(tz), f);
  }
  return f;
}
function fullFmt(tz?: string): Intl.DateTimeFormat {
  let f = fullFmts.get(key(tz));
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    fullFmts.set(key(tz), f);
  }
  return f;
}

export function toDate(at: string | number | Date | null | undefined): Date | null {
  if (at === null || at === undefined || at === "") return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Short zone label from Intl for the instant `at`: "UTC", "GMT-5", "BST" ...
export function zoneLabel(tz?: string, at: Date = new Date()): string {
  let f = labelFmts.get(key(tz));
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" });
    labelFmts.set(key(tz), f);
  }
  return f.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? (tz ?? "local time");
}

// "07 Oct 2026"
export function formatDay(at: Date = new Date(), tz?: string): string {
  return dayFmt(tz).format(at);
}

// "07 Oct 2026, 14:03:22 UTC"
export function formatFull(at: Date, tz?: string): string {
  return `${fullFmt(tz).format(at)} ${zoneLabel(tz, at)}`;
}

// "12s ago", "5m ago", "2h ago", "3d ago", "in 4m"; older than 30 days -> day stamp.
export function relative(at: Date, now: Date = new Date(), tz?: string): string {
  const diff = Math.round((now.getTime() - at.getTime()) / 1000);
  const abs = Math.abs(diff);
  let v: string;
  if (abs < 5) return "just now";
  if (abs < 60) v = `${abs}s`;
  else if (abs < 3600) v = `${Math.floor(abs / 60)}m`;
  else if (abs < 86400) v = `${Math.floor(abs / 3600)}h`;
  else if (abs < 30 * 86400) v = `${Math.floor(abs / 86400)}d`;
  else return formatDay(at, tz);
  return diff >= 0 ? `${v} ago` : `in ${v}`;
}
